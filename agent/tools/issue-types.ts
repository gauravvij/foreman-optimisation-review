import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { TypeSyncResult } from '../../src/services/issue-type';
import { backfillIssueTypes, syncIssueTypes } from '../../src/services/issue-type';
import { estimateDuration } from '../../src/services/progress';

const PREVIEW_LINES = 20;

export const classifyIssueTypesTool = createTool({
  id: 'classifyIssueTypes',
  description:
    'Work out whether each issue is a bug, a feature, or a task, and whether ' +
    'it can be acted on as written. Fills only issues that have no kind yet, ' +
    'so it is safe to re-run as new issues arrive. Writes to the graph, not to ' +
    'GitHub. One model call per issue, so use the limit to work in batches.',
  inputSchema: z.object({
    classify: z
      .boolean()
      .default(false)
      .describe('False reports how many are unclassified; true spends the model calls'),
    limit: z.number().default(25).describe('Classify at most this many in one run'),
    issueNumbers: z.array(z.number()).optional().describe('Restrict to specific issue numbers'),
  }),
  outputSchema: z.object({
    untyped: z.number(),
    classified: z.array(
      z.object({
        number: z.number(),
        issueType: z.string(),
        needsClarification: z.boolean(),
      }),
    ),
    remaining: z.number(),
    errors: z.array(z.string()),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (input) => {
    try {
      console.log(`  [classifyIssueTypes] classify=${input.classify} limit=${input.limit}`);
      const r = await backfillIssueTypes({
        dryRun: !input.classify,
        limit: input.limit,
        issueNumbers: input.issueNumbers,
      });

      const unclear = r.classified.filter((c) => c.needsClarification).length;
      const message =
        r.missing.length === 0
          ? 'Every open issue already has a kind. Nothing to classify.'
          : r.dryRun
            ? `${r.missing.length} open issue(s) have no kind yet. Re-run with classify to work through them.`
            : [
                `Classified ${r.classified.length} issue(s).`,
                unclear > 0 ? `${unclear} need clarification before they can be picked up.` : '',
                r.remaining > 0 ? `${r.remaining} still unclassified; run again to continue.` : '',
              ]
                .filter(Boolean)
                .join(' ');

      return {
        untyped: r.missing.length,
        classified: r.classified,
        remaining: r.remaining,
        errors: r.errors,
        message,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [classifyIssueTypes] error: ${msg}`);
      return {
        untyped: 0,
        classified: [],
        remaining: 0,
        errors: [],
        message: 'Could not classify issue kinds.',
        error: msg,
      };
    }
  },
});

function describe(r: TypeSyncResult): string {
  const lines = r.planned
    .slice(0, PREVIEW_LINES)
    .map((c) => `#${c.issueNumber} ${c.from ?? '(none)'} -> ${c.to}`);
  if (r.planned.length > PREVIEW_LINES) {
    lines.push(`...and ${r.planned.length - PREVIEW_LINES} more issues`);
  }
  return lines.join('\n');
}

/** Replacing a kind a person chose is the consequential half of this write. */
function overwriteNote(r: TypeSyncResult): string {
  const replaced = r.planned.filter((c) => c.from !== null).length;
  const parts = [];
  if (replaced > 0) parts.push(`${replaced} of these replace a kind already set on the issue.`);
  if (r.keptExisting > 0) {
    parts.push(
      `${r.keptExisting} issue(s) already have a kind and are left alone; pass overwrite to change them too.`,
    );
  }
  return parts.join(' ');
}

export const applyIssueTypeSyncTool = createTool({
  id: 'applyIssueTypeSync',
  description:
    "Set GitHub's own issue type (bug, feature, task) from the classified kind. " +
    'This writes to the issues themselves, not to a project board. Leaves a ' +
    'type someone already set alone unless overwrite is passed. Always shows ' +
    'the full diff and waits for explicit user confirmation before writing.\n\n' +
    'Rules:\n' +
    '- Never pass overwrite unless the user asks for it. The default leaves a ' +
    'type a person already chose alone.',
  inputSchema: z.object({
    limit: z
      .number()
      .optional()
      .describe('Apply at most this many issues. Omit for the whole plan.'),
    issueNumbers: z.array(z.number()).optional().describe('Restrict to specific issue numbers'),
    overwrite: z.boolean().default(false).describe('Also replace a type already set on the issue'),
  }),
  suspendSchema: z.object({
    message: z.string(),
    issuesChanged: z.number(),
    replacing: z.number(),
  }),
  resumeSchema: z.object({
    confirm: z.boolean().describe('Set true to write these types to GitHub. False cancels.'),
  }),
  outputSchema: z.object({
    applied: z.number(),
    issuesChanged: z.number(),
    keptExisting: z.number(),
    confirmed: z.boolean(),
    errors: z.array(z.string()),
    message: z.string(),
  }),
  execute: async (input, ctx) => {
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const empty = { applied: 0, issuesChanged: 0, keptExisting: 0, confirmed: false };

    if (!owner || !repo) {
      return {
        ...empty,
        errors: ['GITHUB_OWNER and GITHUB_REPO are not set'],
        message: 'Cannot set issue types: the repository is not configured.',
      };
    }

    const resumeData = ctx?.agent?.resumeData as { confirm?: boolean } | undefined;

    if (resumeData?.confirm === true) {
      // Re-plan rather than trusting the pre-suspension diff, so a stale
      // confirmation cannot apply changes the graph no longer supports.
      console.log('  [applyIssueTypeSync] confirmed, applying');
      const r = await syncIssueTypes({ owner, repo, dryRun: false, ...input });
      return {
        applied: r.applied,
        issuesChanged: r.planned.length,
        keptExisting: r.keptExisting,
        confirmed: true,
        errors: r.errors,
        message: `Set the issue type on ${r.applied} issue(s) in ${owner}/${repo}.`,
      };
    }

    if (resumeData) {
      console.log('  [applyIssueTypeSync] declined, nothing written');
      return { ...empty, errors: [], message: 'Cancelled. No issue types were written.' };
    }

    let preview: TypeSyncResult;
    try {
      preview = await syncIssueTypes({ owner, repo, dryRun: true, ...input });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [applyIssueTypeSync] planning failed: ${msg}`);
      return { ...empty, errors: [msg], message: 'Cannot plan the write, so nothing was sent.' };
    }

    const unmappedNote =
      preview.unmapped.length > 0
        ? `${owner}/${repo} has no issue type for ${preview.unmapped.join(', ')} (it offers ${preview.repoTypes.join(', ')}), so those issues are skipped.`
        : '';

    if (preview.planned.length === 0) {
      return {
        ...empty,
        keptExisting: preview.keptExisting,
        errors: preview.errors,
        message: [
          `Issue types in ${owner}/${repo} already match the graph. Nothing to do.`,
          overwriteNote(preview),
          unmappedNote,
        ]
          .filter(Boolean)
          .join(' '),
      };
    }

    const replacing = preview.planned.filter((c) => c.from !== null).length;
    console.log(`  [applyIssueTypeSync] suspending for confirmation, ${preview.planned.length}`);

    const chunkNote =
      preview.remaining > 0
        ? `This is a chunk. ${preview.remaining} more issues still differ; run the tool again after this to continue.`
        : '';

    await ctx.agent?.suspend({
      message: [
        `About to set the issue type on ${preview.planned.length} issue(s) in ${owner}/${repo}. This writes to the issues themselves, not to a project board, and takes ${estimateDuration(preview.planned.length)}.`,
        describe(preview),
        overwriteNote(preview),
        unmappedNote,
        chunkNote,
        'Confirm to write these types to GitHub.',
      ]
        .filter(Boolean)
        .join('\n\n'),
      issuesChanged: preview.planned.length,
      replacing,
    });

    return {
      ...empty,
      issuesChanged: preview.planned.length,
      keptExisting: preview.keptExisting,
      errors: [],
      message: 'Waiting for confirmation before writing to GitHub.',
    };
  },
});
