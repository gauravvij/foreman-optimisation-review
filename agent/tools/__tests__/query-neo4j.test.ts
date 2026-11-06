import neo4j from 'neo4j-driver';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSession, mockDriver } = vi.hoisted(() => {
  const mockSession = {
    run: vi.fn(),
    close: vi.fn(),
  };
  const mockDriver = {
    session: vi.fn(() => mockSession),
  };
  return { mockSession, mockDriver };
});

vi.mock('../../../src/services/neo4j', () => ({
  getDriver: vi.fn(() => mockDriver),
}));

import { queryNeo4jTool } from '../query-neo4j';

type QueryResult = {
  rows: Record<string, unknown>[];
  count: number;
  error?: string;
  warnings?: string[];
};

const ctx = {} as Parameters<NonNullable<typeof queryNeo4jTool.execute>>[1];

beforeEach(() => {
  vi.clearAllMocks();
});

function fakeRecord(data: Record<string, unknown>) {
  const keys = Object.keys(data);
  return {
    keys,
    get: (key: string) => data[key],
  };
}

describe('queryNeo4jTool', () => {
  it('returns rows and count from a successful query', async () => {
    mockSession.run.mockResolvedValueOnce({
      records: [
        fakeRecord({ name: 'bug', count: neo4j.int(42) }),
        fakeRecord({ name: 'feature', count: neo4j.int(10) }),
      ],
    });

    const result = (await queryNeo4jTool.execute!(
      { cypher: 'MATCH (l:Label) RETURN l.name AS name, count(*) AS count LIMIT 5' },
      ctx,
    )) as QueryResult;

    expect(result).toEqual({
      rows: [
        { name: 'bug', count: 42 },
        { name: 'feature', count: 10 },
      ],
      count: 2,
    });
    expect(mockSession.run).toHaveBeenCalledWith(
      'MATCH (l:Label) RETURN l.name AS name, count(*) AS count LIMIT 5',
    );
  });

  it('converts neo4j integers to numbers', async () => {
    mockSession.run.mockResolvedValueOnce({
      records: [fakeRecord({ total: neo4j.int(999) })],
    });

    const result = (await queryNeo4jTool.execute!(
      { cypher: 'RETURN 999 AS total' },
      ctx,
    )) as QueryResult;

    expect(result.rows[0].total).toBe(999);
    expect(typeof result.rows[0].total).toBe('number');
  });

  it('returns empty rows on Cypher error', async () => {
    mockSession.run.mockRejectedValueOnce(new Error('Invalid Cypher syntax'));

    const result = (await queryNeo4jTool.execute!({ cypher: 'INVALID QUERY' }, ctx)) as QueryResult;

    expect(result).toEqual({
      rows: [],
      count: 0,
      error: 'Invalid Cypher syntax',
    });
  });

  it('always closes the session', async () => {
    mockSession.run.mockRejectedValueOnce(new Error('fail'));

    await queryNeo4jTool.execute!({ cypher: 'FAIL' }, ctx);

    expect(mockSession.close).toHaveBeenCalledTimes(1);
  });

  it('returns empty rows when query has no results', async () => {
    mockSession.run.mockResolvedValueOnce({ records: [] });

    const result = (await queryNeo4jTool.execute!(
      { cypher: 'MATCH (n:Nothing) RETURN n LIMIT 5' },
      ctx,
    )) as QueryResult;

    expect(result).toEqual({ rows: [], count: 0 });
  });
});

/**
 * The guard is additive: it must not rewrite the query, and it must not change
 * rows, count or error. These assert the parity directly, so the guard cannot
 * quietly become a transformation.
 */
describe('queryNeo4jTool — the schema guard changes nothing but warnings', () => {
  const CLEAN = 'MATCH (i:Issue)-[:HAS_COMMENT]->(c:Comment) RETURN c.commentId LIMIT 5';
  const REVERSED = 'MATCH (c:Comment)<-[:AUTHORED_BY]-(u:User) RETURN u.login LIMIT 5';

  it('runs the query exactly as written, with or without a warning', async () => {
    mockSession.run.mockResolvedValue({ records: [] });

    await queryNeo4jTool.execute!({ cypher: CLEAN }, ctx);
    await queryNeo4jTool.execute!({ cypher: REVERSED }, ctx);

    expect(mockSession.run).toHaveBeenNthCalledWith(1, CLEAN);
    expect(mockSession.run).toHaveBeenNthCalledWith(2, REVERSED);
  });

  it('adds no warnings key for a schema-clean query', async () => {
    mockSession.run.mockResolvedValueOnce({
      records: [fakeRecord({ commentId: 'c1' })],
    });

    const result = (await queryNeo4jTool.execute!({ cypher: CLEAN }, ctx)) as QueryResult;

    expect(result).toEqual({ rows: [{ commentId: 'c1' }], count: 1 });
    expect('warnings' in result).toBe(false);
  });

  it('keeps rows and count identical when it does warn', async () => {
    const records = [fakeRecord({ login: 'asmeurer' })];
    mockSession.run.mockResolvedValueOnce({ records });
    mockSession.run.mockResolvedValueOnce({ records });

    const clean = (await queryNeo4jTool.execute!({ cypher: CLEAN }, ctx)) as QueryResult;
    const warned = (await queryNeo4jTool.execute!({ cypher: REVERSED }, ctx)) as QueryResult;

    // The warned run carries a warning, but the payload the agent consumes is
    // byte-identical to the clean run.
    expect(warned.warnings?.length).toBeGreaterThan(0);
    const { warnings: _warnings, ...rest } = warned;
    expect(rest).toEqual(clean);
    expect(rest).toEqual({ rows: [{ login: 'asmeurer' }], count: 1 });
  });

  it('leaves the error path untouched for a schema-clean failing query', async () => {
    mockSession.run.mockRejectedValueOnce(new Error('boom'));

    const result = (await queryNeo4jTool.execute!(
      { cypher: 'MATCH (i:Issue) RETURN i LIMIT 5' },
      ctx,
    )) as QueryResult;

    expect(result).toEqual({ rows: [], count: 0, error: 'boom' });
  });

  it('still reports the error, plus the warning, when both apply', async () => {
    mockSession.run.mockRejectedValueOnce(new Error('boom'));

    const result = (await queryNeo4jTool.execute!({ cypher: REVERSED }, ctx)) as QueryResult;

    expect(result.rows).toEqual([]);
    expect(result.count).toBe(0);
    expect(result.error).toBe('boom');
    expect(result.warnings?.length).toBeGreaterThan(0);
  });

  it('does not throw when the guard cannot parse the query', async () => {
    mockSession.run.mockResolvedValueOnce({ records: [] });

    const result = (await queryNeo4jTool.execute!(
      { cypher: 'this is not cypher ###' },
      ctx,
    )) as QueryResult;

    expect(result).toEqual({ rows: [], count: 0 });
  });
});
