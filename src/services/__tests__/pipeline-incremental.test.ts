/**
 * A "changes only" sync must re-analyse an issue that was edited on GitHub.
 *
 * The original read each issue's stored updatedAt *after* step 3 had already
 * overwritten it with GitHub's value, so the comparison was always equal and no
 * edited issue was ever re-analysed. The stand-in graph below keeps the real
 * order of events: ingest overwrites updatedAt, exactly as the database does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  stored: new Map<number, string>(),
  analysed: [] as number[],
  github: [] as { number: number; updatedAt: string }[],
}));

const issueData = (number: number, updatedAt: string) => ({
  issue: {
    id: `I_${number}`,
    number,
    title: `issue ${number}`,
    bodyText: 'body',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt,
    closedAt: null,
    state: 'OPEN',
    author: { login: 'someone' },
    labels: { nodes: [] },
    totalComments: 0,
  },
  comments: [],
});

vi.mock('../github', () => ({
  getAllIssueNumbers: async () => ({
    issueNumbers: h.github.map((i) => i.number),
    issues: [],
    total: h.github.length,
  }),
  getIssuesData: async () => ({
    results: h.github.map((i) => issueData(i.number, i.updatedAt)),
    errors: [],
  }),
  getPullRequests: async () => [],
}));

vi.mock('../neo4j', () => ({
  setupDatabaseSchema: async () => ({ ran: false, failures: [] }),
  getLastSyncTimestamp: async () => '2026-01-01T00:00:00Z',
  setLastSyncTimestamp: async () => {},
  getLastPullRequestSyncTimestamp: async () => null,
  setLastPullRequestSyncTimestamp: async () => {},
  ingestPullRequests: async () => ({ ingested: 0, errors: [] }),
  getIssueUpdatedAtBatch: async (numbers: number[]) =>
    new Map(numbers.filter((n) => h.stored.has(n)).map((n) => [n, h.stored.get(n)!])),
  // Writing an issue overwrites its stored updatedAt, as the real graph does.
  ingestMultipleIssues: async (
    data: { issue: { id: string; number: number; updatedAt: string } }[],
  ) => {
    for (const d of data) h.stored.set(d.issue.number, d.issue.updatedAt);
    return { results: data.map((d) => ({ success: true, issueId: d.issue.id })), errors: [] };
  },
}));

vi.mock('../issue-analysis', () => ({
  transformIssueDataForAnalysis: (d: { issue: { number: number } }) => d,
  analyzeIssue: async (d: { issue: { number: number } }) => {
    h.analysed.push(d.issue.number);
    return { analysis: {} };
  },
}));

vi.mock('../analysis', () => ({
  ingestAnalysisResults: async () => ({ results: [], errors: [] }),
}));
vi.mock('../subcategory', () => ({ ensureVocabulary: async () => [] }));
vi.mock('../guidance', () => ({ listGuidance: async () => [], renderGuidance: () => '' }));
vi.mock('../rules', () => ({ applyCategoryRules: async () => [] }));
vi.mock('../models', () => ({ modelFor: () => 'test-model' }));

import { runPipeline } from '../pipeline';

const config = { owner: 'o', repo: 'r', state: 'all' as const, limit: 0, analyze: true };

describe('incremental sync re-analysis', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    h.stored.clear();
    h.analysed.length = 0;
    h.stored.set(1, '2026-02-01T00:00:00Z');
    h.stored.set(2, '2026-02-01T00:00:00Z');
  });

  it('re-analyses an issue edited on GitHub and skips one that was not', async () => {
    h.github = [
      { number: 1, updatedAt: '2026-03-01T00:00:00Z' }, // edited since the last run
      { number: 2, updatedAt: '2026-02-01T00:00:00Z' }, // unchanged
    ];
    const result = await runPipeline(config);

    expect(h.analysed, 'only the edited issue is re-analysed').toEqual([1]);
    expect(result.issuesSkipped).toBe(1);
    expect(result.incremental).toBe(true);
  });

  it('analyses an issue the graph has never held', async () => {
    h.github = [{ number: 3, updatedAt: '2026-03-01T00:00:00Z' }];
    await runPipeline(config);
    expect(h.analysed).toEqual([3]);
  });
});
