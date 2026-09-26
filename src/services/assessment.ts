/**
 * Human triage decisions, persisted in the graph.
 *
 * Everything else in the graph is derived: fetched from GitHub or judged by a
 * model, and both are overwritten on the next run. A person's decision is
 * neither, so it lives in its own node type that no ingestion or analysis path
 * touches. `insertIssue` sets only the eight GitHub-sourced fields, and
 * `clearExistingAnalysis` deletes only Solution, Workaround, and Keyword, so an
 * Assessment survives a full re-ingest and re-analysis.
 *
 * Kept separate from `priorityScore` on purpose: that is the model's opinion and
 * changes when the model runs again. This is the record of what a person said.
 */

import neo4j from 'neo4j-driver';
import { getDriver } from './neo4j';

export const DECISIONS = ['should-fix', 'nice-to-have', 'wont-fix', 'needs-discussion'] as const;
export type Decision = (typeof DECISIONS)[number];

export interface Assessment {
  issueNumber: number;
  title: string;
  decision: Decision;
  note: string | null;
  recordedAt: string;
  recordedBy: string;
}

export interface RecordResult {
  recorded: number[];
  notFound: number[];
  replaced: number[];
}

export function isDecision(value: string): value is Decision {
  return (DECISIONS as readonly string[]).includes(value);
}

/**
 * Records one decision across any number of issues. Re-recording an issue
 * replaces its assessment rather than accumulating: the current decision is
 * what matters, and a stale one silently competing with it would be worse than
 * losing the history.
 */
export async function recordAssessment(opts: {
  issueNumbers: number[];
  decision: Decision;
  note?: string;
  recordedBy?: string;
}): Promise<RecordResult> {
  const { issueNumbers, decision, note = null, recordedBy = 'user' } = opts;
  const recordedAt = new Date().toISOString();

  const session = getDriver().session();
  const result: RecordResult = { recorded: [], notFound: [], replaced: [] };

  try {
    for (const number of issueNumbers) {
      const existing = await session.run(
        `MATCH (i:Issue {number: $n})-[:HAS_ASSESSMENT]->(a:Assessment) RETURN a.decision AS d`,
        { n: number },
      );
      const hadOne = existing.records.length > 0;

      const written = await session.run(
        `MATCH (i:Issue {number: $n})
         OPTIONAL MATCH (i)-[:HAS_ASSESSMENT]->(old:Assessment)
         DETACH DELETE old
         WITH i
         CREATE (i)-[:HAS_ASSESSMENT]->(a:Assessment {
           decision: $decision, note: $note, recordedAt: $recordedAt, recordedBy: $recordedBy
         })
         RETURN i.number AS n`,
        { n: number, decision, note, recordedAt, recordedBy },
      );

      if (written.records.length === 0) {
        result.notFound.push(number);
      } else {
        result.recorded.push(number);
        if (hadOne) result.replaced.push(number);
      }
    }
  } finally {
    await session.close();
  }

  return result;
}

/** Reads recorded decisions, optionally filtered to one decision value. */
export async function listAssessments(decision?: Decision): Promise<Assessment[]> {
  const session = getDriver().session({ defaultAccessMode: neo4j.session.READ });
  try {
    const res = await session.run(
      `MATCH (i:Issue)-[:HAS_ASSESSMENT]->(a:Assessment)
       WHERE $decision IS NULL OR a.decision = $decision
       RETURN i.number AS number, i.title AS title, a.decision AS decision,
              a.note AS note, a.recordedAt AS recordedAt, a.recordedBy AS recordedBy
       ORDER BY a.recordedAt DESC, i.number ASC`,
      { decision: decision ?? null },
    );
    return res.records.map((r) => ({
      issueNumber: neo4j.int(r.get('number')).toNumber(),
      title: r.get('title'),
      decision: r.get('decision') as Decision,
      note: r.get('note'),
      recordedAt: r.get('recordedAt'),
      recordedBy: r.get('recordedBy'),
    }));
  } finally {
    await session.close();
  }
}
