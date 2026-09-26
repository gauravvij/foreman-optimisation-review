/**
 * Re-fetches issues whose content has changed since they were ingested.
 *
 * The third way the graph drifts, and the one the other two tools cannot see:
 *
 *   reconcileIssueState   state is wrong on an issue we hold
 *   ingestMissingIssues   an issue is absent entirely
 *   refreshIssues         we hold the issue, but the title, body, labels, or
 *                         comments have changed since we read them
 *
 * Detection is by GitHub's own updatedAt rather than a local timestamp: any
 * edit, comment, label change, or state change moves it, and comparing it to
 * the value stored at ingest time is exact.
 */

import neo4j from 'neo4j-driver';
import { type AnalysisData, ingestAnalysisResults } from './analysis';
import { fetchMultipleIssueDetails } from './database';
import { getIssuesData } from './github';
import { listGuidance, renderGuidance } from './guidance';
import { fetchWithRetry } from './http';
import { analyzeIssue, transformIssueDataForAnalysis } from './issue-analysis';
import { getDriver, ingestMultipleIssues } from './neo4j';
import { applyCategoryRules } from './rules';
import { ensureVocabulary } from './subcategory';

export interface StaleIssue {
  number: number;
  storedUpdatedAt: string | null;
  liveUpdatedAt: string;
}

export interface RefreshResult {
  checked: number;
  stale: StaleIssue[];
  refreshed: number[];
  analyzed: number;
  errors: string[];
  dryRun: boolean;
}

const BATCH = 50;

async function fetchUpdatedAt(
  owner: string,
  repo: string,
  numbers: number[],
): Promise<Map<number, string>> {
  const live = new Map<number, string>();

  for (let i = 0; i < numbers.length; i += BATCH) {
    const fields = numbers
      .slice(i, i + BATCH)
      .map((n) => `i${n}: issue(number:${n}){ number updatedAt }`)
      .join('\n');

    const res = await fetchWithRetry(
      () =>
        fetch('https://api.github.com/graphql', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            query: `query($owner:String!,$repo:String!){ repository(owner:$owner,name:$repo){ ${fields} } }`,
            variables: { owner, repo },
          }),
        }),
      'GitHub issue updatedAt',
    );
    if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);

    const json = (await res.json()) as {
      data?: { repository: Record<string, { number: number; updatedAt: string } | null> };
      errors?: { message: string }[];
    };
    if (json.errors) throw new Error(`GraphQL: ${JSON.stringify(json.errors)}`);
    for (const v of Object.values(json.data?.repository ?? {})) {
      if (v) live.set(v.number, v.updatedAt);
    }
  }

  return live;
}

/** Pure comparison, so the staleness rule is testable without a graph or a network. */
export function findStale(
  stored: { number: number; updatedAt: string | null }[],
  live: Map<number, string>,
): StaleIssue[] {
  const stale: StaleIssue[] = [];
  for (const row of stored) {
    const liveUpdatedAt = live.get(row.number);
    if (liveUpdatedAt && liveUpdatedAt !== row.updatedAt) {
      stale.push({
        number: row.number,
        storedUpdatedAt: row.updatedAt,
        liveUpdatedAt,
      });
    }
  }
  return stale;
}

export async function refreshIssues(opts: {
  owner: string;
  repo: string;
  dryRun: boolean;
  /** Refresh exactly these, skipping staleness detection. */
  issueNumbers?: number[];
  /** Re-run classification on what was refreshed. Off by default: a changed body rarely changes the category, and analysis costs a model call per issue. */
  analyze?: boolean;
  limit?: number;
}): Promise<RefreshResult> {
  const { owner, repo, dryRun, issueNumbers, analyze = false, limit = 0 } = opts;
  const errors: string[] = [];

  const session = getDriver().session();
  let stored: { number: number; updatedAt: string | null }[];
  try {
    const res = await session.run(
      `MATCH (i:Issue)
       WHERE $numbers IS NULL OR i.number IN $numbers
       RETURN i.number AS number, i.updatedAt AS updatedAt ORDER BY i.number`,
      { numbers: issueNumbers ?? null },
    );
    stored = res.records.map((r) => ({
      number: neo4j.int(r.get('number')).toNumber(),
      updatedAt: r.get('updatedAt'),
    }));
  } finally {
    await session.close();
  }

  if (stored.length === 0) {
    return { checked: 0, stale: [], refreshed: [], analyzed: 0, errors, dryRun };
  }

  const live = await fetchUpdatedAt(
    owner,
    repo,
    stored.map((s) => s.number),
  );

  // An explicit list is a request to re-read those issues, not a question about
  // whether they changed, so skip detection and refresh them regardless.
  const stale = issueNumbers
    ? stored.map((s) => ({
        number: s.number,
        storedUpdatedAt: s.updatedAt,
        liveUpdatedAt: live.get(s.number) ?? s.updatedAt ?? '',
      }))
    : findStale(stored, live);

  const targets = (limit > 0 ? stale.slice(0, limit) : stale).map((s) => s.number);

  if (dryRun || targets.length === 0) {
    return { checked: stored.length, stale, refreshed: [], analyzed: 0, errors, dryRun };
  }

  const fetched = await getIssuesData(owner, repo, targets);
  for (const e of fetched.errors) errors.push(`fetch #${e.issueNumber}: ${e.error}`);

  const ingested = await ingestMultipleIssues(fetched.results);
  for (const e of ingested.errors) errors.push(`ingest #${e.issueNumber}: ${e.error}`);

  const refreshed = fetched.results.map((f) => f.issue.number);
  let analyzed = 0;

  if (analyze && refreshed.length > 0) {
    const vocabulary = await ensureVocabulary(false, new Date().toISOString());
    const guidance = renderGuidance(await listGuidance());
    const details = await fetchMultipleIssueDetails(refreshed);
    const analyses: AnalysisData[] = [];

    for (const detail of details.results) {
      try {
        const result = await analyzeIssue(
          transformIssueDataForAnalysis(detail),
          vocabulary,
          guidance,
        );
        analyses.push({
          issueNumber: detail.issue.number,
          title: detail.issue.title,
          analysis: result.analysis,
        });
      } catch (err) {
        errors.push(
          `analysis #${detail.issue.number}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (analyses.length > 0) {
      const written = await ingestAnalysisResults(analyses);
      for (const e of written.errors) errors.push(`analysis-ingest #${e.issueNumber}: ${e.error}`);
      // Standing rules outrank a fresh classification, same as in the pipeline.
      await applyCategoryRules(refreshed);
    }
    analyzed = analyses.length;
  }

  return { checked: stored.length, stale, refreshed, analyzed, errors, dryRun: false };
}
