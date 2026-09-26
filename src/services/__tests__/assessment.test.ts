import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDriver, inOrder } from './fake-driver';

const fake = vi.hoisted(() => ({
  ref: null as ReturnType<typeof import('./fake-driver').createFakeDriver> | null,
}));

vi.mock('../neo4j', () => ({ getDriver: () => fake.ref?.mockDriver }));

import { DECISIONS, isDecision, listAssessments, recordAssessment } from '../assessment';

let db: ReturnType<typeof createFakeDriver>;

beforeEach(() => {
  db = createFakeDriver();
  fake.ref = db;
});

describe('isDecision', () => {
  it('accepts every declared decision', () => {
    for (const d of DECISIONS) expect(isDecision(d)).toBe(true);
  });

  it('rejects anything else', () => {
    for (const v of ['maybe', 'should fix', 'SHOULD-FIX', '']) expect(isDecision(v)).toBe(false);
  });
});

describe('recordAssessment', () => {
  it('deletes the previous assessment before creating the new one', async () => {
    db.queueEmpty(); // existing lookup
    db.queueResult([{ n: 1 }]); // the write

    await recordAssessment({ issueNumbers: [1], decision: 'nice-to-have' });

    const write = db.queries[1].query;
    expect(
      inOrder(write, 'DETACH DELETE old', 'CREATE (i)-[:HAS_ASSESSMENT]'),
      'a stale decision competing with the current one is worse than losing history',
    ).toBe(true);
  });

  it('reports which issues already had a decision, so a replacement is visible', async () => {
    db.queueResult([{ d: 'should-fix' }]);
    db.queueResult([{ n: 1 }]);

    const r = await recordAssessment({ issueNumbers: [1], decision: 'nice-to-have' });

    expect(r.replaced).toEqual([1]);
    expect(r.recorded).toEqual([1]);
  });

  it('does not report a replacement when the issue had none', async () => {
    db.queueEmpty();
    db.queueResult([{ n: 1 }]);

    const r = await recordAssessment({ issueNumbers: [1], decision: 'should-fix' });

    expect(r.replaced).toEqual([]);
  });

  it('collects issues the graph does not hold instead of failing the batch', async () => {
    db.queueEmpty();
    db.queueEmpty(); // write matched nothing
    db.queueEmpty();
    db.queueResult([{ n: 2 }]);

    const r = await recordAssessment({ issueNumbers: [999, 2], decision: 'wont-fix' });

    expect(r.notFound).toEqual([999]);
    expect(r.recorded).toEqual([2]);
  });

  it('applies one decision across every issue given', async () => {
    for (let i = 0; i < 3; i++) {
      db.queueEmpty();
      db.queueResult([{ n: i }]);
    }

    const r = await recordAssessment({ issueNumbers: [1, 2, 3], decision: 'nice-to-have' });

    expect(r.recorded).toHaveLength(3);
    for (const q of db.queries.filter((x) => x.query.includes('CREATE'))) {
      expect(q.params.decision).toBe('nice-to-have');
    }
  });

  it('defaults the recorder to user and stamps a parseable time', async () => {
    db.queueEmpty();
    db.queueResult([{ n: 1 }]);

    await recordAssessment({ issueNumbers: [1], decision: 'should-fix' });

    const write = db.queries[1].params;
    expect(write.recordedBy).toBe('user');
    expect(Date.parse(write.recordedAt as string)).not.toBeNaN();
  });
});

describe('listAssessments', () => {
  it('returns every decision when unfiltered', async () => {
    db.queueResult([
      {
        number: 1,
        title: 'A',
        decision: 'nice-to-have',
        note: null,
        recordedAt: 't',
        recordedBy: 'user',
      },
    ]);

    const all = await listAssessments();

    expect(all).toEqual([
      {
        issueNumber: 1,
        title: 'A',
        decision: 'nice-to-have',
        note: null,
        recordedAt: 't',
        recordedBy: 'user',
      },
    ]);
    expect(db.queries[0].params.decision).toBeNull();
  });

  it('passes the filter through when given one', async () => {
    db.queueEmpty();

    await listAssessments('wont-fix');

    expect(db.queries[0].params.decision).toBe('wont-fix');
    expect(db.queries[0].query).toContain('$decision IS NULL OR a.decision = $decision');
  });
});
