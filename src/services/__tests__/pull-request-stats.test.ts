import neo4j from 'neo4j-driver';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDriver } from './fake-driver';

const fake = vi.hoisted(() => ({
  ref: null as ReturnType<typeof import('./fake-driver').createFakeDriver> | null,
  getPullRequests: vi.fn(),
  ingestPullRequests: vi.fn(),
  setLastPullRequestSyncTimestamp: vi.fn(),
}));

vi.mock('../neo4j', () => ({
  getDriver: () => fake.ref?.mockDriver,
  ingestPullRequests: fake.ingestPullRequests,
  setLastPullRequestSyncTimestamp: fake.setLastPullRequestSyncTimestamp,
}));
vi.mock('../github', () => ({ getPullRequests: fake.getPullRequests }));

import { pullRequestStats, refreshAllPullRequests } from '../pull-request-stats';

let db: ReturnType<typeof createFakeDriver>;

beforeEach(() => {
  db = createFakeDriver();
  fake.ref = db;
  fake.getPullRequests.mockReset();
  fake.ingestPullRequests.mockReset();
  fake.setLastPullRequestSyncTimestamp.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-16T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

function queueCounts(opened: number, merged: number, closed: number) {
  db.queueResult([
    {
      opened: neo4j.int(opened),
      merged: neo4j.int(merged),
      closed: neo4j.int(closed),
    },
  ]);
}

describe('pullRequestStats', () => {
  it('passes the author and the computed window into the Cypher counts', async () => {
    queueCounts(3, 1, 0);
    db.queueEmpty();

    const stats = await pullRequestStats({ author: 'alice', windowDays: 7 });

    expect(stats.opened).toBe(3);
    expect(stats.merged).toBe(1);
    expect(stats.closed).toBe(0);
    expect(stats.author).toBe('alice');
    expect(stats.window.days).toBe(7);
    expect(stats.window.until).toBe('2026-10-16T00:00:00.000Z');
    expect(stats.window.since).toBe('2026-10-09T00:00:00.000Z');

    const countsQuery = db.queries[0];
    expect(countsQuery.params).toMatchObject({
      author: 'alice',
      since: '2026-10-09T00:00:00.000Z',
      until: '2026-10-16T00:00:00.000Z',
    });
  });

  it('passes author=null to Cypher when no login is given, so the filter is a no-op', async () => {
    queueCounts(10, 7, 2);
    db.queueEmpty();

    const stats = await pullRequestStats({});

    expect(stats.author).toBeUndefined();
    expect(db.queries[0].params.author).toBeNull();
    expect(stats.opened).toBe(10);
  });

  it('honours an explicit since and until without applying windowDays', async () => {
    queueCounts(0, 0, 0);
    db.queueEmpty();

    const stats = await pullRequestStats({
      since: '2026-09-01T00:00:00Z',
      until: '2026-09-30T00:00:00Z',
      windowDays: 7,
    });

    expect(stats.window.since).toBe('2026-09-01T00:00:00.000Z');
    expect(stats.window.until).toBe('2026-09-30T00:00:00.000Z');
    expect(stats.window.days).toBe(29);
  });

  it('runs the sample query only when sampleLimit > 0', async () => {
    queueCounts(1, 0, 0);

    await pullRequestStats({ sampleLimit: 0 });

    expect(db.queries, 'only the counts query ran').toHaveLength(1);
  });

  it('maps the sample node properties onto the response shape', async () => {
    queueCounts(2, 1, 0);
    const prNode = {
      properties: {
        number: neo4j.int(88),
        title: 'Fix things',
        url: 'https://x',
        state: 'MERGED',
        isDraft: false,
        isMerged: true,
        createdAt: '2026-10-10T00:00:00Z',
        updatedAt: '2026-10-14T00:00:00Z',
        closedAt: '2026-10-14T00:00:00Z',
        mergedAt: '2026-10-14T00:00:00Z',
        authorLogin: 'alice',
      },
    };
    db.queueResult([{ pr: prNode }]);

    const stats = await pullRequestStats({ sampleLimit: 5 });

    expect(stats.sample).toHaveLength(1);
    expect(stats.sample[0]).toMatchObject({
      number: 88,
      author: 'alice',
      isMerged: true,
      state: 'MERGED',
    });
  });

  it('throws clearly when a date input is unparseable, before any Cypher runs', async () => {
    await expect(pullRequestStats({ since: 'not a date' })).rejects.toThrow(/since/);
    expect(db.queries, 'no query may run on invalid input').toEqual([]);
  });
});

function stubPr(number: number, over: Record<string, unknown> = {}) {
  return {
    id: `PR_${number}`,
    number,
    title: `PR ${number}`,
    url: `https://x/${number}`,
    state: 'OPEN',
    isDraft: false,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    closedAt: null,
    mergedAt: null,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    author: { login: 'alice' },
    ...over,
  };
}

describe('refreshAllPullRequests', () => {
  it('reads the current PullRequest count before fetching, so the dry run can report the gap', async () => {
    db.queueResult([{ n: neo4j.int(25) }]);
    fake.getPullRequests.mockResolvedValue([stubPr(1), stubPr(2)]);

    const r = await refreshAllPullRequests({ owner: 'o', repo: 'r', dryRun: true });

    expect(r.graphBefore).toBe(25);
    expect(r.fetched).toBe(2);
    expect(r.ingested).toBe(0);
    expect(fake.ingestPullRequests, 'a dry run must not write to the graph').not.toHaveBeenCalled();
    expect(
      fake.setLastPullRequestSyncTimestamp,
      'a dry run must not advance the sync timestamp',
    ).not.toHaveBeenCalled();
  });

  it('fetches every pull request without a since filter and without the issue debug cap', async () => {
    db.queueResult([{ n: neo4j.int(0) }]);
    fake.getPullRequests.mockResolvedValue([]);

    await refreshAllPullRequests({ owner: 'o', repo: 'r', dryRun: true });

    expect(fake.getPullRequests).toHaveBeenCalledWith('o', 'r', null, 0);
  });

  it('upserts the fetched pull requests on a non-dry run, then advances the sync timestamp', async () => {
    db.queueResult([{ n: neo4j.int(5) }]);
    fake.getPullRequests.mockResolvedValue([stubPr(10), stubPr(11), stubPr(12)]);
    fake.ingestPullRequests.mockResolvedValue({ ingested: 3, errors: [] });

    const r = await refreshAllPullRequests({ owner: 'o', repo: 'r' });

    expect(fake.ingestPullRequests).toHaveBeenCalledTimes(1);
    expect(fake.setLastPullRequestSyncTimestamp).toHaveBeenCalledTimes(1);
    expect(r.ingested).toBe(3);
    expect(r.fetched).toBe(3);
    expect(r.graphBefore).toBe(5);
  });

  it('carries ingest-time per-row errors through to the caller without failing the call', async () => {
    db.queueResult([{ n: neo4j.int(0) }]);
    fake.getPullRequests.mockResolvedValue([stubPr(1), stubPr(2)]);
    fake.ingestPullRequests.mockResolvedValue({
      ingested: 1,
      errors: [{ number: 2, error: 'constraint violation' }],
    });

    const r = await refreshAllPullRequests({ owner: 'o', repo: 'r' });

    expect(r.ingested).toBe(1);
    expect(r.errors).toEqual([{ number: 2, error: 'constraint violation' }]);
    expect(
      fake.setLastPullRequestSyncTimestamp,
      'the timestamp still advances even with a per-row failure',
    ).toHaveBeenCalledTimes(1);
  });

  it('passes a non-zero limit through to the fetch', async () => {
    db.queueResult([{ n: neo4j.int(0) }]);
    fake.getPullRequests.mockResolvedValue([]);

    await refreshAllPullRequests({ owner: 'o', repo: 'r', dryRun: true, limit: 50 });

    expect(fake.getPullRequests).toHaveBeenCalledWith('o', 'r', null, 50);
  });
});
