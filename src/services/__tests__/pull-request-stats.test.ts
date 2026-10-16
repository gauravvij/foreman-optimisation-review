import neo4j from 'neo4j-driver';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDriver } from './fake-driver';

const fake = vi.hoisted(() => ({
  ref: null as ReturnType<typeof import('./fake-driver').createFakeDriver> | null,
}));

vi.mock('../neo4j', () => ({ getDriver: () => fake.ref?.mockDriver }));

import { pullRequestStats } from '../pull-request-stats';

let db: ReturnType<typeof createFakeDriver>;

beforeEach(() => {
  db = createFakeDriver();
  fake.ref = db;
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
