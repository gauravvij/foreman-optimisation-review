import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDriver } from './fake-driver';

const fake = vi.hoisted(() => ({
  ref: null as ReturnType<typeof import('./fake-driver').createFakeDriver> | null,
}));

vi.mock('../neo4j', () => ({ getDriver: () => fake.ref?.mockDriver }));

import { ingestAnalysisResults } from '../analysis';
import type { IssueAnalysis } from '../issue-analysis';

let db: ReturnType<typeof createFakeDriver>;

const analysis = (over: Partial<IssueAnalysis> = {}): IssueAnalysis =>
  ({
    summary: 'a summary',
    categories: [],
    category: 'backend',
    subcategory: null,
    severity: 'high',
    impact: 'moderate',
    effort: 'large',
    issueType: 'bug',
    needsClarification: false,
    clarificationReason: '',
    priorityRationale: 'because',
    competitors: [],
    solutions: [],
    workarounds: [],
    ...over,
  }) as IssueAnalysis;

/** The params of the SET that writes the classification. */
const classification = () =>
  db.queries.find((q) => q.query.includes('i.priorityScore'))?.params ?? {};

beforeEach(() => {
  db = createFakeDriver();
  fake.ref = db;
  vi.clearAllMocks();
});

describe('ingestAnalysisResults classification', () => {
  it('stores the canonical effort for a value the model varied the casing of', async () => {
    await ingestAnalysisResults([
      { issueNumber: 57, analysis: analysis({ effort: 'Large' as never }) },
    ]);

    expect(classification().effort, 'the graph holds the canonical effort').toBe('large');
  });

  it('flags an issue it could not size instead of scoring it as large', async () => {
    await ingestAnalysisResults([
      { issueNumber: 57, analysis: analysis({ effort: 'epic' as never }) },
    ]);
    const params = classification();

    expect(params.effort, 'an unsizeable effort is not persisted').toBeNull();
    expect(params.needsClarification, 'the issue is flagged for a human').toBe(true);
    expect(params.clarificationReason, 'the flag says what is missing').toContain('effort');
  });

  it('keeps the model reason alongside the unsized reason', async () => {
    await ingestAnalysisResults([
      {
        issueNumber: 57,
        analysis: analysis({
          effort: 'epic' as never,
          needsClarification: true,
          clarificationReason: 'No reproduction steps.',
        }),
      },
    ]);

    expect(classification().clarificationReason, 'neither reason is dropped').toBe(
      'No reproduction steps. The effort is unclear, so the issue has no size.',
    );
  });

  it('leaves a sized issue unflagged', async () => {
    await ingestAnalysisResults([{ issueNumber: 57, analysis: analysis() }]);
    const params = classification();

    expect(params.needsClarification, 'a sizeable issue needs no clarification').toBe(false);
    expect(params.clarificationReason, 'no reason is invented').toBeNull();
  });

  it('scores an unsized issue below the same issue sized large', async () => {
    await ingestAnalysisResults([{ issueNumber: 1, analysis: analysis({ effort: 'large' }) }]);
    const sized = classification().priorityScore as number;

    db.reset();
    await ingestAnalysisResults([
      { issueNumber: 2, analysis: analysis({ effort: 'epic' as never }) },
    ]);
    const unsized = classification().priorityScore as number;

    expect(unsized, 'an unknown effort earns no effort points').toBeLessThan(sized);
  });
});

/**
 * The #1776 defect: a solution or workaround the model returned without a
 * `source` used to reach the driver as an absent parameter, which Neo4j rejects
 * with "Expected parameter(s): text, source". The throw aborted the rest of the
 * issue's ingest, so its classification was never written either.
 *
 * These tests pin the two properties that fix it: the params map always carries
 * every key the statement references, and the Issue edge no longer depends on a
 * comment hop that can fail.
 */
describe('ingestAnalysisResults solutions and workarounds', () => {
  /** The statement that writes a Solution, as opposed to the cleanup that deletes one. */
  const solutionWrite = () =>
    db.queries.find((q) => q.query.includes('MERGE (s:Solution {solutionText: $text})'));
  const workaroundWrite = () =>
    db.queries.find((q) => q.query.includes('MERGE (w:Workaround {workaroundText: $text})'));

  it('supplies every parameter when the model omits the comment source', async () => {
    await ingestAnalysisResults([
      {
        issueNumber: 1776,
        analysis: analysis({
          solutions: [{ solutionText: 'Stream the transform.', keywords: ['stream'] } as never],
        }),
      },
    ]);

    const write = solutionWrite();
    expect(write, 'the solution is written rather than dropped').toBeDefined();
    expect(Object.keys(write!.params).sort(), 'no referenced parameter is absent').toEqual([
      'keywords',
      'n',
      'source',
      'text',
    ]);
    expect(write!.params.source, 'an omitted source becomes the empty string').toBe('');
    expect(write!.params.text, 'the text survives').toBe('Stream the transform.');
    expect(write!.params.n, 'the statement is scoped to the issue').toBe(1776);
  });

  it('attaches the solution to the issue without a comment hop', async () => {
    await ingestAnalysisResults([
      {
        issueNumber: 1776,
        analysis: analysis({
          solutions: [{ solutionText: 'Stream the transform.', keywords: [] } as never],
        }),
      },
    ]);

    const query = solutionWrite()!.query;
    expect(query, 'the issue edge is unconditional').toContain('MERGE (i)-[:HAS_SOLUTION]->(s)');
    expect(query, 'the comment hop is guarded').toContain("WHERE $source <> ''");
    expect(query, 'a missing comment cannot abort the write').toContain('OPTIONAL MATCH');
  });

  it('still links the comment when the model names one', async () => {
    await ingestAnalysisResults([
      {
        issueNumber: 1776,
        analysis: analysis({
          solutions: [
            { solutionText: 'Stream the transform.', source: 'IC_1776_0', keywords: [] } as never,
          ],
        }),
      },
    ]);

    const write = solutionWrite()!;
    expect(write.params.source, 'the named comment is passed through').toBe('IC_1776_0');
    expect(write.query, 'the comment edge is still written').toContain(
      'MERGE (c)-[:HAS_SOLUTION]->(s)',
    );
  });

  it('applies the same scoping to workarounds', async () => {
    await ingestAnalysisResults([
      {
        issueNumber: 1776,
        analysis: analysis({
          workarounds: [{ workaroundText: 'Use set_transform.', keywords: ['transform'] } as never],
        }),
      },
    ]);

    const write = workaroundWrite();
    expect(write, 'the workaround is written rather than dropped').toBeDefined();
    expect(Object.keys(write!.params).sort()).toEqual(['keywords', 'n', 'source', 'text']);
    expect(write!.params.source).toBe('');
    expect(write!.query).toContain('MERGE (i)-[:HAS_WORKAROUND]->(w)');
    expect(write!.query).toContain("WHERE $source <> ''");
  });

  it.each([
    ['undefined', undefined],
    ['an empty string', ''],
    ['whitespace only', '   '],
  ])('issues no Cypher for a solution whose text is %s', async (_label, text) => {
    const { results, errors } = await ingestAnalysisResults([
      {
        issueNumber: 1776,
        analysis: analysis({
          solutions: [{ solutionText: text, keywords: [] } as never],
        }),
      },
    ]);

    expect(solutionWrite(), 'a text-less record never reaches the driver').toBeUndefined();
    expect(errors, 'and it does not fail the batch').toEqual([]);
    expect(results[0].stats.solutions, 'it is not counted as written').toBe(0);
  });

  it('keeps the records around a malformed one', async () => {
    const { results, errors } = await ingestAnalysisResults([
      {
        issueNumber: 1776,
        analysis: analysis({
          solutions: [
            { solutionText: 'First good one.', keywords: [] } as never,
            { solutionText: undefined, keywords: [] } as never,
            { solutionText: 'Second good one.', keywords: [] } as never,
          ],
        }),
      },
    ]);

    expect(errors, 'the malformed record does not abort the issue').toEqual([]);
    expect(results[0].stats.solutions, 'both usable records are written').toBe(2);
    expect(
      db.queries.filter((q) => q.query.includes('MERGE (s:Solution {solutionText: $text})')),
      'one statement per usable record',
    ).toHaveLength(2);
  });

  it('writes the classification even when a record was malformed', async () => {
    await ingestAnalysisResults([
      {
        issueNumber: 1776,
        analysis: analysis({
          solutions: [{ solutionText: undefined, keywords: [] } as never],
        }),
      },
    ]);

    expect(classification().n, 'the issue is still classified, which the old throw prevented').toBe(
      1776,
    );
  });

  it('drops blank keywords instead of merging an empty name', async () => {
    await ingestAnalysisResults([
      {
        issueNumber: 1776,
        analysis: analysis({
          solutions: [
            { solutionText: 'Stream it.', keywords: ['stream', '  ', 'stream', ''] } as never,
          ],
        }),
      },
    ]);

    expect(solutionWrite()!.params.keywords, 'blank and duplicate keywords are removed').toEqual([
      'stream',
    ]);
  });
});

describe('ingestAnalysisResults competitors', () => {
  /** The statement that writes competitors for an issue. */
  const competitorWrite = () =>
    db.queries.find((q) => q.query.includes('MERGE (c:Competitor {name: comp.name})'));

  it('guards the comment hop so a competitor with no source is not dropped', async () => {
    await ingestAnalysisResults([
      {
        issueNumber: 1776,
        analysis: analysis({
          competitors: [{ name: 'Weights & Biases' } as never],
        }),
      },
    ]);

    const write = competitorWrite();
    expect(write, 'the competitor statement is issued').toBeDefined();
    expect(write!.query, 'the issue edge is unconditional').toContain(
      'MERGE (i)-[:MENTIONS_COMPETITOR]->(c)',
    );
    expect(write!.query, 'the comment hop is optional').toContain('OPTIONAL MATCH');
    expect(write!.query, 'a missing source cannot drop the row').toContain(
      'comp.source IS NOT NULL',
    );
    expect(write!.query, 'the comment edge is still written when one exists').toContain(
      'MERGE (cmt)-[:MENTIONS_COMPETITOR]->(c)',
    );
  });

  it('counts a competitor that carries no source', async () => {
    // Answer the competitor statement with a count and everything else with no
    // rows, so the assertion does not depend on how many statements precede it.
    db.mockSession.run.mockImplementation(async (query: string, params = {}) => {
      db.queries.push({ query, params });
      if (query.includes('count(DISTINCT c) AS cnt')) {
        return { records: [{ keys: ['cnt'], get: () => ({ toNumber: () => 1 }) }] };
      }
      return { records: [] };
    });

    const { results, errors } = await ingestAnalysisResults([
      {
        issueNumber: 1776,
        analysis: analysis({
          competitors: [{ name: 'Weights & Biases' } as never],
        }),
      },
    ]);

    expect(errors, 'a source-less competitor does not fail the batch').toEqual([]);
    expect(results[0].stats.competitors, 'the competitor is counted as written').toBe(1);
  });

  it('passes the named comment source through to the statement', async () => {
    await ingestAnalysisResults([
      {
        issueNumber: 1776,
        analysis: analysis({
          competitors: [{ name: 'Weights & Biases', source: 'IC_1776_0' } as never],
        }),
      },
    ]);

    const write = competitorWrite()!;
    const competitors = write.params.competitors as { name: string; source?: string }[];
    expect(competitors[0].source, 'the named comment is passed through').toBe('IC_1776_0');
  });

  it('leaves the category statement untouched', async () => {
    await ingestAnalysisResults([
      {
        issueNumber: 1776,
        analysis: analysis({ categories: ['tooling'] }),
      },
    ]);

    const write = db.queries.find((q) => q.query.includes('MERGE (cat:Category {name: name})'));
    expect(write, 'categories are still written').toBeDefined();
    expect(write!.query, 'categories have no comment hop to guard').not.toContain('OPTIONAL MATCH');
    expect(write!.query).toContain('MERGE (i)-[:BELONGS_TO_CATEGORY]->(cat)');
  });
});
