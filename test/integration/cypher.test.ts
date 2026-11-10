/**
 * Executes every Cypher query the services issue against a real Neo4j.
 *
 * The mocked-driver unit tests hand back canned records without parsing the
 * query, so an invalid statement passes them. Only a real server rejects it:
 * `fetchIssueTitles` shipped with an `ORDER BY` on a pre-aggregation variable
 * and every unit test still passed.
 */

import { Neo4jContainer, type StartedNeo4jContainer } from '@testcontainers/neo4j';
import neo4j, { type Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let container: StartedNeo4jContainer;
let driver: Driver;

beforeAll(async () => {
  container = await new Neo4jContainer('neo4j:5').start();

  process.env.NEO4J_URI = container.getBoltUri();
  process.env.NEO4J_AUTH = 'basic';
  process.env.NEO4J_USERNAME = container.getUsername();
  process.env.NEO4J_PASSWORD = container.getPassword();

  driver = neo4j.driver(
    container.getBoltUri(),
    neo4j.auth.basic(container.getUsername(), container.getPassword()),
  );

  const session = driver.session();
  try {
    await session.run(
      `CREATE (a:Issue {number: 1, issueId: 'A', title: 'cli crashes on second run',
                        state: 'OPEN', category: 'cli', subcategory: 'bug-fixes',
                        severity: 'high', impact: 'broad', effort: 'small', priorityScore: 90,
                        priorityRationale: 'blocks local dev'})
       CREATE (b:Issue {number: 2, issueId: 'B', title: 'document the deploy flow',
                        state: 'OPEN', category: 'docs', subcategory: 'documentation-updates',
                        severity: 'low', impact: 'narrow', effort: 'small', priorityScore: 30,
                        priorityRationale: 'nice to have'})
       CREATE (c:Issue {number: 3, issueId: 'C', title: 'unclassified issue', state: 'OPEN'})
       CREATE (l1:Label {name: 'cli'})
       CREATE (l2:Label {name: 'enhancement'})
       CREATE (a)-[:HAS_LABEL]->(l1)
       CREATE (a)-[:HAS_LABEL]->(l2)`,
    );
  } finally {
    await session.close();
  }
}, 180_000);

afterAll(async () => {
  const { closeDriver } = await import('../../src/services/neo4j');
  await closeDriver();
  await driver?.close();
  await container?.stop();
});

describe('subcategory vocabulary queries', () => {
  it('fetches issue titles with their labels, ordered', async () => {
    const { ensureVocabulary } = await import('../../src/services/subcategory');

    // Two issues is below the derivation floor, so this exercises the title
    // query and returns without calling the model.
    const terms = await ensureVocabulary(false, new Date(0).toISOString());

    expect(terms, 'a small corpus must not invent a vocabulary').toEqual([]);
  });

  it('round-trips a persisted vocabulary', async () => {
    const { loadVocabulary, saveVocabulary } = await import('../../src/services/subcategory');
    const session = driver.session();
    try {
      await saveVocabulary(
        session,
        [
          { name: 'error-handling', definition: 'failures surfaced badly' },
          { name: 'feature-request', definition: 'net new capability' },
        ],
        '2026-09-12T00:00:00Z',
      );

      const loaded = await loadVocabulary(session);
      expect(loaded.map((t) => t.name)).toEqual(['error-handling', 'feature-request']);
      expect(loaded[0].definition).toBe('failures surfaced badly');
    } finally {
      await session.close();
    }
  });

  it('replaces the previous vocabulary rather than accumulating terms', async () => {
    const { loadVocabulary, saveVocabulary } = await import('../../src/services/subcategory');
    const session = driver.session();
    try {
      await saveVocabulary(
        session,
        [{ name: 'only-term', definition: 'x' }],
        '2026-09-12T00:00:00Z',
      );

      const loaded = await loadVocabulary(session);
      expect(
        loaded.map((t) => t.name),
        'a refresh must not leave stale terms',
      ).toEqual(['only-term']);
    } finally {
      await session.close();
    }
  });
});

describe('label sync queries', () => {
  it('builds desired labels from the classification, skipping unclassified issues', async () => {
    const { loadDesiredLabels } = await import('../../src/services/github-labels');

    const desired = await loadDesiredLabels();
    const byNumber = new Map(desired.map((d) => [d.number, d.labels]));

    expect(byNumber.get(1)).toEqual(['area/cli', 'type/bug-fixes']);
    expect(byNumber.get(2)).toEqual(['area/docs', 'type/documentation-updates']);
    expect(byNumber.has(3), 'issue 3 has no category, so it must be skipped').toBe(false);
    expect(
      desired.flatMap((d) => d.labels).some((l) => l.startsWith('priority/')),
      'priority moved to the board field, so no priority label is derived',
    ).toBe(false);
  });
});

describe('prioritizeIssues query', () => {
  it('returns classified issues ranked by score', async () => {
    const { prioritizeIssuesTool } = await import('../../agent/tools/prioritize-issues');

    const result = (await prioritizeIssuesTool.execute!(
      { limit: 10, groupByCategory: false },
      {} as never,
    )) as {
      issues: { number: number; priorityScore: number }[];
      total: number;
      error?: string;
    };

    expect(result.error, 'the query must be valid Cypher').toBeUndefined();
    expect(result.issues.map((i) => i.number)).toEqual([1, 2]);
    expect(result.total, 'the unclassified issue is filtered out').toBe(2);
  });

  it('filters to a single category', async () => {
    const { prioritizeIssuesTool } = await import('../../agent/tools/prioritize-issues');

    const result = (await prioritizeIssuesTool.execute!(
      { category: 'docs', limit: 10, groupByCategory: false },
      {} as never,
    )) as { issues: { number: number }[]; error?: string };

    expect(result.error).toBeUndefined();
    expect(result.issues.map((i) => i.number)).toEqual([2]);
  });

  it('groups by category', async () => {
    const { prioritizeIssuesTool } = await import('../../agent/tools/prioritize-issues');

    const result = (await prioritizeIssuesTool.execute!(
      { limit: 10, groupByCategory: true },
      {} as never,
    )) as { groups?: { category: string; count: number }[]; error?: string };

    expect(result.error).toBeUndefined();
    expect(result.groups?.map((g) => g.category).sort()).toEqual(['cli', 'docs']);
  });
});

/**
 * The #1776 silent data-loss defect, against a real server.
 *
 * The mocked-driver unit tests can only assert the shape of the statement. Only
 * Neo4j can confirm that the old statement was rejected outright when the model
 * omitted `source`, and that the replacement writes the node and attaches it.
 *
 * Issue 1776 is created inside this block rather than in the shared fixture, so
 * the classification it receives cannot leak into the queries asserted above.
 */
describe('analysis ingestion when the model omits a comment source', () => {
  const ISSUE = 1776;

  beforeAll(async () => {
    const session = driver.session();
    try {
      await session.run(
        `MERGE (i:Issue {number: $n, issueId: 'I_1776', title: 'preprocess on the fly', state: 'OPEN'})
         MERGE (c:Comment {commentId: 'IC_1776_0'})
         MERGE (i)-[:HAS_COMMENT]->(c)`,
        { n: ISSUE },
      );
    } finally {
      await session.close();
    }
  });

  afterAll(async () => {
    const session = driver.session();
    try {
      await session.run(
        `MATCH (i:Issue {number: $n})
         OPTIONAL MATCH (i)-[:HAS_SOLUTION]->(s:Solution)
         OPTIONAL MATCH (i)-[:HAS_WORKAROUND]->(w:Workaround)
         DETACH DELETE i, s, w`,
        { n: ISSUE },
      );
    } finally {
      await session.close();
    }
  });

  it('writes and attaches a solution that carries no source', async () => {
    const { ingestAnalysisResults } = await import('../../src/services/analysis');

    const { errors, results } = await ingestAnalysisResults([
      {
        issueNumber: ISSUE,
        analysis: {
          summary: 'streaming preprocessing',
          categories: [],
          category: 'backend',
          subcategory: null,
          severity: 'medium',
          impact: 'moderate',
          effort: 'large',
          issueType: 'feature',
          needsClarification: false,
          clarificationReason: '',
          priorityRationale: 'a large feature request',
          competitors: [],
          // No `source`: this is the shape that used to abort the whole issue.
          solutions: [{ solutionText: 'Stream the transform.', keywords: ['stream'] }],
          workarounds: [{ workaroundText: 'Use set_transform.', keywords: ['transform'] }],
        } as never,
      },
    ]);

    expect(errors, 'the issue must not fail to ingest').toEqual([]);
    expect(results[0].stats.solutions, 'the solution is counted as written').toBe(1);
    expect(results[0].stats.workarounds, 'the workaround is counted as written').toBe(1);

    const session = driver.session();
    try {
      const r = await session.run(
        `MATCH (i:Issue {number: $n})-[:HAS_SOLUTION]->(s:Solution)
         OPTIONAL MATCH (i)-[:HAS_WORKAROUND]->(w:Workaround)
         RETURN count(DISTINCT s) AS sol, count(DISTINCT w) AS wrk`,
        { n: ISSUE },
      );
      const sol = r.records[0].get('sol').toNumber();
      const wrk = r.records[0].get('wrk').toNumber();
      expect(sol, 'the solution is attached to the issue').toBeGreaterThanOrEqual(1);
      expect(wrk, 'the workaround is attached to the issue').toBeGreaterThanOrEqual(1);

      // The classification that follows the records must also have landed: the
      // old throw aborted the issue before this write.
      const cls = await session.run(
        'MATCH (i:Issue {number: $n}) RETURN i.category AS c, i.priorityScore AS p',
        { n: ISSUE },
      );
      expect(cls.records[0].get('c'), 'the issue is classified').toBe('backend');
      expect(cls.records[0].get('p'), 'the issue is scored').not.toBeNull();
    } finally {
      await session.close();
    }
  });

  it('rejects the pre-fix statement when source is absent, which is the defect', async () => {
    const session = driver.session();
    try {
      // The exact statement the old ingestSolution issued, with the params map
      // the old code built when the model omitted `source`.
      await expect(
        session.run(
          `MERGE (s:Solution {solutionText: $text})
           SET s.embedding = []
           WITH s
           MATCH (c:Comment {commentId: $source})
           MERGE (c)-[:HAS_SOLUTION]->(s)`,
          { text: 'pre-fix probe' },
        ),
        'an absent parameter is what produced "Expected parameter(s): text, source"',
      ).rejects.toThrow(/Expected parameter\(s\)/);
    } finally {
      await session.close();
    }
  });

  it('leaves an orphan when the pre-fix statement gets an unmatched source', async () => {
    const session = driver.session();
    try {
      // The second, silent half: a source that matches no Comment is accepted,
      // so the node is created but never attached to anything.
      await session.run(
        `MERGE (s:Solution {solutionText: $text})
         SET s.embedding = []
         WITH s
         MATCH (c:Comment {commentId: $source})
         MERGE (c)-[:HAS_SOLUTION]->(s)`,
        { text: 'orphan probe', source: 'NO_SUCH_COMMENT' },
      );

      const r = await session.run(
        `MATCH (s:Solution {solutionText: 'orphan probe'})
         RETURN count(s) AS nodes,
                size([(s)<-[:HAS_SOLUTION]-() | 1]) AS attached`,
      );
      expect(r.records[0].get('nodes').toNumber(), 'the node is created').toBe(1);
      expect(
        r.records[0].get('attached').toNumber(),
        'but nothing points at it — the silent loss',
      ).toBe(0);
    } finally {
      await session.run(`MATCH (s:Solution {solutionText: 'orphan probe'}) DETACH DELETE s`);
      await session.close();
    }
  });
});

describe('reaction ingestion keeps one node per reaction', () => {
  // The same user gives the same reaction to the issue and to two of its
  // comments. Those are three reactions. The original merge key
  // (content, issueId, userLogin) collapsed them into one node, so two were lost.
  const issueData = (n: number) => {
    const alice = { login: 'alice-reacts' };
    const thumbs = { content: 'THUMBS_UP', user: alice };
    return {
      issue: {
        id: `I_R${n}`,
        number: n,
        title: 'reaction probe',
        bodyText: 'body',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        closedAt: null,
        state: 'OPEN',
        author: alice,
        reactions: { nodes: [thumbs], totalCount: 1 },
        totalComments: 2,
      },
      comments: [1, 2].map((k) => ({
        id: `IC_R${n}_${k}`,
        bodyText: `comment ${k}`,
        createdAt: `2026-01-0${k}T00:00:00Z`,
        author: alice,
        reactions: { nodes: [thumbs], totalCount: 1 },
      })),
    };
  };

  async function reactionShape(n: number) {
    const session = driver.session();
    try {
      const r = await session.run(
        `MATCH (i:Issue {number: $n})
         CALL { WITH i MATCH (r:Reaction {issueId: i.issueId}) RETURN count(r) AS nodes }
         CALL { WITH i MATCH (i)-[:HAS_REACTION]->(r:Reaction) RETURN count(r) AS onIssue }
         CALL { WITH i MATCH (i)-[:HAS_COMMENT]->(:Comment)-[:HAS_REACTION]->(r:Reaction)
                RETURN count(r) AS onComments, count(DISTINCT r) AS distinctOnComments }
         RETURN nodes, onIssue, onComments, distinctOnComments`,
        { n: neo4j.int(n) },
      );
      const rec = r.records[0];
      return {
        nodes: rec.get('nodes').toNumber(),
        onIssue: rec.get('onIssue').toNumber(),
        onComments: rec.get('onComments').toNumber(),
        distinctOnComments: rec.get('distinctOnComments').toNumber(),
      };
    } finally {
      await session.close();
    }
  }

  const expected = { nodes: 3, onIssue: 1, onComments: 2, distinctOnComments: 2 };

  afterAll(async () => {
    const session = driver.session();
    try {
      await session.run(
        `MATCH (r:Reaction) WHERE r.issueId IN ['I_R9001', 'I_R9002'] DETACH DELETE r
         WITH count(*) AS _
         MATCH (i:Issue) WHERE i.number IN [9001, 9002]
         OPTIONAL MATCH (i)-[:HAS_COMMENT]->(c:Comment)
         DETACH DELETE i, c`,
      );
    } finally {
      await session.close();
    }
  });

  it('batched ingest stores all three, and re-ingesting adds none', async () => {
    const { ingestMultipleIssues } = await import('../../src/services/neo4j');
    const first = await ingestMultipleIssues([issueData(9001)]);
    expect(first.errors).toEqual([]);
    expect(await reactionShape(9001)).toEqual(expected);

    await ingestMultipleIssues([issueData(9001)]);
    expect(await reactionShape(9001), 're-ingesting must be idempotent').toEqual(expected);
  });

  it('per-issue ingest, the batch fallback, stores the same graph', async () => {
    const { ingestIssueData } = await import('../../src/services/neo4j');
    const { issue, comments } = issueData(9002);
    await ingestIssueData(issue, comments);
    await ingestIssueData(issue, comments);
    expect(await reactionShape(9002)).toEqual(expected);
  });
});

describe('re-analysis tidies up only what the issue left behind', () => {
  // Re-analysing an issue detaches its old competitors and categories. The
  // original then swept the whole database for unattached ones after every
  // issue; the branch deletes only the ones this issue just detached.
  const analysis = (competitors: string[], categories: string[]) =>
    ({
      summary: 'probe',
      categories,
      category: 'backend',
      subcategory: null,
      severity: 'low',
      impact: 'narrow',
      effort: 'small',
      issueType: 'task',
      needsClarification: false,
      clarificationReason: '',
      priorityRationale: 'probe',
      competitors: competitors.map((name) => ({ name, source: '' })),
      solutions: [],
      workarounds: [],
    }) as never;

  async function names(label: 'Competitor' | 'Category'): Promise<string[]> {
    const session = driver.session();
    try {
      const r = await session.run(
        `MATCH (n:${label}) WHERE n.name STARTS WITH 'tidy-' RETURN n.name AS name ORDER BY name`,
      );
      return r.records.map((x) => x.get('name') as string);
    } finally {
      await session.close();
    }
  }

  beforeAll(async () => {
    const session = driver.session();
    try {
      await session.run(
        `CREATE (:Issue {number: 9101, issueId: 'I_T1', title: 'tidy a', state: 'OPEN'}),
                (:Issue {number: 9102, issueId: 'I_T2', title: 'tidy b', state: 'OPEN'}),
                (:Competitor {name: 'tidy-stray'}), (:Category {name: 'tidy-stray'})`,
      );
    } finally {
      await session.close();
    }
  });

  afterAll(async () => {
    const session = driver.session();
    try {
      await session.run(
        `MATCH (n) WHERE (n:Issue AND n.number IN [9101, 9102])
            OR ((n:Competitor OR n:Category) AND n.name STARTS WITH 'tidy-')
         DETACH DELETE n`,
      );
    } finally {
      await session.close();
    }
  });

  it("deletes the issue's own leftovers and keeps shared and unrelated ones", async () => {
    const { ingestAnalysisResults } = await import('../../src/services/analysis');
    await ingestAnalysisResults([
      {
        issueNumber: 9101,
        analysis: analysis(['tidy-shared', 'tidy-only-a'], ['tidy-shared', 'tidy-only-a']),
      },
      { issueNumber: 9102, analysis: analysis(['tidy-shared'], ['tidy-shared']) },
    ]);

    // Issue 9101 is analysed again and now mentions nothing.
    const { errors } = await ingestAnalysisResults([
      { issueNumber: 9101, analysis: analysis([], []) },
    ]);

    expect(errors).toEqual([]);
    const kept = ['tidy-shared', 'tidy-stray'];
    expect(
      await names('Competitor'),
      'only-a removed; shared and the unrelated stray kept',
    ).toEqual(kept);
    expect(await names('Category'), 'the same rule for categories').toEqual(kept);
  });
});
