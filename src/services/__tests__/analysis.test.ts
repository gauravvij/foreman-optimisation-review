import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDriver } from './fake-driver';

const fake = vi.hoisted(() => ({
  ref: null as ReturnType<typeof import('./fake-driver').createFakeDriver> | null,
}));

vi.mock('../neo4j', () => ({ getDriver: () => fake.ref?.mockDriver }));

import { ingestAnalysisResults } from '../analysis';
import type { IssueAnalysis } from '../issue-analysis';

let db: ReturnType<typeof createFakeDriver>;

const analysis = (over: Partial<IssueAnalysis> = {}): IssueAnalysis =>
  ({
    summary: 'a summary',
    categories: [],
    category: 'backend',
    subcategory: null,
    severity: 'high',
    impact: 'moderate',
    effort: 'large',
    issueType: 'bug',
    needsClarification: false,
    clarificationReason: '',
    priorityRationale: 'because',
    competitors: [],
    solutions: [],
    workarounds: [],
    ...over,
  }) as IssueAnalysis;

/** The params of the SET that writes the classification. */
const classification = () =>
  db.queries.find((q) => q.query.includes('i.priorityScore'))?.params ?? {};

beforeEach(() => {
  db = createFakeDriver();
  fake.ref = db;
  vi.clearAllMocks();
});

describe('ingestAnalysisResults classification', () => {
  it('stores the canonical effort for a value the model varied the casing of', async () => {
    await ingestAnalysisResults([
      { issueNumber: 57, analysis: analysis({ effort: 'Large' as never }) },
    ]);

    expect(classification().effort, 'the graph holds the canonical effort').toBe('large');
  });

  it('flags an issue it could not size instead of scoring it as large', async () => {
    await ingestAnalysisResults([
      { issueNumber: 57, analysis: analysis({ effort: 'epic' as never }) },
    ]);
    const params = classification();

    expect(params.effort, 'an unsizeable effort is not persisted').toBeNull();
    expect(params.needsClarification, 'the issue is flagged for a human').toBe(true);
    expect(params.clarificationReason, 'the flag says what is missing').toContain('effort');
  });

  it('keeps the model reason alongside the unsized reason', async () => {
    await ingestAnalysisResults([
      {
        issueNumber: 57,
        analysis: analysis({
          effort: 'epic' as never,
          needsClarification: true,
          clarificationReason: 'No reproduction steps.',
        }),
      },
    ]);

    expect(classification().clarificationReason, 'neither reason is dropped').toBe(
      'No reproduction steps. The effort is unclear, so the issue has no size.',
    );
  });

  it('leaves a sized issue unflagged', async () => {
    await ingestAnalysisResults([{ issueNumber: 57, analysis: analysis() }]);
    const params = classification();

    expect(params.needsClarification, 'a sizeable issue needs no clarification').toBe(false);
    expect(params.clarificationReason, 'no reason is invented').toBeNull();
  });

  it('scores an unsized issue below the same issue sized large', async () => {
    await ingestAnalysisResults([{ issueNumber: 1, analysis: analysis({ effort: 'large' }) }]);
    const sized = classification().priorityScore as number;

    db.reset();
    await ingestAnalysisResults([
      { issueNumber: 2, analysis: analysis({ effort: 'epic' as never }) },
    ]);
    const unsized = classification().priorityScore as number;

    expect(unsized, 'an unknown effort earns no effort points').toBeLessThan(sized);
  });
});
