import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchConcurrency, getIssuesData } from '../github';

// The fetch pool is opt-in (GITHUB_FETCH_CONCURRENCY, default 1). What must hold
// either way: results come back in listing order, a failure is attributed to the
// issue that caused it, and the pool never has more requests in flight than it
// was asked for.

describe('fetchConcurrency', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults to 1, the pre-existing serial behaviour', () => {
    vi.stubEnv('GITHUB_FETCH_CONCURRENCY', '');
    expect(fetchConcurrency(50)).toBe(1);
  });

  it('uses the configured value', () => {
    vi.stubEnv('GITHUB_FETCH_CONCURRENCY', '4');
    expect(fetchConcurrency(50)).toBe(4);
  });

  it('never exceeds the number of issues to fetch', () => {
    vi.stubEnv('GITHUB_FETCH_CONCURRENCY', '8');
    expect(fetchConcurrency(3)).toBe(3);
  });

  it('falls back to 1 for zero, negative or non-numeric values', () => {
    for (const bad of ['0', '-2', 'abc']) {
      vi.stubEnv('GITHUB_FETCH_CONCURRENCY', bad);
      expect(fetchConcurrency(10), `value "${bad}"`).toBe(1);
    }
  });

  it('returns at least 1 when there is nothing to fetch', () => {
    vi.stubEnv('GITHUB_FETCH_CONCURRENCY', '4');
    expect(fetchConcurrency(0)).toBe(1);
  });
});

function issuePayload(number: number) {
  return {
    id: `I_${number}`,
    number,
    title: `Issue ${number}`,
    bodyText: '',
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-18T00:00:00Z',
    closedAt: null,
    state: 'OPEN',
    author: { login: 'alice' },
    assignees: { nodes: [] },
    labels: { nodes: [] },
    reactions: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null }, totalCount: 0 },
    comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null }, totalCount: 0 },
  };
}

describe('getIssuesData with a worker pool', () => {
  let inFlight = 0;
  let maxInFlight = 0;

  beforeEach(() => {
    inFlight = 0;
    maxInFlight = 0;
    vi.stubEnv('GITHUB_TOKEN', 'test');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Earlier issues answer slowly and later ones quickly, so if the pool wrote
    // results in completion order instead of by index, the order would flip.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        const { issueNumber } = JSON.parse(init.body).variables as { issueNumber: number };
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, issueNumber === 1 ? 40 : 5));
        inFlight--;
        const issue = issueNumber === 3 ? null : issuePayload(issueNumber);
        return new Response(JSON.stringify({ data: { repository: { issue } } }));
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('keeps listing order even when later issues finish first', async () => {
    vi.stubEnv('GITHUB_FETCH_CONCURRENCY', '4');
    const { results, errors } = await getIssuesData('o', 'r', [1, 2, 4, 5]);

    expect(errors).toEqual([]);
    expect(results.map((r) => r.issue.number)).toEqual([1, 2, 4, 5]);
  });

  it('runs requests in parallel when asked to, and not beyond the limit', async () => {
    vi.stubEnv('GITHUB_FETCH_CONCURRENCY', '3');
    await getIssuesData('o', 'r', [1, 2, 4, 5, 6, 7]);

    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it('stays strictly serial by default', async () => {
    vi.stubEnv('GITHUB_FETCH_CONCURRENCY', '');
    await getIssuesData('o', 'r', [1, 2, 4]);

    expect(maxInFlight).toBe(1);
  });

  it('attributes a failure to its issue and still returns the rest, in order', async () => {
    vi.stubEnv('GITHUB_FETCH_CONCURRENCY', '4');
    const { results, errors } = await getIssuesData('o', 'r', [1, 2, 3, 4]);

    expect(results.map((r) => r.issue.number)).toEqual([1, 2, 4]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.issueNumber).toBe(3);
    expect(errors[0]?.error).toContain('not found');
  });
});
