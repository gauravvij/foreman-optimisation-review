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

/**
 * How many comments are read out of the graph in one go.
 *
 * The query used to have no LIMIT at all: every comment body on the issue went
 * into a single completion. The bench corpus tops out at 20 comments per issue
 * so it never bit there, but a real issue with 500 comments would blow the
 * context window and the budget in one call. 200 is far above any thread a
 * summary is useful for and far below any model's context limit.
 */
const DEFAULT_COMMENT_LIMIT = 200;

/**
 * Ceiling on the characters of comment text placed in the prompt. Roughly
 * 10k tokens of comments, which leaves room for the anchor, the instructions
 * and the answer inside a 128k context while keeping one pathological thread
 * from dominating the cost of a whole ingestion run.
 */
const DEFAULT_PROMPT_CHAR_CAP = 40_000;

/** Share of the comment budget given to the earliest comments. */
const HEAD_SHARE = 0.25;

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

/** Comments read from the graph per call. Override with SUMMARIZE_COMMENT_LIMIT. */
export function commentLimit(): number {
  return positiveIntFromEnv('SUMMARIZE_COMMENT_LIMIT', DEFAULT_COMMENT_LIMIT);
}

/** Character ceiling for the comment block. Override with SUMMARIZE_PROMPT_CHAR_CAP. */
export function promptCharCap(): number {
  return positiveIntFromEnv('SUMMARIZE_PROMPT_CHAR_CAP', DEFAULT_PROMPT_CHAR_CAP);
}

type Comment = { author: string; date: string; text: string };

const formatComment = (c: Comment) => `[${c.author} — ${c.date}]: ${c.text}`;

/**
 * Fit the comments into `budget` characters, keeping the earliest few for
 * context and the newest ones in full.
 *
 * The newest comments are what a summary is usually asked about — the current
 * state of the discussion — so they get the larger share of the budget and are
 * never dropped entirely. The earliest comments establish what the thread was
 * originally about, so a slice of them is kept too. Whatever falls out of the
 * middle is replaced by a marker that says how much was dropped, so the model
 * knows it is reading an excerpt rather than the whole thread.
 */
export function fitComments(
  comments: Comment[],
  budget: number,
): { text: string; omitted: number } {
  const parts = comments.map(formatComment);
  const joined = parts.join('\n\n');
  if (joined.length <= budget) return { text: joined, omitted: 0 };

  // The marker is part of the returned text, so its length has to come out of
  // the budget rather than being added on top of it — otherwise a truncated
  // thread overshoots the cap by exactly the marker's length. Reserve the
  // widest marker this thread could produce (every comment omitted).
  const markerFor = (n: number) =>
    `[... ${n} comment${n === 1 ? '' : 's'} omitted to stay within the ` +
    `prompt budget; the newest comments are kept in full ...]`;
  const reserve = markerFor(comments.length).length + 4;
  const available = Math.max(budget - reserve, 0);

  const headBudget = Math.floor(available * HEAD_SHARE);
  const tailBudget = available - headBudget;

  const head: string[] = [];
  let headLen = 0;
  for (const part of parts) {
    if (headLen + part.length + 2 > headBudget) break;
    head.push(part);
    headLen += part.length + 2;
  }

  const tail: string[] = [];
  let tailLen = 0;
  for (let i = parts.length - 1; i >= head.length; i--) {
    const part = parts[i];
    if (tailLen + part.length + 2 > tailBudget) break;
    tail.unshift(part);
    tailLen += part.length + 2;
  }

  // The newest comment is the one a summary is most often about, so it is kept
  // even when it alone exceeds the tail budget — clipped, not dropped.
  if (tail.length === 0 && parts.length > head.length) {
    const newest = parts[parts.length - 1];
    tail.push(newest.length > tailBudget ? `${newest.slice(0, Math.max(tailBudget - 1, 0))}…` : newest);
  }

  const omitted = comments.length - head.length - tail.length;
  const marker = markerFor(omitted);

  return { text: [...head, marker, ...tail].join('\n\n'), omitted };
}

export const summarizeCommentsTool = createTool({
  id: 'summarizeComments',
  description:
    'Fetch and summarize all comments on a GitHub issue. Returns insights ' +
    'on workflows, competitor mentions, workarounds, proposed solutions, ' +
    'and emotional tone. Optionally pass a userQuery to tailor the summary. ' +
    'Long threads are bounded: at most SUMMARIZE_COMMENT_LIMIT comments ' +
    '(default 200) are read, and the prompt is capped at ' +
    'SUMMARIZE_PROMPT_CHAR_CAP characters (default 40000) by keeping the ' +
    'earliest comments for context and the newest ones in full. When either ' +
    'bound bites, the result carries truncated: true — say the summary covers ' +
    'an excerpt rather than the whole thread.',
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
    truncated: z.boolean().optional(),
    error: z.string().optional(),
  }),
  execute: async (input) => {
    const session = getDriver().session({
      defaultAccessMode: neo4j.session.READ,
    });

    const limit = commentLimit();
    let issueTitle = '';
    let issueBody = '';
    let comments: Comment[];
    try {
      console.log(`  [summarizeComments] fetching comments for issue #${input.issueNumber}`);
      // The issue's own title and body are fetched alongside the comments. A
      // comment thread read on its own has no subject: the model sees only the
      // replies and latches onto whichever sub-thread is most concrete. That is
      // how a summary of #5111 ("map and filter not working properly in
      // multiprocessing") came back describing the `copenlu/answerable_tydiqa`
      // repro snippet from one comment instead of the reported bug. The anchor
      // is what keeps the summary about the issue that was asked about.
      //
      // The rows are ordered newest-first so LIMIT keeps the most recent
      // comments rather than the oldest, then reversed below to restore the
      // chronological order the prompt expects.
      const result = await session.run(
        `MATCH (i:Issue {number: $n})
         OPTIONAL MATCH (i)-[:HAS_COMMENT]->(c:Comment)
         OPTIONAL MATCH (c)-[:AUTHORED_BY]->(u:User)
         RETURN i.title AS issueTitle,
                i.bodyText AS issueBody,
                c.bodyText AS text,
                c.createdAt AS date,
                u.login AS author
         ORDER BY c.createdAt DESC
         LIMIT $limit`,
        { n: input.issueNumber, limit: neo4j.int(limit) },
      );

      issueTitle = (result.records[0]?.get('issueTitle') as string) ?? '';
      issueBody = (result.records[0]?.get('issueBody') as string) ?? '';

      comments = result.records
        .filter((r) => r.get('text') !== null && r.get('text') !== undefined)
        .map((r) => ({
          author: (r.get('author') as string) ?? 'unknown',
          date: (r.get('date') as string) ?? '',
          text: (r.get('text') as string) ?? '',
        }))
        .reverse();

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

    const header = `${anchor}${summaryPrompt}\n\nComments (${comments.length} total):\n`;
    const budget = Math.max(promptCharCap() - header.length, 0);
    const { text: formatted, omitted } = fitComments(comments, budget);

    // Two independent reasons the summary may not cover the whole thread: the
    // Cypher LIMIT clipped the read, or the prompt cap dropped comments.
    const hitLimit = comments.length >= limit;
    const truncated = omitted > 0 || hitLimit;

    const summary = await textCompletion({
      task: 'summary',
      system: 'You are an expert at summarizing GitHub issue discussions.',
      prompt: `${header}${formatted}`,
    });

    console.log(
      `  [summarizeComments] summarised ${comments.length} comments` +
        (truncated ? ` (truncated: ${omitted} omitted, limit ${limit})` : ''),
    );

    return {
      summary: summary ?? 'Unable to generate summary.',
      commentCount: comments.length,
      ...(truncated ? { truncated: true } : {}),
    };
  },
});
