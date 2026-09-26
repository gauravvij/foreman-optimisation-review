import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDriver } from './fake-driver';

const fake = vi.hoisted(() => ({
  ref: null as ReturnType<typeof import('./fake-driver').createFakeDriver> | null,
  structuredCompletion: vi.fn(),
  listGuidance: vi.fn(),
}));

vi.mock('../neo4j', () => ({ getDriver: () => fake.ref?.mockDriver }));
vi.mock('../models', () => ({ structuredCompletion: fake.structuredCompletion }));
vi.mock('../guidance', () => ({
  listGuidance: fake.listGuidance,
  renderGuidance: (g: unknown[]) => (g.length === 0 ? '' : '\n\nSTANDING NOTES'),
}));

import { backfillIssueTypes, findUntyped } from '../issue-type';

let db: ReturnType<typeof createFakeDriver>;

const judgment = (over = {}) => ({
  data: { issueType: 'bug', needsClarification: false, clarificationReason: '', ...over },
  tokenUsage: {},
});

beforeEach(() => {
  db = createFakeDriver();
  fake.ref = db;
  vi.clearAllMocks();
  fake.listGuidance.mockResolvedValue([]);
});

describe('findUntyped', () => {
  it('asks only for open issues that carry no kind', async () => {
    db.queueEmpty();

    await findUntyped();

    expect(db.queries[0].query).toContain("i.state = 'OPEN'");
    expect(db.queries[0].query).toContain('i.issueType IS NULL');
  });

  it('scopes to an explicit issue list when given one', async () => {
    db.queueEmpty();

    await findUntyped([1, 2]);

    expect(db.queries[0].params.numbers).toEqual([1, 2]);
  });

  it('passes null rather than an empty list, so the filter is skipped', async () => {
    db.queueEmpty();

    await findUntyped([]);

    expect(db.queries[0].params.numbers).toBeNull();
  });

  it('defaults a missing title or body to an empty string', async () => {
    db.queueResult([{ number: 1, title: null, body: null }]);

    expect(await findUntyped()).toEqual([{ number: 1, title: '', body: '' }]);
  });
});

describe('backfillIssueTypes', () => {
  it('spends no model call during a dry run', async () => {
    db.queueResult([{ number: 1, title: 'A', body: 'b' }]);

    const r = await backfillIssueTypes({ dryRun: true });

    expect(fake.structuredCompletion, 'a dry run must be free').not.toHaveBeenCalled();
    expect(r.missing).toEqual([1]);
    expect(r.classified).toEqual([]);
  });

  it('classifies and stores each issue in the batch', async () => {
    db.queueResult([{ number: 1, title: 'A', body: 'b' }]);
    db.queueEmpty();
    fake.structuredCompletion.mockResolvedValue(judgment({ issueType: 'feature' }));

    const r = await backfillIssueTypes({ dryRun: false });

    expect(r.classified).toEqual([{ number: 1, issueType: 'feature', needsClarification: false }]);
    const write = db.queries.find((q) => q.query.includes('SET i.issueType'));
    expect(write?.params).toMatchObject({ n: 1, issueType: 'feature', needsClarification: false });
  });

  it('reports how many are left when the batch is capped', async () => {
    db.queueResult([1, 2, 3].map((n) => ({ number: n, title: 'A', body: 'b' })));
    db.queueEmpty();
    fake.structuredCompletion.mockResolvedValue(judgment());

    const r = await backfillIssueTypes({ dryRun: false, limit: 1 });

    expect(r.classified).toHaveLength(1);
    expect(r.remaining, 'a silent cap reads as "covered everything"').toBe(2);
  });

  it('stores an empty clarification reason as null rather than a blank string', async () => {
    db.queueResult([{ number: 1, title: 'A', body: 'b' }]);
    db.queueEmpty();
    fake.structuredCompletion.mockResolvedValue(judgment({ clarificationReason: '' }));

    await backfillIssueTypes({ dryRun: false });

    const write = db.queries.find((q) => q.query.includes('SET i.issueType'));
    expect(write?.params.clarificationReason).toBeNull();
  });

  it('keeps the reason when the issue does need clarification', async () => {
    db.queueResult([{ number: 1, title: 'A', body: 'b' }]);
    db.queueEmpty();
    fake.structuredCompletion.mockResolvedValue(
      judgment({ needsClarification: true, clarificationReason: 'no repro steps' }),
    );

    await backfillIssueTypes({ dryRun: false });

    const write = db.queries.find((q) => q.query.includes('SET i.issueType'));
    expect(write?.params).toMatchObject({
      needsClarification: true,
      clarificationReason: 'no repro steps',
    });
  });

  it('gives the classifier the standing guidance', async () => {
    db.queueResult([{ number: 1, title: 'A', body: 'b' }]);
    db.queueEmpty();
    fake.listGuidance.mockResolvedValue([{ text: 'x' }]);
    fake.structuredCompletion.mockResolvedValue(judgment());

    await backfillIssueTypes({ dryRun: false });

    expect(fake.structuredCompletion.mock.calls[0][0].prompt).toContain('STANDING NOTES');
  });

  it('collects a failure and keeps going through the batch', async () => {
    db.queueResult([
      { number: 1, title: 'A', body: 'b' },
      { number: 2, title: 'B', body: 'c' },
    ]);
    db.queueEmpty();
    fake.structuredCompletion
      .mockRejectedValueOnce(new Error('gateway 502'))
      .mockResolvedValueOnce(judgment());

    const r = await backfillIssueTypes({ dryRun: false });

    expect(r.errors[0]).toContain('#1');
    expect(
      r.classified.map((c) => c.number),
      'one bad issue must not sink the batch',
    ).toEqual([2]);
  });

  it('does nothing when every issue already has a kind', async () => {
    db.queueEmpty();

    const r = await backfillIssueTypes({ dryRun: false });

    expect(fake.structuredCompletion).not.toHaveBeenCalled();
    expect(r.missing).toEqual([]);
  });

  it('truncates a very long body rather than sending the whole thing', async () => {
    db.queueResult([{ number: 1, title: 'A', body: 'x'.repeat(20000) }]);
    db.queueEmpty();
    fake.structuredCompletion.mockResolvedValue(judgment());

    await backfillIssueTypes({ dryRun: false });

    expect(fake.structuredCompletion.mock.calls[0][0].prompt.length).toBeLessThan(8000);
  });
});
