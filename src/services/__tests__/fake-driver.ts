import { vi } from 'vitest';

/**
 * A fake Neo4j driver for unit tests.
 *
 * Records every statement and parameter map the code under test issues, because
 * for graph services the interesting behaviour is usually in the query rather
 * than the return value: that a write deletes before it creates, that a filter
 * is present, that a scope parameter is passed. Asserting only on returned
 * values would pass against code that queried the wrong thing.
 *
 * It does not execute Cypher, so it cannot catch an invalid statement. That
 * class of bug belongs to test/integration/cypher.test.ts, which runs against a
 * real server.
 */

export interface RecordedQuery {
  query: string;
  params: Record<string, unknown>;
}

/** A stand-in for a neo4j Record: `get(key)` over a plain object. */
export function fakeRecord(data: Record<string, unknown>) {
  return { keys: Object.keys(data), get: (key: string) => data[key] };
}

/** True when every needle appears in `text` in order; a missing needle is false, not "earlier". */
export function inOrder(text: string, ...needles: string[]): boolean {
  let at = -1;
  for (const needle of needles) {
    const i = text.indexOf(needle, at + 1);
    if (i === -1) return false;
    at = i;
  }
  return true;
}

export function createFakeDriver() {
  const queries: RecordedQuery[] = [];
  /** Results to return, in call order. A missing entry yields no records. */
  const results: { records: ReturnType<typeof fakeRecord>[] }[] = [];

  const mockSession = {
    run: vi.fn(async (query: string, params: Record<string, unknown> = {}) => {
      queries.push({ query, params });
      return results.shift() ?? { records: [] };
    }),
    close: vi.fn(async () => {}),
  };

  const mockDriver = { session: vi.fn(() => mockSession) };

  return {
    mockSession,
    mockDriver,
    queries,

    /** Queue the next `session.run` result. Call once per expected query. */
    queueResult(rows: Record<string, unknown>[]) {
      results.push({ records: rows.map(fakeRecord) });
    },

    /** Queue an empty result, for a query whose rows the code ignores. */
    queueEmpty() {
      results.push({ records: [] });
    },

    reset() {
      queries.length = 0;
      results.length = 0;
      mockSession.run.mockClear();
      mockSession.close.mockClear();
      mockDriver.session.mockClear();
    },

    /** Index of the first recorded query containing `needle`, or -1. */
    indexOf(needle: string) {
      return queries.findIndex((q) => q.query.includes(needle));
    },

    /** True when `before` was issued ahead of `after`; both must be present. */
    ranInOrder(before: string, after: string) {
      const a = this.indexOf(before);
      const b = this.indexOf(after);
      return a !== -1 && b !== -1 && a < b;
    },
  };
}
