import { createTool } from '@mastra/core/tools';
import neo4j from 'neo4j-driver';
import { z } from 'zod';
import { textCompletion } from '../../src/services/models';
import { getDriver } from '../../src/services/neo4j';

/**
 * How much of the issue body is handed to the summariser as the anchor. The
 * body is what states the problem; the comments are what people said about it.
 * A long body is truncated because the anchor only has to establish the
 * subject, not reproduce the whole report.
 */
const ISSUE_BODY_ANCHOR_CHARS = 3000;

export const summarizeCommentsTool = createTool({
  id: 'summarizeComments',
  description:
    'Fetch and summarize all comments on a GitHub issue. Returns insights ' +
    'on workflows, competitor mentions, workarounds, proposed solutions, ' +
    'and emotional tone. Optionally pass a userQuery to tailor the summary.',
  inputSchema: z.object({
    issueNumber: z.number().describe('The GitHub issue number'),
    userQuery: z
      .string()
      .optional()
      .describe('Optional — specific angle or follow-up to focus the summary on'),
  }),
  outputSchema: z.object({
    summary: z.string(),
    commentCount: z.number(),
    error: z.string().optional(),
  }),
  execute: async (input) => {
    const session = getDriver().session({
      defaultAccessMode: neo4j.session.READ,
    });

    let issueTitle = '';
    let issueBody = '';
    let comments: { author: string; date: string; text: string }[];
    try {
      console.log(`  [summarizeComments] fetching comments for issue #${input.issueNumber}`);
      // The issue's own title and body are fetched alongside the comments. A
      // comment thread read on its own has no subject: the model sees only the
      // replies and latches onto whichever sub-thread is most concrete. That is
      // how a summary of #5111 ("map and filter not working properly in
      // multiprocessing") came back describing the `copenlu/answerable_tydiqa`
      // repro snippet from one comment instead of the reported bug. The anchor
      // is what keeps the summary about the issue that was asked about.
      const result = await session.run(
        `MATCH (i:Issue {number: $n})
         OPTIONAL MATCH (i)-[:HAS_COMMENT]->(c:Comment)
         OPTIONAL MATCH (c)-[:AUTHORED_BY]->(u:User)
         RETURN i.title AS issueTitle,
                i.bodyText AS issueBody,
                c.bodyText AS text,
                c.createdAt AS date,
                u.login AS author
         ORDER BY c.createdAt ASC`,
        { n: input.issueNumber },
      );

      issueTitle = (result.records[0]?.get('issueTitle') as string) ?? '';
      issueBody = (result.records[0]?.get('issueBody') as string) ?? '';

      comments = result.records
        .filter((r) => r.get('text') !== null && r.get('text') !== undefined)
        .map((r) => ({
          author: (r.get('author') as string) ?? 'unknown',
          date: (r.get('date') as string) ?? '',
          text: (r.get('text') as string) ?? '',
        }));

      console.log(`  [summarizeComments] found ${comments.length} comments`);
    } finally {
      await session.close();
    }

    if (comments.length === 0) {
      return {
        summary: `No comments found for issue #${input.issueNumber}.`,
        commentCount: 0,
      };
    }

    const anchor = issueTitle
      ? `The issue this discussion belongs to is #${input.issueNumber} — "${issueTitle}".\n` +
        (issueBody
          ? `Its body states the problem as:\n${issueBody.slice(0, ISSUE_BODY_ANCHOR_CHARS)}\n\n`
          : '') +
        `Frame the summary around that stated problem. The comments are what people said ` +
        `about it. A comment that drifts onto a different dataset, version, or side question ` +
        `is a detail of the discussion, not the subject of the issue — report it as such ` +
        `rather than restating the issue's problem in those terms.\n\n`
      : '';

    const summaryPrompt = input.userQuery
      ? `Summarize the following GitHub issue comments, focusing on: ${input.userQuery}`
      : `Summarize the following GitHub issue comments. Extract:
- Key workflows or use cases mentioned
- Any competitor tools/services mentioned
- Workarounds users have found
- Proposed solutions
- Overall emotional tone (frustrated, neutral, positive)`;

    const formatted = comments.map((c) => `[${c.author} — ${c.date}]: ${c.text}`).join('\n\n');

    const summary = await textCompletion({
      task: 'summary',
      system: 'You are an expert at summarizing GitHub issue discussions.',
      prompt: `${anchor}${summaryPrompt}\n\nComments (${comments.length} total):\n${formatted}`,
    });

    console.log(`  [summarizeComments] summarised ${comments.length} comments`);

    return {
      summary: summary ?? 'Unable to generate summary.',
      commentCount: comments.length,
    };
  },
});
