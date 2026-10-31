import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { SetColumnResult } from '../../src/services/github-project';
import { setBoardColumn } from '../../src/services/github-project';
import { estimateDuration } from '../../src/services/progress';

const PREVIEW_LINES = 20;

function describe(result: SetColumnResult): string {
  const lines = result.moved
    .slice(0, PREVIEW_LINES)
    .map((m) => `  #${m.issueNumber}: ${m.from ?? '(none)'} -> ${result.column}`);
  if (result.moved.length > PREVIEW_LINES) {
    lines.push(`  ...and ${result.moved.length - PREVIEW_LINES} more`);
  }
  return lines.join('\n');
}

function optionsNote(result: SetColumnResult): string {
  return result.options.length > 0 ? ` Available: ${result.options.join(', ')}.` : '';
}

export const setBoardColumnTool = createTool({
  id: 'setBoardColumn',
  description:
    'Move cards to a named column on the GitHub project board, because someone ' +
    'asked for it rather than because the issue facts imply it. Use this for a ' +
    'column the sync cannot derive, such as putting work on hold. Writes the ' +
    'column given and no other field, so priority and size keep the values ' +
    'triage gave them, and ignores the forward-only rule that stops a derived ' +
    'sync moving a card backwards. Adds an issue to the board when it is not ' +
    'on it. Shows the diff and waits for confirmation. Prefer applyBoardSync ' +
    'when the column follows from the issue facts.',
  inputSchema: z.object({
    issueNumbers: z.array(z.number()).min(1).describe('The issues whose cards move'),
    column: z.string().describe('The column name exactly as the board spells it, e.g. "On hold"'),
    projectNumber: z
      .number()
      .optional()
      .describe('Which project board to target, e.g. 2. Omit only when the repo has one.'),
  }),
  suspendSchema: z.object({
    message: z.string(),
    column: z.string(),
    moving: z.number(),
    addingToBoard: z.number(),
    projectNumber: z.number(),
    projectTitle: z.string(),
  }),
  resumeSchema: z.object({
    confirm: z.boolean().describe('Set true to move these cards. False cancels.'),
  }),
  outputSchema: z.object({
    moved: z.number(),
    unchanged: z.number(),
    addedToBoard: z.number(),
    confirmed: z.boolean(),
    errors: z.array(z.string()),
    message: z.string(),
  }),
  execute: async (input, ctx) => {
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const empty = { moved: 0, unchanged: 0, addedToBoard: 0, confirmed: false };

    if (!owner || !repo) {
      return {
        ...empty,
        errors: ['GITHUB_OWNER and GITHUB_REPO are not set'],
        message: 'Cannot move the cards: the repository is not configured.',
      };
    }

    const resumeData = ctx?.agent?.resumeData as { confirm?: boolean } | undefined;

    if (resumeData?.confirm === true) {
      console.log(`  [setBoardColumn] confirmed, moving to ${input.column}`);
      const result = await setBoardColumn({ owner, repo, dryRun: false, ...input });
      const added =
        result.addedToBoard.length > 0 ? ` ${result.addedToBoard.length} added to the board.` : '';
      return {
        moved: result.moved.length,
        unchanged: result.unchanged.length,
        addedToBoard: result.addedToBoard.length,
        confirmed: true,
        errors: result.errors,
        message: [
          `Moved ${result.moved.length} card(s) to "${result.column}" on board #${result.projectNumber} "${result.projectTitle}".${added}`,
          ...result.errors,
        ]
          .filter(Boolean)
          .join(' '),
      };
    }

    if (resumeData) {
      console.log('  [setBoardColumn] declined, nothing written');
      return { ...empty, errors: [], message: 'Cancelled. Nothing was written to the board.' };
    }

    let preview: SetColumnResult;
    try {
      preview = await setBoardColumn({ owner, repo, dryRun: true, ...input });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [setBoardColumn] planning failed: ${msg}`);
      return { ...empty, errors: [msg], message: 'Cannot plan the move, so nothing was written.' };
    }

    // A column the board does not have is the likely mistake, so the reply
    // names the ones it does rather than only reporting the failure.
    if (preview.errors.length > 0 && preview.moved.length === 0) {
      return {
        ...empty,
        unchanged: preview.unchanged.length,
        errors: preview.errors,
        message: `${preview.errors.join(' ')}${optionsNote(preview)}`,
      };
    }

    if (preview.moved.length === 0) {
      return {
        ...empty,
        unchanged: preview.unchanged.length,
        errors: preview.errors,
        message: `Every card named is already in "${preview.column}". Nothing to do.`,
      };
    }

    // An add costs a second of its own, so a plan that adds cards is paced
    // slower than its move count suggests.
    const writes = preview.moved.length + preview.addedToBoard.length;
    const message = [
      `Move ${preview.moved.length} card(s) to "${preview.column}" on board #${preview.projectNumber} "${preview.projectTitle}". GitHub is written about once a second, so this takes ${estimateDuration(writes)}:`,
      describe(preview),
      preview.addedToBoard.length > 0
        ? `${preview.addedToBoard.length} will be added to the board.`
        : '',
      'This is an explicit move, so it overrides what the derived sync would set.',
      'Confirm to write it.',
    ]
      .filter(Boolean)
      .join('\n');

    console.log(`  [setBoardColumn] awaiting confirmation for ${preview.moved.length} move(s)`);
    await ctx.agent?.suspend({
      message,
      column: preview.column,
      moving: preview.moved.length,
      addingToBoard: preview.addedToBoard.length,
      projectNumber: preview.projectNumber,
      projectTitle: preview.projectTitle,
    });

    return {
      ...empty,
      errors: [],
      message: 'Waiting for confirmation before moving the cards.',
    };
  },
});
