import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// neo4j.ts builds its driver from the 'neo4j-driver' module, so the module is
// faked at the boundary. Statements are recorded, because what these tests care
// about is what is written and in which shape, not what comes back.
const h = vi.hoisted(() => {
  const state = {
    queries: [] as { query: string; params: Record<string, unknown>; viaTx: boolean }[],
    executeWriteCalls: 0,
    failExecuteWrite: false,
    failRun: (_query: string) => false,
    results: [] as { records: { get: (k: string) => unknown }[] }[],
  };
  const session = {
    run: vi.fn(async (query: string, params: Record<string, unknown> = {}) => {
      state.queries.push({ query, params, viaTx: false });
      if (state.failRun(query)) throw new Error(`constraint trouble: ${query.slice(0, 40)}`);
      return state.results.shift() ?? { records: [] };
    }),
    executeWrite: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
      state.executeWriteCalls++;
      if (state.failExecuteWrite) throw new Error('batch rejected');
      const tx = {
        run: async (query: string, params: Record<string, unknown> = {}) => {
          state.queries.push({ query, params, viaTx: true });
          return { records: [] };
        },
      };
      return work(tx);
    }),
    close: vi.fn(async () => {}),
  };
  const driver = { session: vi.fn(() => session), close: vi.fn(async () => {}) };
  return { state, session, driver };
});

vi.mock('neo4j-driver', () => ({
  default: {
    driver: () => h.driver,
    auth: { basic: () => ({}) },
    int: (n: number) => n,
  },
}));

import {
  type IssueData,
  closeDriver,
  getIssueUpdatedAtBatch,
  ingestBatchSize,
  ingestMultipleIssues,
  planIssueBatch,
  resetSchemaCache,
  setupDatabaseSchema,
} from '../neo4j';

function issue(
  n: number,
  opts: {
    author?: string | null;
    assignees?: string[];
    labels?: string[];
    reactions?: { content: string; login: string | null }[];
    comments?: {
      id: string;
      author?: string | null;
      reactions?: { content: string; login: string | null }[];
    }[];
  } = {},
): IssueData {
  const rx = (list: { content: string; login: string | null }[] = []) => ({
    nodes: list.map((r) => ({ content: r.content, user: r.login ? { login: r.login } : null })),
  });
  return {
    issue: {
      id: `I_${n}`,
      number: n,
      title: `Issue ${n}`,
      bodyText: '',
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-02T00:00:00Z',
      closedAt: null,
      state: 'OPEN',
      author: opts.author === null ? null : { login: opts.author ?? 'alice' },
      assignees: { nodes: (opts.assignees ?? []).map((login) => ({ login })) },
      labels: { nodes: (opts.labels ?? []).map((name) => ({ name })) },
      reactions: rx(opts.reactions),
      totalComments: opts.comments?.length ?? 0,
    },
    comments: (opts.comments ?? []).map((c) => ({
      id: c.id,
      bodyText: 'text',
      createdAt: '2026-09-01T01:00:00Z',
      author: c.author ? { login: c.author } : null,
      reactions: rx(c.reactions),
    })),
  } as unknown as IssueData;
}

const find = (stmts: { query: string }[], needle: string) =>
  stmts.findIndex((s) => s.query.includes(needle));

describe('planIssueBatch', () => {
  it('always writes the issues and always clears ASSIGNED_TO, and nothing else for a bare issue', () => {
    const stmts = planIssueBatch([issue(1, { author: null })]);

    expect(stmts).toHaveLength(2);
    expect(stmts[0]?.query).toContain('MERGE (i:Issue {issueId: iss.issueId})');
    expect(stmts[1]?.query).toContain('DELETE r');
    expect(stmts[1]?.params).toEqual({ issueIds: ['I_1'] });
  });

  it('collects users as author, then assignees, then comment authors, keeping duplicates', () => {
    const stmts = planIssueBatch([
      issue(1, {
        author: 'alice',
        assignees: ['bob', 'alice'],
        comments: [
          { id: 'C1', author: 'carol' },
          { id: 'C2', author: 'alice' },
        ],
      }),
    ]);

    const users = stmts[find(stmts, 'MERGE (u:User {login: user.login})')]?.params.users as {
      login: string;
    }[];
    // MERGE processes rows in order, so a repeated user is kept and the last
    // write wins, exactly as consecutive per-issue writes did.
    expect(users.map((u) => u.login)).toEqual(['alice', 'bob', 'alice', 'carol', 'alice']);
  });

  it('clears assignments before it re-creates them, so an unassignment takes effect', () => {
    const stmts = planIssueBatch([issue(1, { assignees: ['bob'] })]);

    const clear = find(stmts, 'DELETE r');
    const link = find(stmts, 'MERGE (i)-[:ASSIGNED_TO]->(u)');
    expect(clear).toBeGreaterThan(-1);
    expect(link).toBeGreaterThan(clear);
  });

  it('lists issue reactions before comment reactions, with commentId null on the issue ones', () => {
    const stmts = planIssueBatch([
      issue(1, {
        reactions: [{ content: 'HEART', login: 'bob' }],
        comments: [{ id: 'C1', author: 'carol', reactions: [{ content: 'EYES', login: 'dave' }] }],
      }),
    ]);

    const rows = stmts[find(stmts, 'MERGE (:Reaction')]?.params.reactions as {
      content: string;
      commentId: string | null;
    }[];
    expect(rows.map((r) => [r.content, r.commentId])).toEqual([
      ['HEART', null],
      ['EYES', 'C1'],
    ]);
    expect(stmts[find(stmts, 'MERGE (:Reaction')]?.query).toContain('commentId: reaction.commentId');
  });

  it('skips reactions that have no user, but still links by the raw node count', () => {
    const stmts = planIssueBatch([issue(1, { reactions: [{ content: 'HEART', login: null }] })]);

    expect(find(stmts, 'MERGE (r:Reaction')).toBe(-1);
    expect(find(stmts, 'MERGE (i)-[:HAS_REACTION]->(r)')).toBeGreaterThan(-1);
  });

  it('merges many issues into one statement per kind', () => {
    const stmts = planIssueBatch([
      issue(1, { labels: ['bug'], comments: [{ id: 'C1', author: 'x' }] }),
      issue(2, { labels: ['bug', 'docs'], comments: [{ id: 'C2', author: 'y' }] }),
    ]);

    expect((stmts[0]?.params.issues as unknown[]).length).toBe(2);
    const labels = stmts[find(stmts, 'MERGE (l:Label {name: label.name})')]?.params.labels;
    expect(labels).toHaveLength(3);
    const comments = stmts[find(stmts, 'MERGE (comment:Comment')]?.params.comments;
    expect(comments).toHaveLength(2);
    expect(stmts.filter((s) => s.query.includes('MERGE (comment:Comment'))).toHaveLength(1);
  });
});

describe('ingestBatchSize', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults to 250 and honours a valid override', () => {
    vi.stubEnv('NEO4J_INGEST_BATCH_SIZE', '');
    expect(ingestBatchSize()).toBe(250);
    vi.stubEnv('NEO4J_INGEST_BATCH_SIZE', '40');
    expect(ingestBatchSize()).toBe(40);
  });

  it('ignores zero, negative and non-numeric values', () => {
    for (const bad of ['0', '-1', 'x']) {
      vi.stubEnv('NEO4J_INGEST_BATCH_SIZE', bad);
      expect(ingestBatchSize(), `value "${bad}"`).toBe(250);
    }
  });
});

describe('ingestMultipleIssues', () => {
  beforeEach(async () => {
    await closeDriver();
    h.state.queries.length = 0;
    h.state.executeWriteCalls = 0;
    h.state.failExecuteWrite = false;
    h.state.failRun = () => false;
    h.state.results.length = 0;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('writes a whole batch in one managed transaction', async () => {
    const { results, errors } = await ingestMultipleIssues([issue(1), issue(2), issue(3)]);

    expect(errors).toEqual([]);
    expect(results).toHaveLength(3);
    expect(h.state.executeWriteCalls).toBe(1);
    expect(h.state.queries.every((q) => q.viaTx)).toBe(true);
  });

  it('starts a new transaction for each batch-size chunk', async () => {
    vi.stubEnv('NEO4J_INGEST_BATCH_SIZE', '2');
    await ingestMultipleIssues([issue(1), issue(2), issue(3), issue(4), issue(5)]);

    expect(h.state.executeWriteCalls).toBe(3);
  });

  it('falls back to writing issue by issue when a batch fails, and loses nothing', async () => {
    h.state.failExecuteWrite = true;
    const { results, errors } = await ingestMultipleIssues([issue(1), issue(2)]);

    expect(errors).toEqual([]);
    expect(results).toHaveLength(2);
    expect(h.state.queries.some((q) => !q.viaTx)).toBe(true);
  });

  it('attributes a failure to the issue that caused it when the fallback fails too', async () => {
    h.state.failExecuteWrite = true;
    h.state.failRun = () => true;
    const { results, errors } = await ingestMultipleIssues([issue(1), issue(2)]);

    expect(results).toEqual([]);
    expect(errors.map((e) => e.issueNumber)).toEqual([1, 2]);
  });
});

describe('setupDatabaseSchema', () => {
  beforeEach(async () => {
    await closeDriver();
    resetSchemaCache();
    h.state.queries.length = 0;
    h.state.failRun = () => false;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it('issues ten constraints and two indexes, all idempotent', async () => {
    const res = await setupDatabaseSchema();

    expect(res).toEqual({ ran: true, failures: [] });
    const stmts = h.state.queries.map((q) => q.query);
    expect(stmts.filter((s) => s.startsWith('CREATE CONSTRAINT'))).toHaveLength(10);
    expect(stmts.filter((s) => s.startsWith('CREATE INDEX'))).toHaveLength(2);
    expect(stmts.every((s) => s.includes('IF NOT EXISTS'))).toBe(true);
  });

  it('does nothing the second time in the same process', async () => {
    await setupDatabaseSchema();
    h.state.queries.length = 0;

    expect(await setupDatabaseSchema()).toEqual({ ran: false, failures: [] });
    expect(h.state.queries).toHaveLength(0);
  });

  it('collects a failed statement instead of throwing, and retries on the next call', async () => {
    h.state.failRun = (q) => q.includes('label_name_unique');
    const first = await setupDatabaseSchema();

    expect(first.ran).toBe(true);
    expect(first.failures).toHaveLength(1);
    expect(first.failures[0]?.statement).toContain('label_name_unique');

    h.state.failRun = () => false;
    h.state.queries.length = 0;
    const second = await setupDatabaseSchema();
    expect(second.ran).toBe(true);
    expect(second.failures).toEqual([]);
  });
});

describe('getIssueUpdatedAtBatch', () => {
  beforeEach(async () => {
    await closeDriver();
    h.state.queries.length = 0;
    h.state.results.length = 0;
  });

  it('issues no query for an empty list', async () => {
    expect((await getIssueUpdatedAtBatch([])).size).toBe(0);
    expect(h.state.queries).toHaveLength(0);
  });

  it('returns a map of issue number to stored updatedAt in a single statement', async () => {
    const row = (number: number, ts: string) => ({
      get: (k: string) => (k === 'number' ? number : ts),
    });
    h.state.results.push({ records: [row(1, 'T1'), row(2, 'T2')] });

    const map = await getIssueUpdatedAtBatch([1, 2, 3]);

    expect(h.state.queries).toHaveLength(1);
    expect(h.state.queries[0]?.params).toEqual({ numbers: [1, 2, 3] });
    expect(Object.fromEntries(map)).toEqual({ 1: 'T1', 2: 'T2' });
  });
});
