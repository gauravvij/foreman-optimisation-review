import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { TAXONOMY } from '../../src/services/priority';
import {
  applyCategoryRules,
  deleteCategoryRule,
  listCategoryRules,
  recordCategoryRule,
} from '../../src/services/rules';

export const recordCategoryRuleTool = createTool({
  id: 'recordCategoryRule',
  description:
    'Persist a standing rule that issues carrying a given GitHub label belong to ' +
    'a given category, and apply it immediately. Use this when the user corrects ' +
    'a whole class of issues rather than one, for example "anything labelled X ' +
    'should be Y". The rule keeps applying to issues ingested later, and always ' +
    "wins over the model's own classification.",
  inputSchema: z.object({
    label: z.string().describe('The GitHub label to match, exactly as it appears on issues'),
    category: z.enum(TAXONOMY),
    note: z.string().optional().describe("The user's reasoning"),
  }),
  outputSchema: z.object({
    label: z.string(),
    category: z.string(),
    changed: z.array(
      z.object({ issueNumber: z.number(), from: z.string().nullable(), to: z.string() }),
    ),
    changedCount: z.number(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (input) => {
    try {
      console.log(`  [recordCategoryRule] ${input.label} -> ${input.category}`);
      await recordCategoryRule(input);
      const changed = await applyCategoryRules();

      const mine = changed.filter((c) => c.label === input.label);
      const message =
        mine.length === 0
          ? `Rule saved: issues labelled "${input.label}" are ${input.category}. No issues needed changing.`
          : `Rule saved and applied: ${mine.length} issue(s) moved to ${input.category} (${mine.map((c) => `#${c.issueNumber}`).join(', ')}). It will apply to future issues too.`;

      return {
        label: input.label,
        category: input.category,
        changed: mine.map((c) => ({ issueNumber: c.issueNumber, from: c.from, to: c.to })),
        changedCount: mine.length,
        message,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [recordCategoryRule] error: ${msg}`);
      return {
        label: input.label,
        category: input.category,
        changed: [],
        changedCount: 0,
        message: 'Could not save the rule.',
        error: msg,
      };
    }
  },
});

export const listCategoryRulesTool = createTool({
  id: 'listCategoryRules',
  description:
    'Read back the standing label-to-category rules the user has recorded, and ' +
    'optionally remove one. Consult this when asked why an issue has the ' +
    'category it does, or what corrections are on record.',
  inputSchema: z.object({
    remove: z.string().optional().describe('Label whose rule should be deleted; omit to only list'),
  }),
  outputSchema: z.object({
    rules: z.array(
      z.object({
        label: z.string(),
        category: z.string(),
        note: z.string().nullable(),
        recordedAt: z.string(),
      }),
    ),
    removed: z.boolean(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (input) => {
    try {
      let removed = false;
      if (input.remove) {
        removed = await deleteCategoryRule(input.remove);
      }
      const rules = await listCategoryRules();
      const message = input.remove
        ? removed
          ? `Removed the rule for "${input.remove}". Existing categories are unchanged; re-analysis will reclassify those issues.`
          : `No rule was recorded for "${input.remove}".`
        : rules.length === 0
          ? 'No category rules recorded.'
          : `${rules.length} category rule(s) recorded.`;

      return {
        rules: rules.map((r) => ({
          label: r.label,
          category: r.category,
          note: r.note,
          recordedAt: r.recordedAt,
        })),
        removed,
        message,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { rules: [], removed: false, message: 'Could not read the rules.', error: msg };
    }
  },
});
