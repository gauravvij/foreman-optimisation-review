import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { deleteGuidance, listGuidance, recordGuidance } from '../../src/services/guidance';

export const recordGuidanceTool = createTool({
  id: 'recordGuidance',
  description:
    'Persist a standing instruction about how issues should be classified, in ' +
    "the user's own words. Use it when the user corrects the classification " +
    'itself rather than one issue, for example saying two classification values ' +
    'should not appear together. The note is added to the classifier prompt on ' +
    'every future run. Prefer recordCategoryRule when the condition is a GitHub ' +
    'label, since that is enforced rather than advisory.\n\n' +
    'Rules:\n' +
    '- Guidance is for a judgment about the classification itself, where there is ' +
    'no input to match on. A judgment naming particular issues is an Assessment; ' +
    'a mapping from a label to a category is a Rule.\n' +
    '- Guidance takes effect on the next analysis, not retroactively. Say so, ' +
    'rather than implying existing issues have already changed.',
  inputSchema: z.object({
    text: z.string().describe('The instruction, phrased as the user said it'),
  }),
  outputSchema: z.object({
    text: z.string(),
    total: z.number(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (input) => {
    try {
      console.log(`  [recordGuidance] ${input.text.slice(0, 80)}`);
      const g = await recordGuidance({ text: input.text });
      const all = await listGuidance();
      return {
        text: g.text,
        total: all.length,
        message:
          `Noted. This will be given to the classifier on every future run ` +
          `(${all.length} standing instruction(s) now). It does not reclassify ` +
          `existing issues; re-analysis will apply it.`,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [recordGuidance] error: ${msg}`);
      return { text: input.text, total: 0, message: 'Could not save the note.', error: msg };
    }
  },
});

export const listGuidanceTool = createTool({
  id: 'listGuidance',
  description:
    'Read back the standing classification instructions the user has recorded, ' +
    'and optionally remove one. Consult this when asked what notes are on record.',
  inputSchema: z.object({
    remove: z.string().optional().describe('Text of the instruction to delete; omit to only list'),
  }),
  outputSchema: z.object({
    guidance: z.array(z.object({ text: z.string(), recordedAt: z.string() })),
    removed: z.boolean(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (input) => {
    try {
      const removed = input.remove ? await deleteGuidance(input.remove) : false;
      const all = await listGuidance();
      const message = input.remove
        ? removed
          ? 'Removed. Existing classifications are unchanged; re-analysis will drop it.'
          : 'No matching instruction was recorded.'
        : all.length === 0
          ? 'No standing classification instructions recorded.'
          : `${all.length} standing instruction(s) recorded.`;

      return {
        guidance: all.map((g) => ({ text: g.text, recordedAt: g.recordedAt })),
        removed,
        message,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { guidance: [], removed: false, message: 'Could not read the notes.', error: msg };
    }
  },
});
