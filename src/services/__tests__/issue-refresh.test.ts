import { describe, expect, it } from 'vitest';
import { findStale } from '../issue-refresh';

const live = (entries: [number, string][]) => new Map(entries);

describe('findStale', () => {
  it('flags an issue whose content changed on GitHub after it was ingested', () => {
    const stale = findStale(
      [{ number: 1584, updatedAt: '2026-07-08T18:18:18Z' }],
      live([[1584, '2026-09-13T01:14:50Z']]),
    );

    expect(stale).toEqual([
      {
        number: 1584,
        storedUpdatedAt: '2026-07-08T18:18:18Z',
        liveUpdatedAt: '2026-09-13T01:14:50Z',
      },
    ]);
  });

  it('ignores an issue whose timestamp matches', () => {
    expect(findStale([{ number: 1, updatedAt: 't' }], live([[1, 't']]))).toEqual([]);
  });

  it('treats a null stored timestamp as stale rather than skipping it', () => {
    const stale = findStale([{ number: 1, updatedAt: null }], live([[1, 't']]));

    expect(stale, 'an issue ingested before updatedAt was stored must still refresh').toHaveLength(
      1,
    );
    expect(stale[0].storedUpdatedAt).toBeNull();
  });

  it('ignores an issue GitHub did not resolve rather than guessing it changed', () => {
    const stale = findStale(
      [
        { number: 1, updatedAt: 'a' },
        { number: 999, updatedAt: 'a' },
      ],
      live([[1, 'a']]),
    );

    expect(stale, 'a failed lookup is not evidence of a change').toEqual([]);
  });

  it('picks out only the drifting rows from a mixed set', () => {
    const stale = findStale(
      [
        { number: 1, updatedAt: 'a' },
        { number: 2, updatedAt: 'a' },
        { number: 3, updatedAt: 'a' },
      ],
      live([
        [1, 'a'],
        [2, 'b'],
        [3, 'a'],
      ]),
    );

    expect(stale.map((s) => s.number)).toEqual([2]);
  });

  it('is empty for an empty graph', () => {
    expect(findStale([], live([[1, 'a']]))).toEqual([]);
  });

  it('detects a timestamp that moved backwards, not just forwards', () => {
    // Any difference is a signal to re-read; ordering is not the contract.
    const stale = findStale([{ number: 1, updatedAt: 'z' }], live([[1, 'a']]));

    expect(stale).toHaveLength(1);
  });
});
