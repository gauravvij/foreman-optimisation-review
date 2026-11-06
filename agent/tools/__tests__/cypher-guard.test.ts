import { describe, expect, it } from 'vitest';
import { buildInstructions } from '../../instructions';
import { SCHEMA_EDGES, checkCypherAgainstSchema, extractPatternEdges } from '../cypher-guard';

/**
 * The two queries the agent actually wrote and lost on, lifted verbatim from
 * bench/foreman-qa/jobs/foreman-fresh-v6/report.json (sympy2-dev-032 attempt 1
 * and sympy2-dev-033 attempt 1). Both returned zero rows and both were then
 * reported as confident absence. These are the regression fixtures.
 */
const FAILING_032 =
  "MATCH (i:Issue)-[:HAS_LABEL]->(l:Label), (i)-[:HAS_COMMENT]->(c:Comment)<-[:AUTHORED_BY]-(u:User) WHERE toLower(l.name) = 'wrong result' RETURN DISTINCT u.login LIMIT 100";
const FAILING_033 =
  "MATCH (i:Issue)-[:HAS_LABEL]->(:Label {name: 'Easy to Fix'})-[:HAS_LABEL]->(l:Label) RETURN DISTINCT l.name AS label, COUNT(i) AS issue_count ORDER BY issue_count DESC LIMIT 10";

/** The corrected forms, from attempts 0 and 2 of the same two tasks. */
const CORRECT_032 =
  "MATCH (i:Issue)-[:HAS_LABEL]->(l:Label), (i)-[:HAS_COMMENT]->(c:Comment), (c)-[:AUTHORED_BY]->(u:User) WHERE toLower(l.name) = 'wrong result' RETURN DISTINCT u.login LIMIT 50";
const CORRECT_033 =
  'MATCH (i:Issue)-[:HAS_LABEL]->(l1:Label {name: "Easy to Fix"}), (i)-[:HAS_LABEL]->(l2:Label) WHERE l1 <> l2 RETURN l2.name AS label, COUNT(i) AS count ORDER BY count DESC LIMIT 10';

describe('checkCypherAgainstSchema — the two measured failures', () => {
  it('flags sympy2-dev-032 and names the reversed AUTHORED_BY edge', () => {
    const warnings = checkCypherAgainstSchema(FAILING_032);

    expect(warnings, 'the reversed arrow must produce exactly one warning').toHaveLength(1);
    expect(warnings[0]).toContain('AUTHORED_BY');
    expect(warnings[0], 'the warning must say the arrow is the wrong way round').toContain(
      'runs against the arrow',
    );
    // The specific edge: the schema points (Comment)->(User), not the reverse.
    expect(warnings[0]).toContain('(Comment)-[:AUTHORED_BY]->(User)');
  });

  it('flags sympy2-dev-033 and names HAS_LABEL chained out of a Label', () => {
    const warnings = checkCypherAgainstSchema(FAILING_033);

    expect(warnings, 'the impossible chain must produce exactly one warning').toHaveLength(1);
    expect(warnings[0]).toContain('HAS_LABEL');
    expect(warnings[0]).toContain('impossible');
    expect(warnings[0]).toContain('(Issue)-[:HAS_LABEL]->(Label)');
  });

  it('does not flag the corrected form of 032', () => {
    expect(checkCypherAgainstSchema(CORRECT_032)).toEqual([]);
  });

  it('does not flag the corrected form of 033', () => {
    expect(checkCypherAgainstSchema(CORRECT_033)).toEqual([]);
  });
});

describe('checkCypherAgainstSchema — further cases', () => {
  const mustWarn: { name: string; cypher: string; contains: string }[] = [
    {
      name: 'a reversed User->Issue AUTHORED_BY',
      cypher: 'MATCH (u:User)-[:AUTHORED_BY]->(i:Issue) RETURN u.login LIMIT 5',
      contains: 'runs against the arrow',
    },
    {
      name: 'HAS_COMMENT chained out of a Label',
      cypher: 'MATCH (l:Label)-[:HAS_COMMENT]->(c:Comment) RETURN c.commentId LIMIT 5',
      contains: 'impossible',
    },
    {
      name: 'HAS_LABEL chained out of a Comment',
      cypher: 'MATCH (c:Comment)-[:HAS_LABEL]->(l:Label) RETURN l.name LIMIT 5',
      contains: 'impossible',
    },
    {
      name: 'CLOSES pointing the wrong way',
      cypher: 'MATCH (i:Issue)-[:CLOSES]->(pr:PullRequest) RETURN pr.number LIMIT 5',
      contains: 'runs against the arrow',
    },
    {
      name: 'an unknown relationship type',
      cypher: 'MATCH (i:Issue)-[:WROTE]->(u:User) RETURN u.login LIMIT 5',
      contains: 'does not define',
    },
  ];

  for (const { name, cypher, contains } of mustWarn) {
    it(`warns on ${name}`, () => {
      const warnings = checkCypherAgainstSchema(cypher);
      expect(warnings.length, `${name} must warn`).toBeGreaterThan(0);
      expect(warnings.join(' ')).toContain(contains);
    });
  }

  const mustNotWarn: { name: string; cypher: string }[] = [
    {
      name: 'an undirected pattern whose forward orientation is valid',
      cypher: 'MATCH (c:Comment)-[:AUTHORED_BY]-(u:User) RETURN u.login LIMIT 5',
    },
    {
      name: 'an undirected pattern whose reverse orientation is valid',
      cypher: 'MATCH (u:User)-[:AUTHORED_BY]-(c:Comment) RETURN u.login LIMIT 5',
    },
    {
      name: 'a valid three-hop traversal',
      cypher:
        'MATCH (i:Issue)-[:HAS_COMMENT]->(c:Comment)-[:AUTHORED_BY]->(u:User) RETURN u.login LIMIT 5',
    },
    {
      name: 'a valid two-hop through two issue edges',
      cypher:
        'MATCH (i:Issue)-[:HAS_LABEL]->(l1:Label), (i)-[:HAS_LABEL]->(l2:Label) RETURN l2.name LIMIT 5',
    },
    {
      name: 'a query with no relationship at all',
      cypher: 'MATCH (i:Issue) RETURN i.number AS n LIMIT 5',
    },
    {
      name: 'an aggregate over a valid edge',
      cypher:
        'MATCH (i:Issue)-[:HAS_COMMENT]->(c:Comment) WHERE i.number = 10979 RETURN count(c) AS commentCount LIMIT 1',
    },
    {
      name: 'a variable bound in a later MATCH clause',
      cypher: 'MATCH (i:Issue) MATCH (i)-[:HAS_COMMENT]->(c:Comment) RETURN count(c) LIMIT 1',
    },
    {
      name: 'a relationship with no type',
      cypher: 'MATCH (a)-[r]->(b) RETURN type(r) LIMIT 5',
    },
    {
      name: 'a valid pull request edge',
      cypher: 'MATCH (pr:PullRequest)-[:CLOSES]->(i:Issue) RETURN i.number LIMIT 5',
    },
  ];

  for (const { name, cypher } of mustNotWarn) {
    it(`stays silent on ${name}`, () => {
      expect(checkCypherAgainstSchema(cypher)).toEqual([]);
    });
  }
});

describe('checkCypherAgainstSchema — robustness', () => {
  it('does not read a relationship out of a string literal', () => {
    const cypher =
      "MATCH (i:Issue)-[:HAS_LABEL]->(l:Label) WHERE l.name = '(a)-[:HAS_COMMENT]->(b)' RETURN l.name LIMIT 5";
    expect(checkCypherAgainstSchema(cypher)).toEqual([]);
  });

  it('does not read a relationship out of a line comment', () => {
    const cypher =
      'MATCH (i:Issue)-[:HAS_LABEL]->(l:Label) // (u:User)-[:AUTHORED_BY]->(i:Issue)\nRETURN l.name LIMIT 5';
    expect(checkCypherAgainstSchema(cypher)).toEqual([]);
  });

  it('handles a multi-line query the same as a single-line one', () => {
    const cypher = `MATCH (i:Issue)-[:HAS_LABEL]->(l:Label)
WHERE toLower(l.name) = 'easy to fix'
WITH i
MATCH (i)-[:HAS_LABEL]->(other:Label)
WHERE other.name <> 'Easy to Fix'
RETURN DISTINCT other.name AS label ORDER BY label LIMIT 50`;
    expect(checkCypherAgainstSchema(cypher)).toEqual([]);
  });

  it('returns no warning for an empty query', () => {
    expect(checkCypherAgainstSchema('')).toEqual([]);
  });

  it('returns no warning for input it cannot parse', () => {
    expect(checkCypherAgainstSchema('this is not cypher ###')).toEqual([]);
  });

  it('is deterministic — the same query yields the same warnings every time', () => {
    const first = checkCypherAgainstSchema(FAILING_032);
    const second = checkCypherAgainstSchema(FAILING_032);
    const third = checkCypherAgainstSchema(FAILING_032);

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('reports each distinct bad edge once, even if the query repeats it', () => {
    const cypher =
      'MATCH (u:User)-[:AUTHORED_BY]->(i:Issue) MATCH (u2:User)-[:AUTHORED_BY]->(i2:Issue) RETURN u.login LIMIT 5';
    const warnings = checkCypherAgainstSchema(cypher);
    expect(new Set(warnings).size).toBe(warnings.length);
  });
});

describe('extractPatternEdges', () => {
  it('normalises an incoming arrow to the traversal it asserts', () => {
    const edges = extractPatternEdges(
      'MATCH (c:Comment)<-[:AUTHORED_BY]-(u:User) RETURN u.login LIMIT 5',
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ rel: 'AUTHORED_BY', direction: 'in' });
    expect(edges[0].from.label).toBe('Comment');
    expect(edges[0].to.label).toBe('User');
  });

  it('resolves a variable label declared in an earlier MATCH', () => {
    const edges = extractPatternEdges(
      'MATCH (i:Issue) MATCH (i)-[:HAS_COMMENT]->(c:Comment) RETURN count(c) LIMIT 1',
    );
    expect(edges).toHaveLength(1);
    expect(edges[0].from.label).toBe('Issue');
    expect(edges[0].to.label).toBe('Comment');
  });

  it('extracts every edge of a comma-joined pattern', () => {
    const edges = extractPatternEdges(
      'MATCH (i:Issue)-[:HAS_LABEL]->(l:Label), (i)-[:HAS_COMMENT]->(c:Comment) RETURN i LIMIT 5',
    );
    expect(edges.map((e) => e.rel)).toEqual(['HAS_LABEL', 'HAS_COMMENT']);
  });
});

describe('SCHEMA_EDGES', () => {
  it('encodes exactly the 21 relationships the prompt declares', () => {
    expect(SCHEMA_EDGES).toHaveLength(21);
  });

  it('matches the relationship list in the agent instructions, so the two cannot drift', () => {
    const instructions = buildInstructions('astropods', 'agents');
    const start = instructions.indexOf('## Relationships');
    expect(start, 'the schema section must exist').toBeGreaterThan(-1);
    const end = instructions.indexOf('.trim', start);
    const section = instructions.slice(start, end === -1 ? undefined : end);

    const declared = [
      ...section.matchAll(/^- \(([A-Za-z]+)\)-\[:([A-Z_]+)\]->\(([A-Za-z]+)\)/gm),
    ].map((m) => ({ from: m[1], rel: m[2], to: m[3] }));

    expect(declared.length, 'the prompt must still list 21 relationships').toBe(21);
    const byKey = (a: SchemaEdgeKey, b: SchemaEdgeKey) => edgeKey(a).localeCompare(edgeKey(b));
    expect([...declared].sort(byKey)).toEqual([...SCHEMA_EDGES].sort(byKey));
  });
});

type SchemaEdgeKey = { from: string; rel: string; to: string };

function edgeKey(e: SchemaEdgeKey): string {
  return `${e.from}|${e.rel}|${e.to}`;
}
