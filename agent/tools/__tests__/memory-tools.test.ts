import { beforeEach, describe, expect, it, vi } from 'vitest';

const svc = vi.hoisted(() => ({
  recordCategoryRule: vi.fn(),
  applyCategoryRules: vi.fn(),
  listCategoryRules: vi.fn(),
  deleteCategoryRule: vi.fn(),
  recordGuidance: vi.fn(),
  listGuidance: vi.fn(),
  deleteGuidance: vi.fn(),
  recordAssessment: vi.fn(),
  listAssessments: vi.fn(),
}));

vi.mock('../../../src/services/rules', () => ({
  recordCategoryRule: svc.recordCategoryRule,
  applyCategoryRules: svc.applyCategoryRules,
  listCategoryRules: svc.listCategoryRules,
  deleteCategoryRule: svc.deleteCategoryRule,
}));
vi.mock('../../../src/services/guidance', () => ({
  recordGuidance: svc.recordGuidance,
  listGuidance: svc.listGuidance,
  deleteGuidance: svc.deleteGuidance,
}));
vi.mock('../../../src/services/assessment', () => ({
  DECISIONS: ['should-fix', 'nice-to-have', 'wont-fix', 'needs-discussion'] as const,
  recordAssessment: svc.recordAssessment,
  listAssessments: svc.listAssessments,
}));

import { listCategoryRulesTool, recordCategoryRuleTool } from '../category-rules';
import { listGuidanceTool, recordGuidanceTool } from '../guidance';
import { listAssessmentsTool, recordAssessmentTool } from '../record-assessment';

const ctx = {} as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recordCategoryRuleTool', () => {
  it('saves the rule and applies it in one call, so the user sees the effect', async () => {
    svc.recordCategoryRule.mockResolvedValue(undefined);
    svc.applyCategoryRules.mockResolvedValue([
      { issueNumber: 1, label: 'tooling', from: 'ui-polish', to: 'tooling' },
    ]);

    const r = (await recordCategoryRuleTool.execute!(
      { label: 'tooling', category: 'tooling' },
      ctx,
    )) as { changedCount: number; message: string };

    expect(svc.recordCategoryRule).toHaveBeenCalledBefore(svc.applyCategoryRules);
    expect(r.changedCount).toBe(1);
    expect(r.message).toContain('#1');
  });

  it('counts only issues its own rule moved, not every rule that fired', async () => {
    svc.recordCategoryRule.mockResolvedValue(undefined);
    svc.applyCategoryRules.mockResolvedValue([
      { issueNumber: 1, label: 'tooling', from: null, to: 'tooling' },
      { issueNumber: 2, label: 'security', from: null, to: 'security' },
    ]);

    const r = (await recordCategoryRuleTool.execute!(
      { label: 'tooling', category: 'tooling' },
      ctx,
    )) as { changedCount: number; changed: { issueNumber: number }[] };

    expect(r.changedCount, 'applyCategoryRules replays every stored rule').toBe(1);
    expect(r.changed.map((c) => c.issueNumber)).toEqual([1]);
  });

  it('still confirms the rule is saved when it moved nothing today', async () => {
    svc.recordCategoryRule.mockResolvedValue(undefined);
    svc.applyCategoryRules.mockResolvedValue([]);

    const r = (await recordCategoryRuleTool.execute!(
      { label: 'tooling', category: 'tooling' },
      ctx,
    )) as { message: string };

    expect(r.message).toContain('Rule saved');
    expect(r.message).toContain('No issues needed changing');
  });

  it('shapes a service failure instead of throwing', async () => {
    svc.recordCategoryRule.mockRejectedValue(new Error('bolt refused'));

    const r = (await recordCategoryRuleTool.execute!(
      { label: 'tooling', category: 'tooling' },
      ctx,
    )) as { error?: string; changedCount: number };

    expect(r.error).toBe('bolt refused');
    expect(r.changedCount).toBe(0);
  });
});

describe('listCategoryRulesTool', () => {
  it('lists without deleting when remove is omitted', async () => {
    svc.listCategoryRules.mockResolvedValue([
      { label: 'tooling', category: 'tooling', note: null, recordedAt: 't' },
    ]);

    const r = (await listCategoryRulesTool.execute!({}, ctx)) as {
      removed: boolean;
      message: string;
    };

    expect(svc.deleteCategoryRule).not.toHaveBeenCalled();
    expect(r.removed).toBe(false);
    expect(r.message).toContain('1 category rule');
  });

  it('warns that removing a rule does not reclassify what it already changed', async () => {
    svc.deleteCategoryRule.mockResolvedValue(true);
    svc.listCategoryRules.mockResolvedValue([]);

    const r = (await listCategoryRulesTool.execute!({ remove: 'tooling' }, ctx)) as {
      message: string;
    };

    expect(r.message).toContain('Existing categories are unchanged');
  });

  it('says so plainly when there was no such rule', async () => {
    svc.deleteCategoryRule.mockResolvedValue(false);
    svc.listCategoryRules.mockResolvedValue([]);

    const r = (await listCategoryRulesTool.execute!({ remove: 'nope' }, ctx)) as {
      removed: boolean;
      message: string;
    };

    expect(r.removed).toBe(false);
    expect(r.message).toContain('No rule was recorded');
  });

  it('shapes a service failure instead of throwing', async () => {
    svc.listCategoryRules.mockRejectedValue(new Error('bolt refused'));

    const r = (await listCategoryRulesTool.execute!({}, ctx)) as { error?: string };

    expect(r.error).toBe('bolt refused');
  });
});

describe('recordGuidanceTool', () => {
  it('reports the running total so the user knows what the classifier will read', async () => {
    svc.recordGuidance.mockResolvedValue({ id: 'a', text: 'Tooling is not ui-polish.' });
    svc.listGuidance.mockResolvedValue([{ text: 'a' }, { text: 'b' }]);

    const r = (await recordGuidanceTool.execute!({ text: 'Tooling is not ui-polish.' }, ctx)) as {
      total: number;
      message: string;
    };

    expect(r.total).toBe(2);
    expect(r.message).toContain('2 standing instruction');
  });

  it('says the note does not reclassify what is already stored', async () => {
    svc.recordGuidance.mockResolvedValue({ id: 'a', text: 'x' });
    svc.listGuidance.mockResolvedValue([{ text: 'x' }]);

    const r = (await recordGuidanceTool.execute!({ text: 'x' }, ctx)) as { message: string };

    expect(r.message).toContain('does not reclassify');
  });

  it('returns the stored text, which may be trimmed, not the raw input', async () => {
    svc.recordGuidance.mockResolvedValue({ id: 'a', text: 'trimmed' });
    svc.listGuidance.mockResolvedValue([{ text: 'trimmed' }]);

    const r = (await recordGuidanceTool.execute!({ text: '  trimmed  ' }, ctx)) as {
      text: string;
    };

    expect(r.text).toBe('trimmed');
  });

  it('shapes a rejected empty note instead of throwing', async () => {
    svc.recordGuidance.mockRejectedValue(new Error('guidance text cannot be empty'));

    const r = (await recordGuidanceTool.execute!({ text: '  ' }, ctx)) as { error?: string };

    expect(r.error).toContain('empty');
  });
});

describe('listGuidanceTool', () => {
  it('lists without deleting when remove is omitted', async () => {
    svc.listGuidance.mockResolvedValue([{ text: 'a', recordedAt: 't' }]);

    const r = (await listGuidanceTool.execute!({}, ctx)) as { removed: boolean; message: string };

    expect(svc.deleteGuidance).not.toHaveBeenCalled();
    expect(r.removed).toBe(false);
    expect(r.message).toContain('1 standing instruction');
  });

  it('reports nothing recorded rather than an empty message', async () => {
    svc.listGuidance.mockResolvedValue([]);

    const r = (await listGuidanceTool.execute!({}, ctx)) as { message: string };

    expect(r.message).toContain('No standing classification instructions');
  });

  it('says so plainly when the quoted note was never recorded', async () => {
    svc.deleteGuidance.mockResolvedValue(false);
    svc.listGuidance.mockResolvedValue([]);

    const r = (await listGuidanceTool.execute!({ remove: 'never said this' }, ctx)) as {
      message: string;
    };

    expect(r.message).toContain('No matching instruction');
  });

  it('shapes a service failure instead of throwing', async () => {
    svc.listGuidance.mockRejectedValue(new Error('bolt refused'));

    const r = (await listGuidanceTool.execute!({}, ctx)) as { error?: string };

    expect(r.error).toBe('bolt refused');
  });
});

describe('recordAssessmentTool', () => {
  const result = (over = {}) => ({ recorded: [1], replaced: [], notFound: [], ...over });

  it('confirms the decision and how many issues it covered', async () => {
    svc.recordAssessment.mockResolvedValue(result({ recorded: [1, 2] }));

    const r = (await recordAssessmentTool.execute!(
      { issueNumbers: [1, 2], decision: 'nice-to-have' },
      ctx,
    )) as { message: string };

    expect(r.message).toContain('Recorded nice-to-have for 2 issue(s)');
  });

  it('surfaces that an earlier decision was overwritten', async () => {
    svc.recordAssessment.mockResolvedValue(result({ replaced: [1] }));

    const r = (await recordAssessmentTool.execute!(
      { issueNumbers: [1], decision: 'wont-fix' },
      ctx,
    )) as { message: string };

    expect(r.message, 'silently replacing a human decision is the bad outcome').toContain(
      'Replaced a previous decision on #1',
    );
  });

  it('names the issues it could not find rather than reporting plain success', async () => {
    svc.recordAssessment.mockResolvedValue(result({ recorded: [1], notFound: [999] }));

    const r = (await recordAssessmentTool.execute!(
      { issueNumbers: [1, 999], decision: 'should-fix' },
      ctx,
    )) as { message: string };

    expect(r.message).toContain('Not in the graph: #999');
  });

  it('omits the replaced and not-found clauses when neither applies', async () => {
    svc.recordAssessment.mockResolvedValue(result());

    const r = (await recordAssessmentTool.execute!(
      { issueNumbers: [1], decision: 'should-fix' },
      ctx,
    )) as { message: string };

    expect(r.message).toBe('Recorded should-fix for 1 issue(s).');
  });

  it('passes the note through to the service', async () => {
    svc.recordAssessment.mockResolvedValue(result());

    await recordAssessmentTool.execute!(
      { issueNumbers: [1], decision: 'wont-fix', note: 'superseded by the rewrite' },
      ctx,
    );

    expect(svc.recordAssessment).toHaveBeenCalledWith(
      expect.objectContaining({ note: 'superseded by the rewrite' }),
    );
  });

  it('shapes a service failure instead of throwing', async () => {
    svc.recordAssessment.mockRejectedValue(new Error('bolt refused'));

    const r = (await recordAssessmentTool.execute!(
      { issueNumbers: [1], decision: 'should-fix' },
      ctx,
    )) as { error?: string; recorded: number[] };

    expect(r.error).toBe('bolt refused');
    expect(r.recorded).toEqual([]);
  });
});

describe('listAssessmentsTool', () => {
  const stored = (n: number) => ({
    issueNumber: n,
    title: `Issue ${n}`,
    decision: 'wont-fix',
    note: null,
    recordedAt: '2026-09-13T00:00:00Z',
    recordedBy: 'user',
  });

  it('returns every decision when unfiltered', async () => {
    svc.listAssessments.mockResolvedValue([stored(1), stored(2)]);

    const r = (await listAssessmentsTool.execute!({}, ctx)) as { total: number };

    expect(svc.listAssessments).toHaveBeenCalledWith(undefined);
    expect(r.total).toBe(2);
  });

  it('passes the filter through when given one', async () => {
    svc.listAssessments.mockResolvedValue([]);

    await listAssessmentsTool.execute!({ decision: 'wont-fix' }, ctx);

    expect(svc.listAssessments).toHaveBeenCalledWith('wont-fix');
  });

  it('shapes a service failure instead of throwing', async () => {
    svc.listAssessments.mockRejectedValue(new Error('bolt refused'));

    const r = (await listAssessmentsTool.execute!({}, ctx)) as { error?: string; total: number };

    expect(r.error).toBe('bolt refused');
    expect(r.total).toBe(0);
  });
});
