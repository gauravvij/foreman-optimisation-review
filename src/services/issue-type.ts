/**
 * Backfills the work kind and clarification flag onto issues classified before
 * those fields existed.
 *
 * Kept separate from the full analysis pass because re-running that costs a
 * large model call per issue to re-derive fields that have not changed. This
 * asks for two judgments from the title and body alone, so an existing corpus
 * can be brought up to date cheaply and incrementally.
 */

import neo4j from 'neo4j-driver';
import { listGuidance, renderGuidance } from './guidance';
import { WRITE_INTERVAL_MS, githubGraphQL, sleep } from './http';
import { ISSUE_TYPES, type IssueTypeName } from './issue-analysis';
import { structuredCompletion } from './models';
import { getDriver } from './neo4j';
import { progress } from './progress';

export interface TypeJudgment {
  issueType: IssueTypeName;
  needsClarification: boolean;
  clarificationReason: string;
}

export interface TypeBackfillResult {
  missing: number[];
  classified: { number: number; issueType: string; needsClarification: boolean }[];
  remaining: number;
  errors: string[];
  dryRun: boolean;
}

const SCHEMA = {
  type: 'object' as const,
  properties: {
    issueType: {
      type: 'string' as const,
      enum: ISSUE_TYPES,
      description: 'What kind of work this is',
    },
    needsClarification: {
      type: 'boolean' as const,
      description: 'True when the issue cannot be acted on as written',
    },
    clarificationReason: {
      type: 'string' as const,
      description: 'What is missing, or an empty string when nothing is',
    },
  },
  required: ['issueType', 'needsClarification', 'clarificationReason'] as const,
  additionalProperties: false,
};

/** Open issues that have been analyzed but carry no work kind yet. */
export async function findUntyped(
  numbers?: number[],
): Promise<{ number: number; title: string; body: string }[]> {
  const session = getDriver().session({ defaultAccessMode: neo4j.session.READ });
  try {
    const result = await session.run(
      `MATCH (i:Issue)
       WHERE i.state = 'OPEN' AND i.issueType IS NULL
         AND ($numbers IS NULL OR i.number IN $numbers)
       RETURN i.number AS number, i.title AS title, i.bodyText AS body
       ORDER BY i.number`,
      { numbers: numbers && numbers.length > 0 ? numbers : null },
    );
    return result.records.map((r) => ({
      number: neo4j.int(r.get('number')).toNumber(),
      title: (r.get('title') as string | null) ?? '',
      body: (r.get('body') as string | null) ?? '',
    }));
  } finally {
    await session.close();
  }
}

export async function classifyType(
  issue: { number: number; title: string; body: string },
  guidance: string,
): Promise<TypeJudgment> {
  const { data } = await structuredCompletion<TypeJudgment>({
    task: 'analysis',
    system:
      'You classify GitHub issues. Judge only what the issue text supports, and prefer task when a request is neither a defect nor new behavior.',
    prompt: `Classify this issue.

Title: ${issue.title}

Body:
${issue.body.slice(0, 6000)}

IssueType — what kind of work this is:
- bug: something behaves differently from how it is supposed to
- feature: a request for behavior that does not exist yet
- task: work with no behavior change of its own, such as a chore, refactor,
  dependency bump, or documentation

NeedsClarification: true when the issue cannot be acted on as written, because
what is being asked, or how to reproduce it, is missing. Judge the issue as
written; do not mark it merely because you lack context on the codebase. When
true, give the one thing that is missing in ClarificationReason. When false,
ClarificationReason is an empty string.${guidance}`,
    name: 'issue_type',
    schema: SCHEMA,
  });
  return data;
}

async function store(number: number, judgment: TypeJudgment): Promise<void> {
  const session = getDriver().session();
  try {
    await session.run(
      `MATCH (i:Issue {number: $n})
       SET i.issueType = $issueType,
           i.needsClarification = $needsClarification,
           i.clarificationReason = $clarificationReason`,
      {
        n: number,
        issueType: judgment.issueType,
        needsClarification: judgment.needsClarification,
        clarificationReason: judgment.clarificationReason || null,
      },
    );
  } finally {
    await session.close();
  }
}

export interface TypeBackfillOptions {
  dryRun: boolean;
  limit?: number;
  issueNumbers?: number[];
}

/** Classifies untyped issues, one model call each, and records the result. */
export async function backfillIssueTypes(opts: TypeBackfillOptions): Promise<TypeBackfillResult> {
  const { dryRun, limit, issueNumbers } = opts;
  const errors: string[] = [];

  const untyped = await findUntyped(issueNumbers);
  const batch = typeof limit === 'number' ? untyped.slice(0, limit) : untyped;

  const base = {
    missing: untyped.map((i) => i.number),
    remaining: untyped.length - batch.length,
    errors,
  };

  if (dryRun || batch.length === 0) {
    return { ...base, classified: [], dryRun };
  }

  const guidance = renderGuidance(await listGuidance());
  const classified: TypeBackfillResult['classified'] = [];
  const report = progress('classifyIssueTypes', batch.length);

  for (const issue of batch) {
    try {
      const judgment = await classifyType(issue, guidance);
      await store(issue.number, judgment);
      classified.push({
        number: issue.number,
        issueType: judgment.issueType,
        needsClarification: judgment.needsClarification,
      });
      report.step(
        `#${issue.number} -> ${judgment.issueType}${judgment.needsClarification ? ' (needs clarification)' : ''}`,
      );
    } catch (err: unknown) {
      const detail = `#${issue.number}: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(detail);
      report.fail(detail);
    }
  }

  report.done();

  return { ...base, classified, dryRun };
}

// ---------------------------------------------------------------------------
// Writing the work kind back to GitHub
// ---------------------------------------------------------------------------

export interface TypeChange {
  issueNumber: number;
  from: string | null;
  to: string;
}

export interface TypeSyncResult {
  planned: TypeChange[];
  applied: number;
  /** Issues left alone because a person had already set a type. */
  keptExisting: number;
  /** Derived kinds the repository has no issue type for. */
  unmapped: string[];
  remaining: number;
  repoTypes: string[];
  dryRun: boolean;
  errors: string[];
}

/** The repository's own issue types, keyed by lowercase name. */
export async function fetchRepoIssueTypes(
  owner: string,
  repo: string,
): Promise<Map<string, { id: string; name: string }>> {
  const data = await githubGraphQL<{
    repository: {
      issueTypes: { nodes: { id: string; name: string; isEnabled: boolean }[] };
    } | null;
  }>(
    `query($owner:String!, $repo:String!) {
       repository(owner:$owner, name:$repo) {
         issueTypes(first:20) { nodes { id name isEnabled } }
       }
     }`,
    { owner, repo },
    'GitHub issue types',
  );

  const nodes = data.repository?.issueTypes?.nodes ?? [];
  return new Map(
    nodes.filter((t) => t.isEnabled).map((t) => [t.name.toLowerCase(), { id: t.id, name: t.name }]),
  );
}

/** Open issues carrying a classified kind, with the id and kind GitHub has. */
async function loadTypedIssues(
  issueNumbers?: number[],
): Promise<{ number: number; issueType: string }[]> {
  const session = getDriver().session({ defaultAccessMode: neo4j.session.READ });
  try {
    const result = await session.run(
      `MATCH (i:Issue)
       WHERE i.state = 'OPEN' AND i.issueType IS NOT NULL
         AND ($numbers IS NULL OR i.number IN $numbers)
       RETURN i.number AS number, i.issueType AS issueType
       ORDER BY i.number`,
      { numbers: issueNumbers && issueNumbers.length > 0 ? issueNumbers : null },
    );
    return result.records.map((r) => ({
      number: neo4j.int(r.get('number')).toNumber(),
      issueType: r.get('issueType') as string,
    }));
  } finally {
    await session.close();
  }
}

const ID_CHUNK = 50;

/** Node id and current type for each issue, needed to plan and to write. */
async function fetchIssueTypeState(
  owner: string,
  repo: string,
  numbers: number[],
): Promise<Map<number, { id: string; type: string | null }>> {
  const state = new Map<number, { id: string; type: string | null }>();

  for (let i = 0; i < numbers.length; i += ID_CHUNK) {
    const chunk = numbers.slice(i, i + ID_CHUNK);
    const aliases = chunk
      .map((n) => `i${n}: issue(number:${n}) { id number issueType { name } }`)
      .join('\n    ');

    const data = await githubGraphQL<{
      repository: Record<
        string,
        { id: string; number: number; issueType: { name: string } | null } | null
      > | null;
    }>(
      `query($owner:String!, $repo:String!) {
         repository(owner:$owner, name:$repo) {
    ${aliases}
         }
       }`,
      { owner, repo },
      'GitHub issue types state',
    );

    for (const value of Object.values(data.repository ?? {})) {
      if (!value?.id) continue;
      state.set(value.number, { id: value.id, type: value.issueType?.name ?? null });
    }
  }

  return state;
}

export interface TypeSyncOptions {
  owner: string;
  repo: string;
  dryRun: boolean;
  limit?: number;
  issueNumbers?: number[];
  /** Also replace a type already set on the issue. Off by default. */
  overwrite?: boolean;
}

/**
 * Writes the classified kind to GitHub's own issue type field.
 *
 * A type someone already set is left alone unless `overwrite` is on, because
 * unlike a board field this is on the issue itself, where a human choice is
 * the more likely one to be right.
 */
export async function syncIssueTypes(opts: TypeSyncOptions): Promise<TypeSyncResult> {
  const { owner, repo, dryRun, limit, issueNumbers, overwrite } = opts;
  const errors: string[] = [];

  const repoTypes = await fetchRepoIssueTypes(owner, repo);
  if (repoTypes.size === 0) {
    throw new Error(`${owner}/${repo} has no enabled issue types, so none can be set`);
  }

  const classified = await loadTypedIssues(issueNumbers);
  const state = await fetchIssueTypeState(
    owner,
    repo,
    classified.map((c) => c.number),
  );

  const unmapped = new Set<string>();
  const all: TypeChange[] = [];
  let keptExisting = 0;

  for (const { number, issueType } of classified) {
    const target = repoTypes.get(issueType.toLowerCase());
    if (!target) {
      unmapped.add(issueType);
      continue;
    }
    const current = state.get(number);
    if (!current) continue;
    if (current.type === target.name) continue;
    if (current.type !== null && !overwrite) {
      keptExisting++;
      continue;
    }
    all.push({ issueNumber: number, from: current.type, to: target.name });
  }

  const planned = typeof limit === 'number' ? all.slice(0, limit) : all;
  const base = {
    planned,
    keptExisting,
    unmapped: [...unmapped].sort(),
    remaining: all.length - planned.length,
    repoTypes: [...repoTypes.values()].map((t) => t.name),
    errors,
  };

  if (dryRun || planned.length === 0) return { ...base, applied: 0, dryRun };

  let applied = 0;
  const report = progress('applyIssueTypeSync', planned.length);

  for (const change of planned) {
    const target = repoTypes.get(change.to.toLowerCase());
    const node = state.get(change.issueNumber);
    if (!target || !node) {
      report.fail(`#${change.issueNumber}: no issue type or node id to write with`);
      continue;
    }
    try {
      await githubGraphQL(
        `mutation($issue:ID!, $type:ID!) {
           updateIssueIssueType(input:{issueId:$issue, issueTypeId:$type}) { issue { number } }
         }`,
        { issue: node.id, type: target.id },
        'GitHub issue type write',
      );
      applied++;
      report.step(`#${change.issueNumber} ${change.from ?? '(none)'} -> ${change.to}`);
      await sleep(WRITE_INTERVAL_MS);
    } catch (err: unknown) {
      const detail = `#${change.issueNumber}: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(detail);
      report.fail(detail);
    }
  }

  report.done();
  return { ...base, applied, dryRun };
}
