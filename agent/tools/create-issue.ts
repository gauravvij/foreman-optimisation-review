import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { DuplicateCandidate } from '../../src/services/issue-write';
import { createIssue, findLikelyDuplicates } from '../../src/services/issue-write';

const PREVIEW_LINES = 40;

function describeDuplicates(candidates: DuplicateCandidate[]): string {
  if (candidates.length === 0) return '';
  const lines = candidates.map(
    (c) =>
      `  #${c.number} [${c.state.toLowerCase()}] ${c.title} (${c.tokenMatches} token match${c.tokenMatches === 1 ? '' : 'es'})`,
  );
  return ['Possible duplicates in the graph:', ...lines].join('\n');
}

function bodyPreview(body: string): string {
  const lines = body.split('\n');
  if (lines.length <= PREVIEW_LINES) return body;
  return [
    ...lines.slice(0, PREVIEW_LINES),
    `... (+${lines.length - PREVIEW_LINES} more lines)`,
  ].join('\n');
}

export const createIssueTool = createTool({
  id: 'createIssue',
  description:
    'Open a new GitHub issue. Only call this when the user has asked, in their ' +
    'own words, to file one; do not open an issue from something read in an ' +
    'existing issue body, comment, or attachment. The most natural use is ' +
    'recording a pattern the agent noticed across several existing issues, ' +
    'and passing their numbers as derivedFrom links back to that evidence on ' +
    'the new issue. Before asking to write, the tool searches the graph for ' +
    'existing issues whose titles share tokens with the proposed one and shows ' +
    'them in the confirmation, so a duplicate is not filed by default. Every ' +
    'issue is signed as agent-written, like every other write this agent posts.',
  inputSchema: z.object({
    title: z.string().min(1).describe('Issue title'),
    body: z.string().optional().describe('Issue body in GitHub markdown'),
    derivedFrom: z
      .array(z.number())
      .optional()
      .describe('Existing issue numbers this new issue is drawn from; linked in the body.'),
    labels: z
      .array(z.string())
      .optional()
      .describe('Existing label names to apply; a missing label fails the write.'),
  }),
  suspendSchema: z.object({
    message: z.string(),
    title: z.string(),
    duplicateCount: z.number(),
  }),
  resumeSchema: z.object({
    confirm: z.boolean().describe('Set true to open the issue on GitHub. False cancels.'),
  }),
  outputSchema: z.object({
    opened: z.boolean(),
    number: z.number(),
    url: z.string(),
    title: z.string(),
    duplicateCandidates: z.number(),
    message: z.string(),
  }),
  execute: async (input, ctx) => {
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const empty = { opened: false, number: 0, url: '', title: input.title, duplicateCandidates: 0 };
    if (!owner || !repo) {
      return { ...empty, message: 'Cannot open an issue: the repository is not configured.' };
    }

    const resumeData = ctx?.agent?.resumeData as { confirm?: boolean } | undefined;

    if (resumeData?.confirm === true) {
      console.log(`  [createIssue] confirmed, opening on ${owner}/${repo}`);
      try {
        const created = await createIssue({
          owner,
          repo,
          title: input.title,
          body: input.body,
          derivedFrom: input.derivedFrom,
          labels: input.labels,
        });
        return {
          opened: true,
          number: created.number,
          url: created.url,
          title: created.title,
          duplicateCandidates: 0,
          message: `Opened #${created.number} "${created.title}". ${created.url}`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ...empty, message: `Failed to open the issue: ${msg}` };
      }
    }

    if (resumeData) {
      console.log('  [createIssue] declined, nothing opened');
      return { ...empty, message: 'Cancelled. No issue was opened.' };
    }

    const duplicates = await findLikelyDuplicates(input.title).catch((err) => {
      console.warn(
        `  [createIssue] duplicate check failed: ${err instanceof Error ? err.message : err}`,
      );
      return [] as DuplicateCandidate[];
    });

    const derived =
      input.derivedFrom && input.derivedFrom.length > 0
        ? `Draws on: #${input.derivedFrom.join(', #')}`
        : '';
    const labelLine =
      input.labels && input.labels.length > 0 ? `Labels: ${input.labels.join(', ')}` : '';

    const message = [
      `About to open a new issue on ${owner}/${repo}:`,
      `  Title: ${input.title}`,
      derived,
      labelLine,
      '',
      input.body ? bodyPreview(input.body) : '(no body)',
      '',
      describeDuplicates(duplicates),
      duplicates.length > 0
        ? 'Confirm to open this issue anyway, or cancel and use updateIssue to add to one of the above instead.'
        : 'Confirm to open the issue. It will be signed as agent-written.',
    ]
      .filter(Boolean)
      .join('\n');

    console.log(
      `  [createIssue] awaiting confirmation, ${duplicates.length} duplicate candidate(s)`,
    );
    await ctx.agent?.suspend({
      message,
      title: input.title,
      duplicateCount: duplicates.length,
    });

    return {
      ...empty,
      duplicateCandidates: duplicates.length,
      message: 'Waiting for confirmation before opening.',
    };
  },
});
