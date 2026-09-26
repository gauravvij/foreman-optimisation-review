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
    'own analysis. Writes to the graph, not to GitHub.',
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
