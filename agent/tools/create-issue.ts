import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { uploadAttachment } from '../../src/services/github-attachments';
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
    'own words, to file one. The most natural use is recording a pattern the ' +
    'agent noticed across several existing issues, passing their numbers as ' +
    'derivedFrom to link back to that evidence. Before writing, the tool ' +
    'searches the graph for issues whose titles share tokens with the proposed ' +
    'one and shows them in the confirmation, so a duplicate is not filed by ' +
    'default. The issue is signed as agent-written.',
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
    attachments: z
      .array(
        z.object({
          path: z.string().describe('Absolute path on the shared volume, as the adapter named it'),
          alt: z
            .string()
            .optional()
            .describe('Alt text used in the markdown; falls back to the filename'),
        }),
      )
      .optional()
      .describe(
        'Files to upload to GitHub and embed in the issue body. Use for a ' +
          'screenshot or log the user attached to the current turn. A failed ' +
          'upload fails the write; no issue is opened without every attachment.',
      ),
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

      // Uploads happen before the create so a failed upload cannot leave a
      // partial issue behind. Every failure surfaces the endpoint's response.
      let bodyWithAttachments = input.body ?? '';
      const attachments = input.attachments ?? [];
      for (const att of attachments) {
        try {
          console.log(`  [createIssue] uploading ${att.path}`);
          const uploaded = await uploadAttachment({ owner, repo, path: att.path });
          const alt = (att.alt ?? uploaded.name).replace(/[\r\n]+/g, ' ');
          const isImage = uploaded.contentType.startsWith('image/');
          const link = isImage ? `![${alt}](${uploaded.url})` : `[${alt}](${uploaded.url})`;
          bodyWithAttachments = bodyWithAttachments ? `${bodyWithAttachments}\n\n${link}` : link;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            ...empty,
            message: `Failed to upload ${att.path}, so no issue was opened: ${msg}`,
          };
        }
      }

      try {
        const created = await createIssue({
          owner,
          repo,
          title: input.title,
          body: bodyWithAttachments || undefined,
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
    const attachmentLine =
      input.attachments && input.attachments.length > 0
        ? `Attachments: ${input.attachments.map((a) => a.path).join(', ')}`
        : '';

    const message = [
      `About to open a new issue on ${owner}/${repo}:`,
      `  Title: ${input.title}`,
      derived,
      labelLine,
      attachmentLine,
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
