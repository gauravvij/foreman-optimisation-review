import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDriver } from './fake-driver';

const fake = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return { ref: null as ReturnType<typeof import('./fake-driver').createFakeDriver> | null };
});

vi.mock('../neo4j', () => ({
  getDriver: () => fake.ref?.mockDriver,
}));

import {
  applyCategoryRules,
  deleteCategoryRule,
  listCategoryRules,
  recordCategoryRule,
} from '../rules';

let db: ReturnType<typeof createFakeDriver>;

beforeEach(() => {
  db = createFakeDriver();
  fake.ref = db;
});

describe('recordCategoryRule', () => {
  it('MERGEs on the label so re-recording replaces rather than adding a second rule', async () => {
    db.queueEmpty();

    await recordCategoryRule({ label: 'infra-team', category: 'infra' });

    const q = db.queries[0].query;
    expect(q, 'two rules for one label would make the outcome order-dependent').toContain(
      "MERGE (r:Rule {kind: 'category', label: $label})",
    );
    expect(q).toContain('SET r.category = $category');
    expect(db.queries[0].params).toMatchObject({ label: 'infra-team', category: 'infra' });
  });

  it('stamps who recorded it and when', async () => {
    db.queueEmpty();

    const rule = await recordCategoryRule({ label: 'x', category: 'docs', recordedBy: 'alice' });

    expect(rule.recordedBy).toBe('alice');
    expect(Date.parse(rule.recordedAt)).not.toBeNaN();
  });

  it('defaults the note to null rather than an empty string', async () => {
    db.queueEmpty();

    const rule = await recordCategoryRule({ label: 'x', category: 'docs' });

    expect(rule.note).toBeNull();
    expect(db.queries[0].params.note).toBeNull();
  });
});

describe('applyCategoryRules', () => {
  it('skips issues already in the rule’s category, so a re-run is a no-op', async () => {
    db.queueEmpty();

    await applyCategoryRules();

    expect(
      db.queries[0].query,
      'without this guard every run would rewrite every matching issue',
    ).toContain('i.category <> r.category');
  });

  it('records which rule set the category, so the agent can explain itself', async () => {
    db.queueEmpty();

    await applyCategoryRules();

    expect(db.queries[0].query).toContain("i.categorySource = 'rule:' + r.label");
  });

  it('scopes to the given issues when the pipeline passes a subset', async () => {
    db.queueEmpty();

    await applyCategoryRules([1, 2, 3]);

    expect(db.queries[0].query).toContain('$numbers IS NULL OR i.number IN $numbers');
    expect(db.queries[0].params.numbers).toEqual([1, 2, 3]);
  });

  it('passes null for an unscoped run so the filter matches everything', async () => {
    db.queueEmpty();

    await applyCategoryRules();

    expect(db.queries[0].params.numbers).toBeNull();
  });

  it('returns only the issues it actually changed', async () => {
    db.queueResult([
      { number: 7, previous: 'frontend', category: 'tooling', label: 'build' },
      { number: 9, previous: null, category: 'tooling', label: 'build' },
    ]);

    const changed = await applyCategoryRules();

    expect(changed).toEqual([
      { issueNumber: 7, from: 'frontend', to: 'tooling', label: 'build' },
      { issueNumber: 9, from: null, to: 'tooling', label: 'build' },
    ]);
  });

  it('reports nothing when no issue needed changing', async () => {
    db.queueEmpty();

    expect(await applyCategoryRules()).toEqual([]);
  });

  it('joins rules to issues through the label, not the category name', async () => {
    db.queueEmpty();

    await applyCategoryRules();

    expect(
      db.queries[0].query,
      'a rule keys off a GitHub label; matching on category would be circular',
    ).toContain('MATCH (i:Issue)-[:HAS_LABEL]->(l:Label {name: r.label})');
  });
});

describe('listCategoryRules', () => {
  it('returns the recorded rules', async () => {
    db.queueResult([
      { label: 'build', category: 'tooling', note: 'CI work', recordedAt: 't', recordedBy: 'u' },
    ]);

    const rules = await listCategoryRules();

    expect(rules).toEqual([
      { label: 'build', category: 'tooling', note: 'CI work', recordedAt: 't', recordedBy: 'u' },
    ]);
  });

  it('is empty when nothing is recorded', async () => {
    db.queueEmpty();
    expect(await listCategoryRules()).toEqual([]);
  });
});

describe('deleteCategoryRule', () => {
  it('reports true when a rule was removed', async () => {
    db.queueResult([{ n: 1 }]);
    expect(await deleteCategoryRule('build')).toBe(true);
  });

  it('reports false when no rule existed for that label', async () => {
    db.queueResult([{ n: 0 }]);
    expect(await deleteCategoryRule('nope')).toBe(false);
  });

  it('deletes only the rule, never the issues carrying the label', async () => {
    db.queueResult([{ n: 1 }]);

    await deleteCategoryRule('build');

    expect(db.queries[0].query).toContain(
      "MATCH (r:Rule {kind: 'category', label: $label}) DELETE r",
    );
    expect(db.queries[0].query).not.toContain(':Issue');
  });
});

describe('session handling', () => {
  it('closes the session on every path', async () => {
    db.queueEmpty();
    await listCategoryRules();
    expect(db.mockSession.close).toHaveBeenCalledTimes(1);
  });

  it('closes the session even when the query fails', async () => {
    db.mockSession.run.mockRejectedValueOnce(new Error('connection lost'));

    await expect(listCategoryRules()).rejects.toThrow('connection lost');
    expect(db.mockSession.close).toHaveBeenCalledTimes(1);
  });
});
