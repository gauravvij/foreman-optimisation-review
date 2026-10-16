import type { Session } from 'neo4j-driver';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { insertIssue, insertPullRequest } from '../neo4j';
import type { GitHubIssue, GitHubPullRequest } from '../neo4j';
import { createFakeDriver } from './fake-driver';

// insertIssue takes a Session directly, so the fake driver's session is
// enough. No module mock is needed, which is the point: ingestIssueData and
// getDriver live in the same module and vi.mock cannot rewire that call.

let db: ReturnType<typeof createFakeDriver>;
const asSession = () => db.mockSession as unknown as Session;

const ISSUE: GitHubIssue = {
  id: 'I_1',
  number: 42,
  title: 'Assignment behaviour',
  bodyText: '',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-25T00:00:00Z',
  closedAt: null,
  state: 'OPEN',
  author: { login: 'alice' },
  totalComments: 0,
};

beforeEach(() => {
  db = createFakeDriver();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('insertIssue: assignees', () => {
  it('links each assignee to the issue and merges User nodes for them', async () => {
    await insertIssue(asSession(), {
      ...ISSUE,
      assignees: { nodes: [{ login: 'bob' }, { login: 'carol' }] },
    });

    const merged = db.queries.find((q) => q.query.includes('MERGE (i)-[:ASSIGNED_TO]->(u)'));
    expect(merged, 'the relationship was created').toBeDefined();
    expect(merged?.params.logins).toEqual(['bob', 'carol']);
    const userMerges = db.queries.filter((q) =>
      q.query.includes('MERGE (u:User {login: user.login})'),
    );
    // insertUsers runs once for the author and once for the assignees list.
    expect(userMerges, 'insertUsers ran twice: author then assignees').toHaveLength(2);
  });

  it('always clears prior ASSIGNED_TO edges before writing new ones', async () => {
    await insertIssue(asSession(), { ...ISSUE, assignees: { nodes: [{ login: 'bob' }] } });

    const del = db.indexOf('[r:ASSIGNED_TO]->() DELETE r');
    const add = db.indexOf('MERGE (i)-[:ASSIGNED_TO]->(u)');
    expect(del, 'the delete ran').toBeGreaterThanOrEqual(0);
    expect(add, 'the add ran after the delete').toBeGreaterThan(del);
  });

  it('handles unassignment by clearing edges and writing no new ones', async () => {
    await insertIssue(asSession(), { ...ISSUE, assignees: { nodes: [] } });

    expect(
      db.indexOf('[r:ASSIGNED_TO]->() DELETE r'),
      'the delete still fires',
    ).toBeGreaterThanOrEqual(0);
    expect(db.indexOf('MERGE (i)-[:ASSIGNED_TO]->(u)'), 'no add ran').toBe(-1);
  });

  it('tolerates a missing assignees field, since older API responses omit it', async () => {
    await expect(insertIssue(asSession(), ISSUE)).resolves.toBeUndefined();
    expect(db.indexOf('MERGE (i)-[:ASSIGNED_TO]->(u)')).toBe(-1);
  });

  it('drops null or empty logins that GitHub can return for deleted users', async () => {
    await insertIssue(asSession(), {
      ...ISSUE,
      assignees: {
        nodes: [
          { login: 'bob' },
          { login: '' },
          null as unknown as { login: string },
          { login: 'dave' },
        ],
      },
    });

    const merged = db.queries.find((q) => q.query.includes('MERGE (i)-[:ASSIGNED_TO]->(u)'));
    expect(merged?.params.logins, 'ghost users must not become ASSIGNED_TO edges').toEqual([
      'bob',
      'dave',
    ]);
  });
});

const PR: GitHubPullRequest = {
  id: 'PR_1',
  number: 88,
  title: 'Fix the thing',
  url: 'https://github.com/acme/widgets/pull/88',
  state: 'MERGED',
  isDraft: false,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-07T00:00:00Z',
  closedAt: '2026-10-07T00:00:00Z',
  mergedAt: '2026-10-07T00:00:00Z',
  additions: 42,
  deletions: 7,
  changedFiles: 3,
  author: { login: 'alice' },
};

describe('insertPullRequest', () => {
  it('upserts the PullRequest with the fields the stats query needs', async () => {
    await insertPullRequest(asSession(), PR);

    const merge = db.queries.find((q) => q.query.includes('MERGE (pr:PullRequest {prId'));
    expect(merge, 'the node was merged').toBeDefined();
    expect(merge?.params).toMatchObject({
      prId: 'PR_1',
      number: 88,
      state: 'MERGED',
      isMerged: true,
      mergedAt: '2026-10-07T00:00:00Z',
      authorLogin: 'alice',
    });
  });

  it('derives isMerged from mergedAt so a closed-not-merged PR stays unmerged', async () => {
    await insertPullRequest(asSession(), { ...PR, state: 'CLOSED', mergedAt: null });

    const merge = db.queries.find((q) => q.query.includes('MERGE (pr:PullRequest {prId'));
    expect(merge?.params.isMerged, 'closed with mergedAt null is not merged').toBe(false);
  });

  it('links the author so stats can filter by login', async () => {
    await insertPullRequest(asSession(), PR);

    const edge = db.queries.find((q) => q.query.includes('MERGE (pr)-[:AUTHORED_BY]->(u)'));
    expect(edge, 'the author edge was created').toBeDefined();
    expect(edge?.params).toMatchObject({ prId: 'PR_1', login: 'alice' });
  });

  it('creates CLOSES edges to the referenced issue numbers', async () => {
    await insertPullRequest(asSession(), {
      ...PR,
      closingIssuesReferences: { nodes: [{ number: 100 }, { number: 101 }] },
    });

    const closes = db.queries.find((q) => q.query.includes('MERGE (pr)-[:CLOSES]->(i)'));
    expect(closes, 'the closes edge was written').toBeDefined();
    expect(closes?.params.numbers).toEqual([100, 101]);
  });

  it('rewrites assignee and label edges on every call, so a change is reflected', async () => {
    await insertPullRequest(asSession(), {
      ...PR,
      assignees: { nodes: [{ login: 'bob' }] },
      labels: { nodes: [{ name: 'ready-for-review' }] },
    });

    expect(
      db.indexOf('(pr:PullRequest {prId: $prId})-[r:ASSIGNED_TO]->() DELETE r'),
    ).toBeGreaterThanOrEqual(0);
    expect(
      db.indexOf('(pr:PullRequest {prId: $prId})-[r:HAS_LABEL]->() DELETE r'),
    ).toBeGreaterThanOrEqual(0);
    expect(
      db.indexOf('(pr:PullRequest {prId: $prId})-[r:CLOSES]->() DELETE r'),
    ).toBeGreaterThanOrEqual(0);
  });
});
