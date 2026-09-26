import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { estimateDuration, formatElapsed, progress } from '../progress';

let logs: string[];
let warns: string[];

beforeEach(() => {
  logs = [];
  warns = [];
  vi.spyOn(console, 'log').mockImplementation((m: string) => void logs.push(m));
  vi.spyOn(console, 'warn').mockImplementation((m: string) => void warns.push(m));
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A clock the caller advances, so elapsed output is deterministic. */
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('formatElapsed', () => {
  it('reports seconds under a minute', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(8_400)).toBe('8s');
    expect(formatElapsed(59_000)).toBe('59s');
  });

  it('reports minutes and zero-padded seconds above a minute', () => {
    expect(formatElapsed(60_000)).toBe('1m 00s');
    expect(formatElapsed(378_000)).toBe('6m 18s');
  });

  it('does not print a negative elapsed time', () => {
    expect(formatElapsed(-5_000)).toBe('0s');
  });
});

describe('estimateDuration', () => {
  it('quotes seconds for a short run', () => {
    expect(estimateDuration(25)).toBe('about 25 seconds');
  });

  it('rounds to minutes for a long run', () => {
    expect(estimateDuration(377)).toBe('about 6 minutes');
  });

  it('reads naturally at the singular boundary', () => {
    expect(estimateDuration(60)).toBe('about a minute');
  });

  it('says nothing takes no time', () => {
    expect(estimateDuration(0)).toBe('about 0 seconds');
  });

  it('reads naturally at the singular second', () => {
    expect(estimateDuration(1)).toBe('about a second');
  });
});

describe('progress', () => {
  it('reports position, total, and percent for each step', () => {
    const p = progress('applyBoardSync', 4);

    p.step('#1370 Status -> In review');

    expect(logs[0]).toBe('  [applyBoardSync] 1/4 (25%) #1370 Status -> In review');
  });

  it('omits the detail when none is given', () => {
    progress('sync', 2).step();

    expect(logs[0]).toBe('  [sync] 1/2 (50%)');
  });

  it('thins the output to every Nth step when asked', () => {
    const p = progress('fetch', 10, { every: 5 });

    for (let i = 0; i < 10; i++) p.step();

    expect(logs.map((l) => l.slice(l.indexOf(']') + 2))).toEqual(['5/10 (50%)', '10/10 (100%)']);
  });

  it('always prints the last step, whatever the stride', () => {
    const p = progress('fetch', 7, { every: 5 });

    for (let i = 0; i < 7; i++) p.step();

    expect(
      logs[logs.length - 1],
      'a log ending at 5/7 reads as a run that stopped early',
    ).toContain('7/7 (100%)');
  });

  it('logs a failure immediately, however the stride is set', () => {
    const p = progress('sync', 100, { every: 50 });

    p.fail('#1404: HTTP 403');

    expect(warns[0]).toBe('  [sync] 1/100 failed: #1404: HTTP 403');
    expect(logs, 'a failure is not a step').toEqual([]);
  });

  it('counts a failure toward the position, so progress does not stall', () => {
    const p = progress('sync', 3);

    p.fail('boom');
    p.step();

    expect(logs[0]).toContain('2/3');
  });

  it('reports the elapsed time and the successful count on done', () => {
    const clock = fakeClock();
    const p = progress('applyBoardSync', 2, { now: clock.now });

    p.step();
    clock.advance(378_000);
    p.step();
    p.done();

    expect(logs[logs.length - 1]).toBe('  [applyBoardSync] done 2/2 in 6m 18s');
  });

  it('names the failure count on done so a partial run is not read as clean', () => {
    const clock = fakeClock();
    const p = progress('sync', 3, { now: clock.now });

    p.step();
    p.fail('boom');
    clock.advance(2_000);
    p.done();

    expect(logs[logs.length - 1]).toBe('  [sync] done 1/3 in 2s, 1 failed');
  });

  it('does not divide by zero when there is nothing to do', () => {
    const p = progress('sync', 0);

    p.done();

    expect(logs[0]).toContain('done 0/0');
  });

  it('treats a stride below one as every step', () => {
    const p = progress('sync', 2, { every: 0 });

    p.step();

    expect(logs).toHaveLength(1);
  });
});
