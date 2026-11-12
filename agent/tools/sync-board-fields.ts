import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { FieldChange, FieldSyncResult } from '../../src/services/github-project';
import { FIELD_KEYS, listProjectBoards, syncFields } from '../../src/services/github-project';
import { estimateDuration } from '../../src/services/progress';

const PREVIEW_LINES = 20;

const CHANGE = z.object({
  issueNumber: z.number(),
  field: z.enum(FIELD_KEYS),
  fieldName: z.string(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  addToBoard: z.boolean(),
});

const FIELDS_INPUT = z
  .array(z.enum(FIELD_KEYS))
  .optional()
  .describe('Which fields to sync. Omit for every field the board supports.');

const PROJECT_INPUT = z
  .number()
  .optional()
  .describe('Which project board to target, e.g. 2. Omit only when the repo has one.');

function describe(planned: FieldChange[]): string {
  const lines = planned.slice(0, PREVIEW_LINES).map((c) => {
    const note = c.addToBoard ? ' [adds to board]' : '';
    return `#${c.issueNumber} ${c.fieldName}: ${c.from ?? '(unset)'} -> ${c.to ?? '(unset)'}${note}`;
  });
  if (planned.length > PREVIEW_LINES) {
    lines.push(`...and ${planned.length - PREVIEW_LINES} more changes`);
  }
  return lines.join('\n');
}

/**
 * A change over a value someone already chose, as opposed to filling a blank.
 *
 * Rank comes from the board's own option order, not the option names, so a
 * field using words rather than letters or numbers still ranks correctly.
 */
export function countOverwrites(
  planned: FieldChange[],
  optionOrder: Record<string, string[]>,
): { total: number; downgrades: number } {
  const held = planned.filter((c) => c.from !== null);
  const isDowngrade = (c: FieldChange) => {
    const order = optionOrder[c.field] ?? [];
    const from = order.indexOf(c.from ?? '');
    const to = c.to === null ? -1 : order.indexOf(c.to);
    return from !== -1 && to !== -1 && to > from;
  };
  return { total: held.length, downgrades: held.filter(isDowngrade).length };
}

function summarise(r: FieldSyncResult): string {
  const issues = new Set(r.planned.map((c) => c.issueNumber)).size;
  const adds = new Set(r.planned.filter((c) => c.addToBoard).map((c) => c.issueNumber)).size;
  const clears = r.planned.filter((c) => c.to === null).length;
  const parts = [
    `${r.planned.length} change(s) across ${issues} issue(s) on board #${r.projectNumber} "${r.projectTitle}"`,
  ];
  if (adds > 0) parts.push(`${adds} issue(s) would be added to the board first`);
  if (clears > 0) parts.push(`${clears} field(s) would be cleared`);
  return `${parts.join('; ')}.`;
}

/** Overwriting a value a person chose is the consequential half of this sync. */
function overwriteNote(r: FieldSyncResult): string {
  const { total, downgrades } = countOverwrites(r.planned, r.optionOrder);
  if (total === 0) return '';
  const tail = downgrades > 0 ? `, ${downgrades} of them a lower value than it holds now` : '';
  return `${total} of these replace a value already set on the board${tail}. The rest fill an empty field.`;
}

/** Work that landed without the issue being closed is worth naming, not just filing. */
function shippedNote(r: FieldSyncResult): string {
  if (r.shippedButOpen.length === 0) return '';
  return `${r.shippedButOpen.length} of these have a merged pull request but are still open, so they may be finished: ${r.shippedButOpen.map((n) => `#${n}`).join(', ')}.`;
}

/** Values with no matching option are left unset, which is worth saying out loud. */
function unmappedNote(r: FieldSyncResult): string {
  if (r.unmapped.length === 0) return '';
  const each = r.unmapped.map((u) => `${u.field} has no option for ${u.values.join(', ')}`);
  return `${each.join('; ')}, so those issues are left unset.`;
}

export const previewBoardSyncTool = createTool({
  id: 'previewBoardSync',
  description:
    'Show which project board fields would change if the derived priority and ' +
    'size were pushed to GitHub, including the issues that would be added to ' +
    'the board first and the fields that would be cleared. Read-only: this ' +
    'never writes. Priority and size live in the board fields, not in labels.',
  inputSchema: z.object({
    limit: z.number().default(25).describe('Max changes to list back'),
    issueNumbers: z.array(z.number()).optional().describe('Restrict to specific issue numbers'),
    fields: FIELDS_INPUT,
    projectNumber: PROJECT_INPUT,
  }),
  outputSchema: z.object({
    changesPlanned: z.number(),
    issuesAffected: z.number(),
    changes: z.array(CHANGE),
    unmapped: z.array(z.object({ field: z.string(), values: z.array(z.string()) })),
    shippedButOpen: z.array(z.number()),
    overwrites: z.number(),
    downgrades: z.number(),
    projectNumber: z.number(),
    projectTitle: z.string(),
    fieldNames: z.array(z.string()),
    truncated: z.boolean(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (input) => {
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const empty = {
      changesPlanned: 0,
      issuesAffected: 0,
      changes: [],
      unmapped: [],
      shippedButOpen: [],
      overwrites: 0,
      downgrades: 0,
      projectNumber: 0,
      projectTitle: '',
      fieldNames: [],
      truncated: false,
    };

    if (!owner || !repo) {
      return {
        ...empty,
        message: 'Cannot plan the sync: the repository is not configured.',
        error: 'GITHUB_OWNER and GITHUB_REPO are not set',
      };
    }

    try {
      console.log(`  [previewBoardSync] planning against ${owner}/${repo}`);
      const result = await syncFields({
        owner,
        repo,
        dryRun: true,
        issueNumbers: input.issueNumbers,
        projectNumber: input.projectNumber,
        fields: input.fields,
      });

      const counts = countOverwrites(result.planned, result.optionOrder);

      return {
        changesPlanned: result.planned.length,
        issuesAffected: new Set(result.planned.map((c) => c.issueNumber)).size,
        changes: result.planned.slice(0, input.limit),
        unmapped: result.unmapped,
        shippedButOpen: result.shippedButOpen,
        overwrites: counts.total,
        downgrades: counts.downgrades,
        projectNumber: result.projectNumber,
        projectTitle: result.projectTitle,
        fieldNames: result.fieldNames,
        truncated: result.planned.length > input.limit,
        message:
          result.planned.length === 0
            ? `Board #${result.projectNumber} "${result.projectTitle}" already matches the graph. Nothing to do.`
            : [
                summarise(result),
                overwriteNote(result),
                shippedNote(result),
                unmappedNote(result),
                ...result.errors,
              ]
                .filter(Boolean)
                .join(' '),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [previewBoardSync] error: ${msg}`);
      return { ...empty, message: 'Could not plan the sync.', error: msg };
    }
  },
});

export const applyBoardSyncTool = createTool({
  id: 'applyBoardSync',
  description:
    'Push the derived priority and size to the GitHub project board fields. ' +
    'Adds an issue to the board when it is not already on it, and clears a ' +
    'field whose derived value the board has no option for. Always shows the ' +
    'full diff and waits for explicit user confirmation before writing ' +
    'anything. Only open issues are touched.\n\n' +
    'Rules:\n' +
    '- This tool and previewBoardSync refuse to guess which board to write to ' +
    'when the repository has more than one. Do not pick one: run ' +
    'listProjectBoards and ask the user which board they mean.\n' +
    '- The status column is derived from issue facts, so this tool cannot reach ' +
    'a column that stands for a decision rather than a fact. Putting work on ' +
    'hold is the example: when the user asks for a specific column, use ' +
    'setBoardColumn rather than offering to sync and let them drag the card ' +
    'afterwards. Do not record an Assessment in place of the move, because ' +
    'nothing reads a decision or a note when deriving the column.\n' +
    '- The derived status column comes from facts, not from judgment: closed is ' +
    'Done, a pull request that is ready or already merged is In review, a draft ' +
    'pull request or an assignee is In progress, and a P0 or P1 that is ' +
    'actionable is Ready. Individual pull request details (reviewDecision, ' +
    'checksState, draft flag) are not in the graph, so use readPullRequests or ' +
    'inspectPullRequest to answer why a card sits where it does.',
  inputSchema: z.object({
    limit: z
      .number()
      .optional()
      .describe('Apply at most this many changes. Omit for the whole plan.'),
    issueNumbers: z.array(z.number()).optional().describe('Restrict to specific issue numbers'),
    fields: FIELDS_INPUT,
    projectNumber: PROJECT_INPUT,
  }),
  suspendSchema: z.object({
    message: z.string(),
    changesPlanned: z.number(),
    issuesAdded: z.number(),
    fieldsCleared: z.number(),
    overwrites: z.number(),
    projectNumber: z.number(),
    projectTitle: z.string(),
  }),
  resumeSchema: z.object({
    confirm: z.boolean().describe('Set true to write these values to the board. False cancels.'),
  }),
  outputSchema: z.object({
    applied: z.number(),
    added: z.number(),
    cleared: z.number(),
    changesPlanned: z.number(),
    confirmed: z.boolean(),
    errors: z.array(z.string()),
    message: z.string(),
  }),
  execute: async (input, ctx) => {
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const empty = { applied: 0, added: 0, cleared: 0, changesPlanned: 0, confirmed: false };

    if (!owner || !repo) {
      return {
        ...empty,
        errors: ['GITHUB_OWNER and GITHUB_REPO are not set'],
        message: 'Cannot sync the board: the repository is not configured.',
      };
    }

    const resumeData = ctx?.agent?.resumeData as { confirm?: boolean } | undefined;

    if (resumeData?.confirm === true) {
      // Re-plan rather than trusting the pre-suspension diff, so a stale
      // confirmation cannot apply changes the graph no longer supports.
      console.log('  [applyBoardSync] confirmed, applying');
      const result = await syncFields({ owner, repo, dryRun: false, ...input });
      const detail = [
        result.added > 0 ? `${result.added} added to the board` : '',
        result.cleared > 0 ? `${result.cleared} cleared` : '',
      ]
        .filter(Boolean)
        .join(', ');
      return {
        applied: result.applied,
        added: result.added,
        cleared: result.cleared,
        changesPlanned: result.planned.length,
        confirmed: true,
        errors: result.errors,
        message: [
          `Applied ${result.applied} change(s) to board #${result.projectNumber} "${result.projectTitle}"${detail ? ` (${detail})` : ''}.`,
          shippedNote(result),
          unmappedNote(result),
          ...result.errors,
        ]
          .filter(Boolean)
          .join(' '),
      };
    }

    if (resumeData) {
      console.log('  [applyBoardSync] declined, nothing written');
      return { ...empty, errors: [], message: 'Cancelled. Nothing was written to the board.' };
    }

    let preview: FieldSyncResult;
    try {
      preview = await syncFields({ owner, repo, dryRun: true, ...input });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [applyBoardSync] planning failed: ${msg}`);
      return { ...empty, errors: [msg], message: 'Cannot plan the sync, so nothing was written.' };
    }

    if (preview.planned.length === 0) {
      return {
        ...empty,
        errors: preview.errors,
        message: `Board #${preview.projectNumber} "${preview.projectTitle}" already matches the graph. Nothing to do.`,
      };
    }

    const added = new Set(preview.planned.filter((c) => c.addToBoard).map((c) => c.issueNumber))
      .size;
    const cleared = preview.planned.filter((c) => c.to === null).length;
    const counts = countOverwrites(preview.planned, preview.optionOrder);

    console.log(
      `  [applyBoardSync] suspending for confirmation, ${preview.planned.length} changes`,
    );

    const chunkNote =
      preview.remaining > 0
        ? `This is a chunk. ${preview.remaining} more changes still differ; run the tool again after this to continue.`
        : '';

    await ctx.agent?.suspend({
      message: [
        `About to change ${preview.fieldNames.join(' and ')} on board #${preview.projectNumber} "${preview.projectTitle}". GitHub is written about once a second, so this takes ${estimateDuration(preview.planned.length + added)}.`,
        describe(preview.planned),
        added > 0 ? `${added} issue(s) are not on the board yet and will be added.` : '',
        overwriteNote(preview),
        shippedNote(preview),
        unmappedNote(preview),
        preview.errors.join(' '),
        chunkNote,
        'Confirm to write these changes to the board.',
      ]
        .filter(Boolean)
        .join('\n\n'),
      changesPlanned: preview.planned.length,
      issuesAdded: added,
      fieldsCleared: cleared,
      overwrites: counts.total,
      projectNumber: preview.projectNumber,
      projectTitle: preview.projectTitle,
    });

    return {
      ...empty,
      changesPlanned: preview.planned.length,
      errors: [],
      message: 'Waiting for confirmation before writing to the board.',
    };
  },
});

export const listProjectBoardsTool = createTool({
  id: 'listProjectBoards',
  description:
    'List the GitHub project boards linked to the repository, with the managed ' +
    'fields each one carries and the options those fields offer. Read-only. ' +
    'Use it to pick which board to sync to, or when a sync reports that the ' +
    'target is ambiguous.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    boards: z.array(
      z.object({
        number: z.number(),
        title: z.string(),
        items: z.number(),
        fields: z.array(z.object({ name: z.string(), options: z.array(z.string()) })),
      }),
    ),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async () => {
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    if (!owner || !repo) {
      return {
        boards: [],
        message: 'Cannot list boards: the repository is not configured.',
        error: 'GITHUB_OWNER and GITHUB_REPO are not set',
      };
    }

    try {
      const boards = await listProjectBoards(owner, repo);
      const usable = boards.filter((b) => b.fields.some((f) => f.options.length > 0));
      return {
        boards,
        message:
          boards.length === 0
            ? `No project boards are linked to ${owner}/${repo}.`
            : `${boards.length} board(s) on ${owner}/${repo}; ${usable.length} carry a usable managed field.`,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { boards: [], message: 'Could not list the boards.', error: msg };
    }
  },
});
