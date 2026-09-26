/**
 * Progress reporting for the loops that take minutes.
 *
 * GitHub is written at roughly one request per second, so an apply of a few
 * hundred changes runs for minutes with nothing on the console between
 * "applying" and the summary. One line per step is the right volume there,
 * because the pace is already one per second. A loop that is not rate limited,
 * such as paginated reads, passes `every` to thin the output out.
 */

import { WRITE_INTERVAL_MS } from './http';

export interface Progress {
  /** Record a completed unit of work. */
  step(detail?: string): void;
  /** Record a failed unit. Always logged, however `every` is set. */
  fail(detail: string): void;
  /** Log the final tally and how long it took. */
  done(): void;
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/**
 * Rough wall clock for a throttled write loop, for a confirmation to quote.
 *
 * Stated before the user confirms, so a run that will sit apparently idle for
 * minutes says so first.
 */
export function estimateDuration(writes: number): string {
  const seconds = Math.round((writes * WRITE_INTERVAL_MS) / 1000);
  if (seconds < 45) return seconds === 1 ? 'about a second' : `about ${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  return minutes <= 1 ? 'about a minute' : `about ${minutes} minutes`;
}

export interface ProgressOptions {
  /** Log one line every N steps. Failures ignore this. Default 1. */
  every?: number;
  /** Injectable clock, so a test can assert the elapsed time it prints. */
  now?: () => number;
}

export function progress(label: string, total: number, opts: ProgressOptions = {}): Progress {
  const every = Math.max(1, opts.every ?? 1);
  const now = opts.now ?? Date.now;
  const started = now();
  let succeeded = 0;
  let failed = 0;

  const position = () => succeeded + failed;
  const percent = () => (total > 0 ? Math.round((position() / total) * 100) : 100);

  return {
    step(detail?: string) {
      succeeded++;
      // The last step always prints, so the log ends on the real total rather
      // than on whatever the stride last happened to land on.
      if (position() % every !== 0 && position() !== total) return;
      const suffix = detail ? ` ${detail}` : '';
      console.log(`  [${label}] ${position()}/${total} (${percent()}%)${suffix}`);
    },

    fail(detail: string) {
      failed++;
      console.warn(`  [${label}] ${position()}/${total} failed: ${detail}`);
    },

    done() {
      const elapsed = formatElapsed(now() - started);
      const tail = failed > 0 ? `, ${failed} failed` : '';
      console.log(`  [${label}] done ${succeeded}/${total} in ${elapsed}${tail}`);
    },
  };
}
