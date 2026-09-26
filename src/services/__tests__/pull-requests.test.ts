import { describe, expect, it } from 'vitest';
import { type LinkedPullRequest, isShippedButOpen, summariseLinks } from '../pull-requests';

const pr = (over: Partial<LinkedPullRequest> = {}): LinkedPullRequest => ({
  number: 1,
  title: 'A change',
  url: 'https://github.com/acme/widgets/pull/1',
  state: 'OPEN',
  isDraft: false,
  reviewDecision: null,
  author: 'someone',
  updatedAt: '2026-09-13T00:00:00Z',
  closes: false,
  ...over,
});

describe('summariseLinks', () => {
  it('reports nothing for an issue with no linked pull request', () => {
    expect(summariseLinks([])).toEqual({
      hasOpenReadyPR: false,
      hasDraftPR: false,
      hasMergedPR: false,
      linkedCount: 0,
    });
  });

  it('separates a draft from one offered for review', () => {
    expect(summariseLinks([pr({ isDraft: true })]).hasDraftPR).toBe(true);
    expect(summariseLinks([pr({ isDraft: true })]).hasOpenReadyPR).toBe(false);
    expect(summariseLinks([pr()]).hasOpenReadyPR).toBe(true);
  });

  it('does not count a closed pull request as open', () => {
    const closed = summariseLinks([pr({ state: 'CLOSED' })]);

    expect(closed.hasOpenReadyPR, 'an abandoned PR is not work in flight').toBe(false);
    expect(closed.hasMergedPR).toBe(false);
    expect(closed.linkedCount, 'it is still a link worth reporting').toBe(1);
  });

  it('does not count a merged pull request as open', () => {
    const merged = summariseLinks([pr({ state: 'MERGED' })]);

    expect(merged.hasMergedPR).toBe(true);
    expect(merged.hasOpenReadyPR).toBe(false);
  });

  it('ignores the draft flag on a merged pull request', () => {
    // GitHub keeps isDraft on the record, so a stale flag must not read as open.
    const merged = summariseLinks([pr({ state: 'MERGED', isDraft: true })]);

    expect(merged.hasDraftPR).toBe(false);
  });

  it('reports every state when an issue has several pull requests', () => {
    const s = summariseLinks([
      pr({ number: 1, state: 'MERGED' }),
      pr({ number: 2, isDraft: true }),
      pr({ number: 3 }),
    ]);

    expect(s).toEqual({
      hasOpenReadyPR: true,
      hasDraftPR: true,
      hasMergedPR: true,
      linkedCount: 3,
    });
  });
});

describe('isShippedButOpen', () => {
  it('is true when the only pull request merged', () => {
    expect(isShippedButOpen(summariseLinks([pr({ state: 'MERGED' })]))).toBe(true);
  });

  it('is false while a pull request is still awaiting review', () => {
    const s = summariseLinks([pr({ number: 1, state: 'MERGED' }), pr({ number: 2 })]);

    expect(isShippedButOpen(s), 'follow-up work is still in flight').toBe(false);
  });

  it('is false while a draft pull request is still open', () => {
    const s = summariseLinks([
      pr({ number: 1, state: 'MERGED' }),
      pr({ number: 2, isDraft: true }),
    ]);

    expect(isShippedButOpen(s)).toBe(false);
  });

  it('is false when nothing merged', () => {
    expect(isShippedButOpen(summariseLinks([pr()]))).toBe(false);
    expect(isShippedButOpen(summariseLinks([]))).toBe(false);
  });

  it('is false for a pull request that was closed without merging', () => {
    expect(isShippedButOpen(summariseLinks([pr({ state: 'CLOSED' })]))).toBe(false);
  });
});
