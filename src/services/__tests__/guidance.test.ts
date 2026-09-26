import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDriver } from './fake-driver';

const fake = vi.hoisted(() => ({
  ref: null as ReturnType<typeof import('./fake-driver').createFakeDriver> | null,
}));

vi.mock('../neo4j', () => ({ getDriver: () => fake.ref?.mockDriver }));

import {
  type Guidance,
  deleteGuidance,
  listGuidance,
  recordGuidance,
  renderGuidance,
} from '../guidance';

let db: ReturnType<typeof createFakeDriver>;

beforeEach(() => {
  db = createFakeDriver();
  fake.ref = db;
});

const g = (text: string): Guidance => ({
  id: text,
  text,
  recordedAt: '2026-09-13T00:00:00Z',
  recordedBy: 'user',
});

describe('renderGuidance', () => {
  it('returns an empty string when nothing is recorded', () => {
    expect(
      renderGuidance([]),
      'the classifier prompt must be byte-identical when there is no guidance',
    ).toBe('');
  });

  it('lists every instruction as a bullet', () => {
    const out = renderGuidance([g('Tooling is not ui-polish.'), g('Prefer docs over tooling.')]);

    expect(out).toContain('- Tooling is not ui-polish.');
    expect(out).toContain('- Prefer docs over tooling.');
  });

  it('tells the model the guidance outranks its own judgment', () => {
    expect(renderGuidance([g('x')])).toContain('Follow them over your own judgment');
  });
});

describe('recordGuidance', () => {
  it('derives a stable id so the same text re-recorded replaces rather than duplicates', async () => {
    db.queueEmpty();
    const first = await recordGuidance({ text: 'Tooling is not ui-polish.' });

    db.reset();
    db.queueEmpty();
    const again = await recordGuidance({ text: '  Tooling   is not ui-polish.  ' });

    expect(again.id, 'whitespace differences must not create a second note').toBe(first.id);
    expect(db.queries[0].query).toContain('MERGE (g:Guidance {id: $id})');
  });

  it('is case-insensitive when deriving the id', async () => {
    db.queueEmpty();
    const lower = await recordGuidance({ text: 'no ui polish in tooling' });
    db.reset();
    db.queueEmpty();
    const upper = await recordGuidance({ text: 'NO UI POLISH IN TOOLING' });

    expect(upper.id).toBe(lower.id);
  });

  it('stores the text as written, not the normalised id', async () => {
    db.queueEmpty();

    const rec = await recordGuidance({ text: 'Tooling is NOT ui-polish.' });

    expect(rec.text, "the user's wording is what the model should read").toBe(
      'Tooling is NOT ui-polish.',
    );
    expect(rec.id).not.toBe(rec.text);
  });

  it('rejects empty or whitespace-only text instead of storing a blank note', async () => {
    await expect(recordGuidance({ text: '   ' })).rejects.toThrow('empty');
    await expect(recordGuidance({ text: '' })).rejects.toThrow('empty');
    expect(db.queries).toHaveLength(0);
  });

  it('trims surrounding whitespace from the stored text', async () => {
    db.queueEmpty();
    const rec = await recordGuidance({ text: '  keep this  ' });
    expect(rec.text).toBe('keep this');
  });
});

describe('listGuidance', () => {
  it('returns the recorded instructions', async () => {
    db.queueResult([{ id: 'a', text: 'A', recordedAt: 't', recordedBy: 'user' }]);

    expect(await listGuidance()).toEqual([
      { id: 'a', text: 'A', recordedAt: 't', recordedBy: 'user' },
    ]);
  });

  it('is empty when nothing is recorded', async () => {
    db.queueEmpty();
    expect(await listGuidance()).toEqual([]);
  });
});

describe('deleteGuidance', () => {
  it('matches on the id or the full text, so a user can quote the note back', async () => {
    db.queueResult([{ n: 1 }]);

    await deleteGuidance('Tooling is not ui-polish.');

    expect(db.queries[0].query).toContain('g.id = $id OR g.text = $id');
  });

  it('reports false when nothing matched', async () => {
    db.queueResult([{ n: 0 }]);
    expect(await deleteGuidance('never recorded')).toBe(false);
  });
});
