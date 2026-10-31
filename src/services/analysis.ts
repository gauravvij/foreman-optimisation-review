/**
 * Analysis ingestion — stores model analysis results back into Neo4j.
 *
 * Analysis nodes: Solution, Workaround, Competitor, Category, Keyword
 * Relationships: HAS_SOLUTION, HAS_WORKAROUND, MENTIONS_COMPETITOR,
 *                BELONGS_TO_CATEGORY, HAS_KEYWORD
 */

import type { Session } from 'neo4j-driver';
import type {
  CompetitorAnalysis,
  IssueAnalysis,
  SolutionAnalysis,
  WorkaroundAnalysis,
} from './issue-analysis';
import { getDriver } from './neo4j';
import { computePriorityScore, isCategory, toEffort } from './priority';

const UNSIZED_REASON = 'The effort is unclear, so the issue has no size.';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnalysisData {
  issueNumber: number;
  title?: string;
  analysis: IssueAnalysis | null;
}

interface AnalysisStats {
  solutions: number;
  workarounds: number;
  competitors: number;
  categories: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function clearExistingAnalysis(session: Session, issueNumber: number): Promise<void> {
  // Delete solutions/workarounds and their keywords
  await session.run(
    `MATCH (i:Issue {number: $n})
     OPTIONAL MATCH (i)-[:HAS_SOLUTION]->(s:Solution)
     OPTIONAL MATCH (s)-[:HAS_KEYWORD]->(sk:Keyword)
     DETACH DELETE s, sk
     WITH i
     OPTIONAL MATCH (i)-[:HAS_WORKAROUND]->(w:Workaround)
     OPTIONAL MATCH (w)-[:HAS_KEYWORD]->(wk:Keyword)
     DETACH DELETE w, wk
     WITH i
     OPTIONAL MATCH (i)-[:HAS_COMMENT]->(c:Comment)
     OPTIONAL MATCH (c)-[:HAS_SOLUTION]->(cs:Solution)
     OPTIONAL MATCH (cs)-[:HAS_KEYWORD]->(csk:Keyword)
     DETACH DELETE cs, csk
     WITH i, c
     OPTIONAL MATCH (c)-[:HAS_WORKAROUND]->(cw:Workaround)
     OPTIONAL MATCH (cw)-[:HAS_KEYWORD]->(cwk:Keyword)
     DETACH DELETE cw, cwk`,
    { n: issueNumber },
  );

  // Remove only the competitors/categories this issue was attached to and that
  // nothing else references any more.
  //
  // This used to finish with a graph-wide `MATCH (comp:Competitor) WHERE NOT
  // (comp)<-[:MENTIONS_COMPETITOR]-() DELETE comp` (and the Category
  // equivalent), which reads every node of both labels on every analysed issue
  // — an O(graph) sweep per issue, repeated 60 times in a 60-issue run. The
  // CALL subqueries bind the cleanup to the node the issue just detached, so
  // the work is proportional to this issue's own analysis instead of the size
  // of the graph. Node deletion stays a plain DELETE rather than DETACH DELETE
  // so the failure mode is unchanged: a candidate that still carries other
  // relationships is an error, exactly as before, instead of being silently
  // detached from them.
  await session.run(
    `MATCH (i:Issue {number: $n})
     CALL {
       WITH i
       OPTIONAL MATCH (i)-[r:MENTIONS_COMPETITOR]->(comp:Competitor)
       DELETE r
       WITH collect(comp) AS detached
       UNWIND detached AS candidate
       WITH candidate
       WHERE candidate IS NOT NULL AND NOT (candidate)<-[:MENTIONS_COMPETITOR]-()
       DELETE candidate
       RETURN count(*) AS competitors_deleted
     }
     CALL {
       WITH i
       OPTIONAL MATCH (i)-[r:BELONGS_TO_CATEGORY]->(cat:Category)
       DELETE r
       WITH collect(cat) AS detached
       UNWIND detached AS candidate
       WITH candidate
       WHERE candidate IS NOT NULL AND NOT (candidate)<-[:BELONGS_TO_CATEGORY]-()
       DELETE candidate
       RETURN count(*) AS categories_deleted
     }
     RETURN i`,
    { n: issueNumber },
  );
}

/**
 * The text a record actually carries, or null when there is nothing usable.
 *
 * The model's schema marks `solutionText`/`workaroundText` required, but the
 * schema travels as a tool definition rather than as `response_format:
 * json_schema`, so it is advisory: a completion can omit the key entirely. A
 * record with no text is not worth a node, and must not reach Cypher — an
 * absent parameter makes the driver reject the whole statement.
 */
function usableText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Keyword names worth writing: strings, trimmed, no blanks, de-duplicated. */
function usableKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const kw of value) {
    if (typeof kw !== 'string') continue;
    const trimmed = kw.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

/**
 * Attaches a Solution to the issue being analysed, and to the comment that
 * proposed it when the model named one that exists.
 *
 * Why this is issue-scoped rather than comment-scoped: the prompt tells the
 * model to extract solutions only from comments and to cite the commentId as
 * the source, but a completion can still omit that field. The previous
 * statement began `MATCH (c:Comment {commentId: $source})`, which failed two
 * ways — an absent `$source` made the driver reject the statement outright
 * ("Expected parameter(s): text, source"), aborting the rest of the issue's
 * ingest, and a source that matched no comment was accepted while silently
 * leaving an orphan Solution with no relationship at all.
 *
 * So the Issue edge is now unconditional and the Comment edge is best-effort.
 * The prompt is deliberately unchanged: this is a runtime fix, and tightening
 * the extraction guidance would move QA scores for reasons unrelated to the
 * defect.
 */
async function ingestSolution(
  session: Session,
  issueNumber: number,
  solution: SolutionAnalysis,
): Promise<void> {
  await session.run(
    `MATCH (i:Issue {number: $n})
     MERGE (s:Solution {solutionText: $text})
     SET s.embedding = []
     MERGE (i)-[:HAS_SOLUTION]->(s)
     WITH s
     OPTIONAL MATCH (c:Comment {commentId: $source})
     WHERE $source <> ''
     FOREACH (_ IN CASE WHEN c IS NULL THEN [] ELSE [1] END |
       MERGE (c)-[:HAS_SOLUTION]->(s)
     )
     FOREACH (kw IN $keywords |
       MERGE (k:Keyword {name: kw})
       MERGE (s)-[:HAS_KEYWORD]->(k)
     )`,
    {
      n: issueNumber,
      text: solution.solutionText,
      source: solution.source ?? '',
      keywords: usableKeywords(solution.keywords),
    },
  );
}

/** The Workaround counterpart of {@link ingestSolution}; same scoping rules. */
async function ingestWorkaround(
  session: Session,
  issueNumber: number,
  workaround: WorkaroundAnalysis,
): Promise<void> {
  await session.run(
    `MATCH (i:Issue {number: $n})
     MERGE (w:Workaround {workaroundText: $text})
     SET w.embedding = []
     MERGE (i)-[:HAS_WORKAROUND]->(w)
     WITH w
     OPTIONAL MATCH (c:Comment {commentId: $source})
     WHERE $source <> ''
     FOREACH (_ IN CASE WHEN c IS NULL THEN [] ELSE [1] END |
       MERGE (c)-[:HAS_WORKAROUND]->(w)
     )
     FOREACH (kw IN $keywords |
       MERGE (k:Keyword {name: kw})
       MERGE (w)-[:HAS_KEYWORD]->(k)
     )`,
    {
      n: issueNumber,
      text: workaround.workaroundText,
      source: workaround.source ?? '',
      keywords: usableKeywords(workaround.keywords),
    },
  );
}

async function ingestCompetitors(
  session: Session,
  competitors: CompetitorAnalysis[],
  issueNumber: number,
): Promise<number> {
  if (competitors.length === 0) return 0;

  const result = await session.run(
    `MATCH (i:Issue {number: $n})
     UNWIND $competitors AS comp
     MERGE (c:Competitor {name: comp.name})
     MERGE (i)-[:MENTIONS_COMPETITOR]->(c)
     WITH c, comp
     MATCH (cmt:Comment {commentId: comp.source})
     MERGE (cmt)-[:MENTIONS_COMPETITOR]->(c)
     RETURN count(c) AS cnt`,
    { n: issueNumber, competitors },
  );
  return result.records[0]?.get('cnt')?.toNumber?.() ?? 0;
}

async function ingestCategories(
  session: Session,
  categories: string[],
  issueNumber: number,
): Promise<number> {
  if (categories.length === 0) return 0;

  const result = await session.run(
    `MATCH (i:Issue {number: $n})
     UNWIND $categories AS name
     MERGE (cat:Category {name: name})
     MERGE (i)-[:BELONGS_TO_CATEGORY]->(cat)
     RETURN count(cat) AS cnt`,
    { n: issueNumber, categories },
  );
  return result.records[0]?.get('cnt')?.toNumber?.() ?? 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function ingestClassification(
  session: Session,
  issueNumber: number,
  analysis: IssueAnalysis,
): Promise<void> {
  const category = isCategory(analysis.category) ? analysis.category : 'other';
  const effort = toEffort(analysis.effort);
  const priorityScore = computePriorityScore({
    severity: analysis.severity,
    impact: analysis.impact,
    effort,
  });
  const needsClarification = (analysis.needsClarification ?? false) || effort === null;
  const clarificationReason =
    [analysis.clarificationReason, effort === null ? UNSIZED_REASON : '']
      .filter(Boolean)
      .join(' ') || null;

  await session.run(
    `MATCH (i:Issue {number: $n})
     SET i.category          = $category,
         i.subcategory       = $subcategory,
         i.severity          = $severity,
         i.impact            = $impact,
         i.effort            = $effort,
         i.priorityScore     = toInteger($priorityScore),
         i.priorityRationale = $priorityRationale,
         i.issueType         = $issueType,
         i.needsClarification = $needsClarification,
         i.clarificationReason = $clarificationReason`,
    {
      n: issueNumber,
      category,
      subcategory: analysis.subcategory ?? null,
      severity: analysis.severity ?? null,
      impact: analysis.impact ?? null,
      effort,
      priorityScore,
      priorityRationale: analysis.priorityRationale ?? null,
      issueType: analysis.issueType ?? null,
      needsClarification,
      clarificationReason,
    },
  );
}

async function processIssueAnalysis(session: Session, data: AnalysisData): Promise<AnalysisStats> {
  const { issueNumber, analysis } = data;
  if (!analysis) return { solutions: 0, workarounds: 0, competitors: 0, categories: 0 };

  console.log(`  Clearing previous analysis for issue #${issueNumber}...`);
  await clearExistingAnalysis(session, issueNumber);

  const stats: AnalysisStats = { solutions: 0, workarounds: 0, competitors: 0, categories: 0 };

  // A record with no usable text is dropped before it reaches Cypher. The model
  // can emit one — its schema is advisory — and an absent `text` parameter makes
  // the driver reject the statement, which used to abort the rest of the issue's
  // ingest, classification included.
  for (const s of analysis.solutions ?? []) {
    if (usableText(s?.solutionText) === null) {
      console.warn(`  Skipping a solution for #${issueNumber}: no solutionText`);
      continue;
    }
    await ingestSolution(session, issueNumber, s);
    stats.solutions++;
  }
  for (const w of analysis.workarounds ?? []) {
    if (usableText(w?.workaroundText) === null) {
      console.warn(`  Skipping a workaround for #${issueNumber}: no workaroundText`);
      continue;
    }
    await ingestWorkaround(session, issueNumber, w);
    stats.workarounds++;
  }
  stats.competitors = await ingestCompetitors(session, analysis.competitors ?? [], issueNumber);
  stats.categories = await ingestCategories(session, analysis.categories ?? [], issueNumber);
  await ingestClassification(session, issueNumber, analysis);

  return stats;
}

export async function ingestAnalysisResults(analysisData: AnalysisData[]): Promise<{
  results: { issueNumber: number; stats: AnalysisStats }[];
  errors: { issueNumber: number; error: string }[];
}> {
  const session = getDriver().session();
  const results: { issueNumber: number; stats: AnalysisStats }[] = [];
  const errors: { issueNumber: number; error: string }[] = [];

  try {
    for (let i = 0; i < analysisData.length; i++) {
      const data = analysisData[i];
      try {
        console.log(
          `[${i + 1}/${analysisData.length}] Ingesting analysis for issue #${data.issueNumber}...`,
        );
        const stats = await processIssueAnalysis(session, data);
        results.push({ issueNumber: data.issueNumber, stats });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  Failed analysis for #${data.issueNumber}: ${msg}`);
        errors.push({ issueNumber: data.issueNumber, error: msg });
      }
    }
  } finally {
    await session.close();
  }

  return { results, errors };
}
