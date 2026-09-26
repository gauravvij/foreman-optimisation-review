import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getIssuesData } from '../github';

// getIssuesData drives every ingestion path, so what it drops is what the
// graph is silently missing. The regression these tests exist to catch is
// exactly that: the query fetches a field, but fetchCompleteIssue's object
// literal forgets to copy it forward.

const ISSUE_PAYLOAD = {
  id: 'I_2639',
  number: 2639,
  title: 'Fix Builds table',
  bodyText: 'body',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-18T00:00:00Z',
  closedAt: null,
  state: 'OPEN',
  author: { login: 'astro-automaton' },
  assignees: { nodes: [{ login: 'krosnick' }] },
  labels: { nodes: [{ name: 'bug' }] },
  reactions: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null }, totalCount: 0 },
  comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null }, totalCount: 0 },
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () => new Response(JSON.stringify({ data: { repository: { issue: ISSUE_PAYLOAD } } })),
    ),
  );
  vi.stubEnv('GITHUB_TOKEN', 'test');
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('getIssuesData', () => {
  it('carries assignees through from the GraphQL response into IssueData', async () => {
    const { results, errors } = await getIssuesData('astropods', 'astro', [2639]);

    expect(errors).toEqual([]);
    const issue = results[0]?.issue;
    expect(issue?.assignees?.nodes, 'the field the ingest reads must survive the fetch').toEqual([
      { login: 'krosnick' },
    ]);
  });

  it('carries the author, labels, and state alongside, so a regression in one is caught by one test', async () => {
    const { results } = await getIssuesData('astropods', 'astro', [2639]);
    const issue = results[0]?.issue;

    expect(issue?.author?.login).toBe('astro-automaton');
    expect(issue?.labels?.nodes.map((l) => l.name)).toEqual(['bug']);
    expect(issue?.state).toBe('OPEN');
  });
});
