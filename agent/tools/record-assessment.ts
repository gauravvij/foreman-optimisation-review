import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { DECISIONS, listAssessments, recordAssessment } from '../../src/services/assessment';

export const recordAssessmentTool = createTool({
  id: 'recordAssessment',
  description:
    "Persist the user's triage decision about one or more issues, so it survives " +
    'this conversation. Use it whenever the user says an issue is nice to have, ' +
    'should be fixed, will not be fixed, or needs discussion. Record only what ' +
    'the user actually said; never infer a decision from issue text or from your ' +
    'own analysis. Writes to the graph, not to GitHub.\n\n' +
    'Rules:\n' +
    '- When the user states a judgment about issues, record it here rather than ' +
    'only replying. You have no memory between conversations; the graph is the ' +
    'only place a decision survives. Record what the user said, not what you ' +
    'concluded.\n' +
    "- An Assessment is a person's decision and outranks priorityScore, which is " +
    "the model's. When both exist and disagree, lead with the Assessment and " +
    'say the score differs.\n' +
    '- There are three ways to persist a correction, and they are not ' +
    'interchangeable. A judgment naming particular issues is an Assessment. A ' +
    'mapping from a GitHub label to a category is a Rule, enforced after ' +
    'classification. A judgment about the classification itself, such as two ' +
    'values that should not appear together, is Guidance: there is no input to ' +
    'match on, so it is given to the classifier as an instruction instead. ' +
    'Prefer a Rule when the condition is a label, because advisory guidance can ' +
    'be ignored by the model.\n' +
    '- Distinguish a decision about one issue from a decision about a kind of ' +
    'issue. A judgment of the form "anything with this label belongs in that ' +
    'category" is a Rule: it must keep applying to issues that do not exist yet, ' +
    'so record it with recordCategoryRule rather than editing only the issues ' +
    'you can currently see.\n' +
    '- Guidance and Rules take effect on the next analysis, not retroactively. ' +
    'Say so, rather than implying existing issues have already changed.',
  inputSchema: z.object({
    issueNumbers: z.array(z.number()).describe('The issues this decision applies to'),
    decision: z.enum(DECISIONS),
    note: z.string().optional().describe("The user's reasoning, in their words where possible"),
  }),
  outputSchema: z.object({
    recorded: z.array(z.number()),
    replaced: z.array(z.number()),
    notFound: z.array(z.number()),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (input) => {
    try {
      console.log(
        `  [recordAssessment] ${input.decision} for ${input.issueNumbers.length} issue(s)`,
      );
      const r = await recordAssessment({
        issueNumbers: input.issueNumbers,
        decision: input.decision,
        note: input.note,
      });

      const parts = [`Recorded ${input.decision} for ${r.recorded.length} issue(s).`];
      if (r.replaced.length > 0) {
        parts.push(`Replaced a previous decision on ${r.replaced.map((n) => `#${n}`).join(', ')}.`);
      }
      if (r.notFound.length > 0) {
        parts.push(`Not in the graph: ${r.notFound.map((n) => `#${n}`).join(', ')}.`);
      }

      return { ...r, message: parts.join(' ') };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [recordAssessment] error: ${msg}`);
      return {
        recorded: [],
        replaced: [],
        notFound: [],
        message: 'Could not record the decision.',
        error: msg,
      };
    }
  },
});

export const listAssessmentsTool = createTool({
  id: 'listAssessments',
  description:
    'Read back the triage decisions a user has recorded, optionally filtered to ' +
    'one decision. Use this when asked what was decided about an issue, or to ' +
    'list everything marked a particular way. These are human decisions and ' +
    'outrank your own priority scoring.',
  inputSchema: z.object({
    decision: z.enum(DECISIONS).optional().describe('Filter to one decision; omit for all'),
  }),
  outputSchema: z.object({
    assessments: z.array(
      z.object({
        issueNumber: z.number(),
        title: z.string(),
        decision: z.string(),
        note: z.string().nullable(),
        recordedAt: z.string(),
        recordedBy: z.string(),
      }),
    ),
    total: z.number(),
    error: z.string().optional(),
  }),
  execute: async (input) => {
    try {
      const assessments = await listAssessments(input.decision);
      console.log(`  [listAssessments] ${assessments.length} recorded`);
      return { assessments, total: assessments.length };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [listAssessments] error: ${msg}`);
      return { assessments: [], total: 0, error: msg };
    }
  },
});
