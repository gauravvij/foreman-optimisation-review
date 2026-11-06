/**
 * Pipeline orchestrator — ties together GitHub fetch, Neo4j ingest,
 * model analysis, and analysis ingestion into a single end-to-end flow.
 *
 * Supports incremental sync: when a previous run's timestamp is found in
 * Neo4j (Meta node), only issues updated since then are fetched and
 * re-analyzed. The first run always does a full sync.
 */

import { type AnalysisData, ingestAnalysisResults } from './analysis';
import { type IssueState, getAllIssueNumbers, getIssuesData, getPullRequests } from './github';
import { listGuidance, renderGuidance } from './guidance';
import { analyzeIssue, transformIssueDataForAnalysis } from './issue-analysis';
import { modelFor } from './models';
import {
  type IssueData,
  getIssueUpdatedAtBatch,
  getLastPullRequestSyncTimestamp,
  getLastSyncTimestamp,
  ingestMultipleIssues,
  ingestPullRequests,
  setLastPullRequestSyncTimestamp,
  setLastSyncTimestamp,
  setupDatabaseSchema,
} from './neo4j';
import { applyCategoryRules } from './rules';
import { ensureVocabulary } from './subcategory';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PipelineConfig {
  /** GitHub repo owner (e.g. "octocat") */
  owner: string;
  /** GitHub repo name (e.g. "hello-world") */
  repo: string;
  /** Which issue states to ingest */
  state: IssueState;
  /** Max issues to process (0 = all). Useful for testing. */
  limit: number;
  /** Whether to run model analysis after ingestion */
  analyze: boolean;
  /** Force full sync even if a lastSync timestamp exists */
  fullSync?: boolean;
  /** Re-derive the subcategory vocabulary instead of reusing the persisted one */
  refreshVocabulary?: boolean;
}

export interface PipelineResult {
  issuesFetched: number;
  issuesIngested: number;
  issuesAnalyzed: number;
  issuesSkipped: number;
  pullRequestsFetched: number;
  pullRequestsIngested: number;
  errors: string[];
  durationMs: number;
  incremental: boolean;
}

/**
 * The slice of issue data the analysis stage consumes.
 *
 * Structurally the same shape `transformIssueDataForAnalysis` accepts, so the
 * fetched data can be handed over directly. It mirrors DbIssueDetails, which is
 * what the removed read-back used to produce: the graph read returned exactly
 * these fields because they are exactly what the previous write had put there.
 */
interface AnalysisDetail {
  issue: { issueId: string; number: number; title: string; bodyText: string | null };
  labels: string[];
  comments: { commentId: string; authorLogin: string | null; bodyText: string | null }[];
}

/**
 * Maps freshly fetched GitHub data onto the analysis stage's input.
 *
 * Comments are ordered oldest-first, matching what the read-back did: it sorted
 * by createdAt before handing comments on, and comment order is visible to the
 * model, so an unsorted handoff would change the prompt.
 */
function toAnalysisDetail({ issue, comments }: IssueData): AnalysisDetail {
  return {
    issue: {
      issueId: issue.id,
      number: issue.number,
      title: issue.title,
      bodyText: issue.bodyText ?? null,
    },
    labels: (issue.labels?.nodes ?? []).map((l) => l.name),
    // Sort before mapping, on the same key the read-back sorted on, so the
    // model sees comments in the order it used to.
    comments: [...comments]
      .sort((a, b) => new Date(a.createdAt ?? '').getTime() - new Date(b.createdAt ?? '').getTime())
      .map((c) => ({
        commentId: c.id,
        authorLogin: c.author?.login ?? null,
        bodyText: c.bodyText ?? null,
      })),
  };
}

// ---------------------------------------------------------------------------
// Full pipeline
// ---------------------------------------------------------------------------

export async function runPipeline(config: PipelineConfig): Promise<PipelineResult> {
  const start = Date.now();
  const runTimestamp = new Date().toISOString();
  const errors: string[] = [];

  // Read lastSync to determine if this is incremental
  let since: string | null = null;
  if (!config.fullSync) {
    try {
      since = await getLastSyncTimestamp();
    } catch {
      // Neo4j may not be ready yet on first run — fall through to full sync
    }
  }
  const incremental = !!since;

  console.log('\n========================================');
  console.log(' Foreman — Ingestion Pipeline');
  console.log('========================================');
  console.log(`  Repo:    ${config.owner}/${config.repo}`);
  console.log(`  State:   ${config.state}`);
  console.log(`  Limit:   ${config.limit || 'all'}`);
  console.log(`  Analyze: ${config.analyze}`);
  console.log(`  Mode:    ${incremental ? `incremental (since ${since})` : 'full sync'}`);
  console.log('========================================\n');

  // Schema bootstrap. Runs once per process, before the first write, and costs
  // twelve `IF NOT EXISTS` statements. Applying it here rather than inside the
  // ingest loop keeps it off the per-issue path: a graph that is already
  // constrained pays one failed-create check each, not one per issue.
  console.log('Applying graph schema (constraints + indexes)...');
  const schema = await setupDatabaseSchema();
  if (schema.ran) {
    if (schema.failures.length > 0) {
      console.warn(
        `  Schema bootstrap: ${schema.failures.length} statement(s) failed — graph is usable but not fully constrained`,
      );
      for (const f of schema.failures) errors.push(`schema: ${f.statement}`);
    } else {
      console.log('  Schema in place');
    }
  }

  // 1. Discover issue numbers
  console.log('Step 1/5: Discovering issues...');
  const listing = await getAllIssueNumbers(
    config.owner,
    config.repo,
    config.state,
    config.limit,
    since,
  );
  const numbers = listing.issueNumbers;
  console.log(`  Will process ${numbers.length} issues\n`);

  if (numbers.length === 0) {
    if (incremental) {
      console.log('  No issues updated since last sync — nothing to do.\n');
      await setLastSyncTimestamp(runTimestamp);
    }
    const prs = await syncPullRequests(config, runTimestamp, errors);
    return {
      issuesFetched: 0,
      issuesIngested: 0,
      issuesAnalyzed: 0,
      issuesSkipped: 0,
      pullRequestsFetched: prs.fetched,
      pullRequestsIngested: prs.ingested,
      errors,
      durationMs: Date.now() - start,
      incremental,
    };
  }

  // 2. Fetch full issue data from GitHub
  console.log('Step 2/5: Fetching issue data from GitHub...');
  const fetched = await getIssuesData(config.owner, config.repo, numbers);
  for (const e of fetched.errors) errors.push(`fetch #${e.issueNumber}: ${e.error}`);
  console.log(`  Fetched ${fetched.results.length} issues\n`);

  // 3. Ingest into Neo4j
  //
  // Before writing, snapshot the updatedAt values already in the graph. The
  // incremental-skip decision in step 4 compares "what GitHub says now" against
  // "what we last stored", and ingestion overwrites the stored value. Reading
  // after ingestion would compare the new value against itself, so every issue
  // would look unchanged and nothing would ever be re-analysed. One batched
  // statement replaces the previous per-issue read.
  const previousUpdatedAt = incremental
    ? await getIssueUpdatedAtBatch(fetched.results.map((f) => f.issue.number))
    : new Map<number, string>();

  console.log('Step 3/5: Ingesting into Neo4j...');
  const ingested = await ingestMultipleIssues(fetched.results);
  for (const e of ingested.errors) errors.push(`ingest #${e.issueNumber}: ${e.error}`);
  console.log(`  Ingested ${ingested.results.length} issues\n`);

  let analysisCount = 0;
  let skippedCount = 0;

  if (config.analyze) {
    // 4. Run model analysis — skip issues whose updatedAt hasn't changed
    console.log(`Step 4/5: Running model analysis (${modelFor('analysis')})...`);
    const vocabulary = await ensureVocabulary(config.refreshVocabulary ?? false, runTimestamp);
    const guidance = renderGuidance(await listGuidance());
    if (guidance) console.log('  Applying standing classification guidance');
    // Hand the analysis stage the data we already fetched and just wrote,
    // instead of reading every issue back out of the graph. The read-back was
    // one session and one statement per issue to fetch values this process was
    // still holding in memory, and it could only ever return what this run had
    // just written.
    //
    // Order is preserved: ingested.results is in listing order, and each entry
    // is resolved back to its fetched issue by id.
    const analysisDetails: AnalysisDetail[] = [];
    for (const r of ingested.results) {
      const match = fetched.results.find((f) => f.issue.id === r.issueId);
      if (match) analysisDetails.push(toAnalysisDetail(match));
    }

    // Build a map of issue number -> new updatedAt from the fetched data
    const updatedAtMap = new Map<number, string>();
    for (const { issue } of fetched.results) {
      updatedAtMap.set(issue.number, issue.updatedAt);
    }

    const analysisResults: AnalysisData[] = [];

    for (const detail of analysisDetails) {
      try {
        // In incremental mode, skip analysis if the issue's updatedAt hasn't
        // changed since the previous run. The comparison uses the snapshot
        // taken before ingestion — reading the graph here would return the
        // value step 3 just wrote and every issue would look unchanged.
        if (incremental) {
          const stored = previousUpdatedAt.get(detail.issue.number);
          const currentUpdatedAt = updatedAtMap.get(detail.issue.number);
          if (stored && currentUpdatedAt && stored === currentUpdatedAt) {
            console.log(`  Skipping issue #${detail.issue.number} (unchanged)`);
            skippedCount++;
            continue;
          }
        }

        const transformed = transformIssueDataForAnalysis(detail);
        console.log(`  Analyzing issue #${detail.issue.number}: ${detail.issue.title}`);
        const result = await analyzeIssue(transformed, vocabulary, guidance);
        analysisResults.push({
          issueNumber: detail.issue.number,
          title: detail.issue.title,
          analysis: result.analysis,
        });
        analysisCount++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  Analysis failed for #${detail.issue.number}: ${msg}`);
        errors.push(`analysis #${detail.issue.number}: ${msg}`);
      }
    }

    // 5. Ingest analysis results
    if (analysisResults.length > 0) {
      console.log('\nStep 5/5: Ingesting analysis results...');
      const analysisIngested = await ingestAnalysisResults(analysisResults);
      for (const e of analysisIngested.errors) {
        errors.push(`analysis-ingest #${e.issueNumber}: ${e.error}`);
      }
    }
  } else {
    console.log('Step 4/5: Skipped (analysis disabled)');
    console.log('Step 5/5: Skipped (analysis disabled)');
  }

  // Standing rules are corrections to the model, so they are applied last and
  // overwrite whatever it just decided.
  const ruleChanges = await applyCategoryRules();
  if (ruleChanges.length > 0) {
    console.log(`\nApplied category rules to ${ruleChanges.length} issue(s):`);
    for (const c of ruleChanges) {
      console.log(`  #${c.issueNumber}: ${c.from ?? 'none'} -> ${c.to} (label: ${c.label})`);
    }
  }

  // Record this run's timestamp for the next incremental sync
  await setLastSyncTimestamp(runTimestamp);

  const prs = await syncPullRequests(config, runTimestamp, errors);

  const durationMs = Date.now() - start;

  console.log('\n========================================');
  console.log(' Pipeline Complete');
  console.log('========================================');
  console.log(`  Mode:                 ${incremental ? 'incremental' : 'full sync'}`);
  console.log(`  Issues fetched:       ${fetched.results.length}`);
  console.log(`  Issues ingested:      ${ingested.results.length}`);
  console.log(`  Issues analyzed:      ${analysisCount}`);
  if (skippedCount > 0) {
    console.log(`  Issues skipped:       ${skippedCount} (unchanged)`);
  }
  console.log(`  Pull requests found:  ${prs.fetched}`);
  console.log(`  Pull requests stored: ${prs.ingested}`);
  console.log(`  Errors:               ${errors.length}`);
  console.log(`  Duration:             ${(durationMs / 1000).toFixed(1)}s`);
  console.log('========================================\n');

  return {
    issuesFetched: fetched.results.length,
    issuesIngested: ingested.results.length,
    issuesAnalyzed: analysisCount,
    issuesSkipped: skippedCount,
    pullRequestsFetched: prs.fetched,
    pullRequestsIngested: prs.ingested,
    errors,
    durationMs,
    incremental,
  };
}

/**
 * Fetches pull requests (incremental when a prior sync exists) and ingests
 * them. Runs after the issue pipeline so a PR's CLOSES link lands on an issue
 * that already exists. Pull request errors push onto `errors` but do not fail
 * the pipeline.
 */
async function syncPullRequests(
  config: PipelineConfig,
  runTimestamp: string,
  errors: string[],
): Promise<{ fetched: number; ingested: number }> {
  console.log('\nStep PR: Syncing pull requests...');

  let since: string | null = null;
  if (!config.fullSync) {
    try {
      since = await getLastPullRequestSyncTimestamp();
    } catch {
      // Carry on with a full fetch when the Meta key is unreadable.
    }
  }

  try {
    // Pull requests are typically a small fraction of the issue count, so the
    // issue-side debug cap (`config.limit`) is not applied here. Capping PRs
    // left the graph short of OPEN rows and made total-open queries wrong.
    const prs = await getPullRequests(config.owner, config.repo, since);
    const result = await ingestPullRequests(prs);
    for (const e of result.errors) errors.push(`pr ingest #${e.number}: ${e.error}`);
    await setLastPullRequestSyncTimestamp(runTimestamp);
    return { fetched: prs.length, ingested: result.ingested };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  Pull request sync failed: ${msg}`);
    errors.push(`pr sync: ${msg}`);
    return { fetched: 0, ingested: 0 };
  }
}
