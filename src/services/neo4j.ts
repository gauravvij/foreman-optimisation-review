/**
 * Neo4j write operations — ingests GitHub issue and pull request data into
 * the knowledge graph.
 *
 * Graph schema:
 *   Nodes:  Issue, PullRequest, Comment, User, Label, Reaction
 *   Rels:   AUTHORED_BY, ASSIGNED_TO, HAS_LABEL, HAS_COMMENT, HAS_REACTION, CLOSES
 */

import neo4j, { type Driver, type Integer, type Session } from 'neo4j-driver';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitHubUser {
  login: string;
  name?: string | null;
  company?: string | null;
}

export interface GitHubLabel {
  name: string;
  description?: string | null;
  color?: string | null;
}

export interface GitHubReaction {
  content: string;
  user: { login: string } | null;
}

export interface GitHubComment {
  id: string;
  bodyText: string;
  createdAt: string;
  author: GitHubUser | null;
  reactions?: { nodes: GitHubReaction[]; totalCount: number };
}

export interface GitHubIssue {
  id: string;
  number: number;
  title: string;
  bodyText: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  state: string;
  author: GitHubUser | null;
  assignees?: { nodes: GitHubUser[] } | null;
  labels?: { nodes: GitHubLabel[] };
  reactions?: { nodes: GitHubReaction[]; totalCount: number };
  totalComments: number;
}

export interface IssueData {
  issue: GitHubIssue;
  comments: GitHubComment[];
}

export interface GitHubPullRequest {
  id: string;
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  author: GitHubUser | null;
  assignees?: { nodes: GitHubUser[] } | null;
  labels?: { nodes: GitHubLabel[] };
  closingIssuesReferences?: { nodes: { number: number }[] };
}

export interface IngestionResult {
  success: boolean;
  issueId: string;
  commentCount: number;
  metadata: {
    labels: number;
    issueReactions: number;
    commentReactions: number;
    uniqueUsers: number;
  };
}

// ---------------------------------------------------------------------------
// Driver singleton
// ---------------------------------------------------------------------------

let _driver: Driver | null = null;

export function getDriver(): Driver {
  if (_driver) return _driver;

  const host = process.env.NEO4J_HOST || 'localhost';
  const uri = process.env.NEO4J_URI || `bolt://${host}:7687`;
  const username = process.env.NEO4J_USERNAME || 'neo4j';
  const password = process.env.NEO4J_PASSWORD;
  const authEnabled = process.env.NEO4J_AUTH !== undefined && process.env.NEO4J_AUTH !== 'none';

  const auth = authEnabled ? neo4j.auth.basic(username, password || '') : undefined;

  _driver = neo4j.driver(uri, auth);
  return _driver;
}

export async function closeDriver(): Promise<void> {
  if (_driver) {
    await _driver.close();
    _driver = null;
  }
}

// ---------------------------------------------------------------------------
// Schema bootstrap
// ---------------------------------------------------------------------------

/**
 * The graph is written with MERGE only, and every MERGE anchors on a property
 * (`{issueId: …}`, `{login: …}`, `{commentId: …}`). Without a constraint or
 * index behind that property, each MERGE is a full scan of its label, and
 * nothing stops two concurrent writers creating the same logical node twice.
 *
 * These constraints therefore do two jobs: they make the anchored MERGE lookups
 * index-backed, and they make duplicate nodes impossible rather than merely
 * unlikely. The property names are taken from the MERGE statements in this
 * file, not invented.
 *
 * Deliberately not constrained here: Reaction ({content, issueId, userLogin}),
 * Competitor.name, Category.name, Keyword.name and Rule ({kind, label}). They
 * are legitimate MERGE keys too, but this bootstrap is scoped to the ten that
 * cover node identity and the issue/PR ingest path; extending it is a separate
 * change that also needs a de-dup migration for existing graphs.
 */
const SCHEMA_STATEMENTS: readonly string[] = [
  // --- Constraints: node identity (one logical node per key) ----------------
  'CREATE CONSTRAINT issue_id_unique IF NOT EXISTS FOR (n:Issue) REQUIRE n.issueId IS UNIQUE',
  'CREATE CONSTRAINT issue_number_unique IF NOT EXISTS FOR (n:Issue) REQUIRE n.number IS UNIQUE',
  'CREATE CONSTRAINT user_login_unique IF NOT EXISTS FOR (n:User) REQUIRE n.login IS UNIQUE',
  'CREATE CONSTRAINT comment_id_unique IF NOT EXISTS FOR (n:Comment) REQUIRE n.commentId IS UNIQUE',
  'CREATE CONSTRAINT label_name_unique IF NOT EXISTS FOR (n:Label) REQUIRE n.name IS UNIQUE',
  'CREATE CONSTRAINT pull_request_id_unique IF NOT EXISTS FOR (n:PullRequest) REQUIRE n.prId IS UNIQUE',
  'CREATE CONSTRAINT meta_key_unique IF NOT EXISTS FOR (n:Meta) REQUIRE n.key IS UNIQUE',
  'CREATE CONSTRAINT subcategory_name_unique IF NOT EXISTS FOR (n:Subcategory) REQUIRE n.name IS UNIQUE',
  'CREATE CONSTRAINT solution_text_unique IF NOT EXISTS FOR (n:Solution) REQUIRE n.solutionText IS UNIQUE',
  'CREATE CONSTRAINT workaround_text_unique IF NOT EXISTS FOR (n:Workaround) REQUIRE n.workaroundText IS UNIQUE',

  // --- Indexes: the two predicates the pipeline filters on ------------------
  // ensureVocabulary() and the agent read whole labels by state; the incremental
  // sync (getLastSyncTimestamp) and any since-filter walk updatedAt.
  'CREATE INDEX issue_state_lookup IF NOT EXISTS FOR (n:Issue) ON (n.state)',
  'CREATE INDEX issue_updated_at_lookup IF NOT EXISTS FOR (n:Issue) ON (n.updatedAt)',
];

/** Set once a bootstrap attempt has succeeded, so repeated calls are free. */
let _schemaEnsured = false;

export interface SchemaSetupResult {
  /** False when an earlier call in this process already applied the schema. */
  ran: boolean;
  /** Statements that failed, with Neo4j's message. Empty on a clean bootstrap. */
  failures: { statement: string; error: string }[];
}

/**
 * Applies the constraint/index bootstrap once per process.
 *
 * Idempotent twice over: `IF NOT EXISTS` makes re-running against an existing
 * schema a no-op, and the module flag makes a second call in the same process
 * issue no statements at all.
 *
 * Failures are collected rather than thrown. A uniqueness constraint cannot be
 * created over a graph that already holds duplicates, and aborting the whole
 * pipeline over that would take ingestion down for exactly the deployments that
 * need it most. Callers that care can inspect `failures`; the pipeline logs them
 * as warnings. The `IF NOT EXISTS` form is what makes this safe to call on a
 * graph that already has some of these objects.
 */
export async function setupDatabaseSchema(): Promise<SchemaSetupResult> {
  if (_schemaEnsured) return { ran: false, failures: [] };

  const session = getDriver().session();
  const failures: { statement: string; error: string }[] = [];
  try {
    for (const statement of SCHEMA_STATEMENTS) {
      try {
        await session.run(statement);
      } catch (err: unknown) {
        const error = err instanceof Error ? err.message : String(err);
        failures.push({ statement, error });
        console.warn(`  Schema statement failed: ${statement}`);
        console.warn(`    ${error}`);
      }
    }
    // Only latch on success: a transient failure should be retried next call
    // rather than silently leaving the graph unconstrained for the process.
    if (failures.length === 0) _schemaEnsured = true;
  } finally {
    await session.close();
  }

  return { ran: true, failures };
}

/** Test seam: forget that the schema was applied. */
export function resetSchemaCache(): void {
  _schemaEnsured = false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertUsers(session: Session, users: (GitHubUser | null)[]): Promise<string[]> {
  const validUsers = users.filter((u): u is GitHubUser => !!u?.login);
  if (validUsers.length === 0) return [];

  const result = await session.run(
    `UNWIND $users AS user
     MERGE (u:User {login: user.login})
     SET u.name = user.name, u.company = user.company
     RETURN u.login AS login`,
    { users: validUsers },
  );
  return result.records.map((r) => r.get('login') as string);
}

async function insertLabels(session: Session, labels: GitHubLabel[]): Promise<string[]> {
  if (labels.length === 0) return [];

  const result = await session.run(
    `UNWIND $labels AS label
     MERGE (l:Label {name: label.name})
     SET l.description = label.description, l.color = label.color
     RETURN l.name AS name`,
    { labels },
  );
  return result.records.map((r) => r.get('name') as string);
}

async function insertReactions(
  session: Session,
  reactions: GitHubReaction[],
  issueId: string,
  commentId: string | null = null,
): Promise<number> {
  const valid = reactions.filter((r) => r.user?.login);
  if (valid.length === 0) return 0;

  const result = await session.run(
    `UNWIND $reactions AS reaction
     MERGE (r:Reaction {content: reaction.content, issueId: $issueId, userLogin: reaction.userLogin})
     ON CREATE SET r.commentId = $commentId
     RETURN count(r) AS reactionCount`,
    {
      reactions: valid.map((r) => ({ content: r.content, userLogin: r.user!.login })),
      issueId,
      commentId,
    },
  );
  return (result.records[0].get('reactionCount') as Integer).toNumber();
}

// ---------------------------------------------------------------------------
// Issue ingestion
// ---------------------------------------------------------------------------

export async function insertIssue(session: Session, issue: GitHubIssue): Promise<void> {
  // 1. Upsert Issue node
  await session.run(
    `MERGE (i:Issue {issueId: $issueId})
     SET i.number    = toInteger($number),
         i.title     = $title,
         i.bodyText  = $bodyText,
         i.createdAt = $createdAt,
         i.updatedAt = $updatedAt,
         i.closedAt  = $closedAt,
         i.state     = $state,
         i.authorLogin = $authorLogin
     RETURN i`,
    {
      issueId: issue.id,
      number: issue.number,
      title: issue.title,
      bodyText: issue.bodyText,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      closedAt: issue.closedAt,
      state: issue.state,
      authorLogin: issue.author?.login ?? null,
    },
  );

  // 2. Author relationship
  if (issue.author?.login) {
    await insertUsers(session, [issue.author]);
    await session.run(
      `MATCH (i:Issue {issueId: $issueId}), (u:User {login: $login})
       MERGE (i)-[:AUTHORED_BY]->(u)`,
      { issueId: issue.id, login: issue.author.login },
    );
  }

  // 2b. Assignees. Every reassignment updates the issue's updatedAt, so the
  // incremental sync picks up the change; we still delete the old edges here
  // so an unassignment is reflected rather than leaving a stale link.
  const assignees = (issue.assignees?.nodes ?? []).filter((u): u is GitHubUser =>
    Boolean(u?.login),
  );
  await session.run('MATCH (i:Issue {issueId: $issueId})-[r:ASSIGNED_TO]->() DELETE r', {
    issueId: issue.id,
  });
  if (assignees.length > 0) {
    await insertUsers(session, assignees);
    await session.run(
      `MATCH (i:Issue {issueId: $issueId})
       UNWIND $logins AS login
       MATCH (u:User {login: login})
       MERGE (i)-[:ASSIGNED_TO]->(u)`,
      { issueId: issue.id, logins: assignees.map((u) => u.login) },
    );
  }

  // 3. Labels
  const labelNodes = issue.labels?.nodes ?? [];
  if (labelNodes.length > 0) {
    await insertLabels(session, labelNodes);
    await session.run(
      `MATCH (i:Issue {issueId: $issueId})
       UNWIND $names AS name
       MATCH (l:Label {name: name})
       MERGE (i)-[:HAS_LABEL]->(l)`,
      { issueId: issue.id, names: labelNodes.map((l) => l.name) },
    );
  }

  // 4. Issue reactions
  const reactionNodes = issue.reactions?.nodes ?? [];
  if (reactionNodes.length > 0) {
    await insertReactions(session, reactionNodes, issue.id);
    await session.run(
      `MATCH (i:Issue {issueId: $issueId})
       MATCH (r:Reaction {issueId: $issueId})
       WHERE r.commentId IS NULL
       MERGE (i)-[:HAS_REACTION]->(r)`,
      { issueId: issue.id },
    );
  }
}

async function insertComments(
  session: Session,
  issue: GitHubIssue,
  comments: GitHubComment[],
): Promise<number> {
  if (comments.length === 0) return 0;

  // 1. Upsert Comment nodes + link to Issue
  const result = await session.run(
    `UNWIND $comments AS c
     MERGE (comment:Comment {commentId: c.id})
     SET comment.bodyText  = c.bodyText,
         comment.createdAt = c.createdAt,
         comment.authorLogin = c.authorLogin
     WITH comment, c
     MATCH (i:Issue {issueId: $issueId})
     MERGE (i)-[:HAS_COMMENT]->(comment)
     RETURN count(comment) AS cnt`,
    {
      issueId: issue.id,
      comments: comments.map((c) => ({
        id: c.id,
        bodyText: c.bodyText,
        createdAt: c.createdAt,
        authorLogin: c.author?.login ?? null,
      })),
    },
  );
  const count = (result.records[0].get('cnt') as Integer).toNumber();

  // 2. Comment authors
  const authors = comments.filter((c) => c.author?.login).map((c) => c.author!);
  if (authors.length > 0) {
    await insertUsers(session, authors);
    await session.run(
      `UNWIND $items AS item
       MATCH (c:Comment {commentId: item.id}), (u:User {login: item.login})
       MERGE (c)-[:AUTHORED_BY]->(u)`,
      {
        items: comments
          .filter((c) => c.author?.login)
          .map((c) => ({ id: c.id, login: c.author!.login })),
      },
    );
  }

  // 3. Comment reactions
  for (const comment of comments) {
    const rxns = comment.reactions?.nodes ?? [];
    if (rxns.length > 0) {
      await insertReactions(session, rxns, issue.id, comment.id);
      await session.run(
        `MATCH (c:Comment {commentId: $cid})
         MATCH (r:Reaction {commentId: $cid})
         MERGE (c)-[:HAS_REACTION]->(r)`,
        { cid: comment.id },
      );
    }
  }

  return count;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function ingestIssueData(
  issue: GitHubIssue,
  comments: GitHubComment[],
): Promise<IngestionResult> {
  const session = getDriver().session();
  try {
    console.log(`  Ingesting issue #${issue.number}: ${issue.title}`);
    await insertIssue(session, issue);

    let commentCount = 0;
    if (comments.length > 0) {
      commentCount = await insertComments(session, issue, comments);
    }

    return {
      success: true,
      issueId: issue.id,
      commentCount,
      metadata: {
        labels: issue.labels?.nodes?.length ?? 0,
        issueReactions: issue.reactions?.nodes?.length ?? 0,
        commentReactions: comments.reduce((s, c) => s + (c.reactions?.nodes?.length ?? 0), 0),
        uniqueUsers: new Set(
          [
            issue.author?.login,
            ...comments.filter((c) => c.author?.login).map((c) => c.author!.login),
          ].filter(Boolean),
        ).size,
      },
    };
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// Sync metadata — tracks when the last successful pipeline run completed
// ---------------------------------------------------------------------------

export async function getLastSyncTimestamp(): Promise<string | null> {
  const session = getDriver().session();
  try {
    const result = await session.run(`MATCH (m:Meta {key: 'lastSync'}) RETURN m.value AS ts`);
    if (result.records.length === 0) return null;
    return result.records[0].get('ts') as string | null;
  } finally {
    await session.close();
  }
}

export async function setLastSyncTimestamp(iso: string): Promise<void> {
  const session = getDriver().session();
  try {
    await session.run(`MERGE (m:Meta {key: 'lastSync'}) SET m.value = $ts`, { ts: iso });
  } finally {
    await session.close();
  }
}

/**
 * Get the stored updatedAt for an issue, so we can skip re-analysis
 * if the issue hasn't changed since last ingestion.
 */
export async function getIssueUpdatedAt(issueNumber: number): Promise<string | null> {
  const session = getDriver().session();
  try {
    const result = await session.run('MATCH (i:Issue {number: $n}) RETURN i.updatedAt AS ts', {
      n: issueNumber,
    });
    if (result.records.length === 0) return null;
    return result.records[0].get('ts') as string | null;
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// Pull request ingestion
// ---------------------------------------------------------------------------

export async function insertPullRequest(session: Session, pr: GitHubPullRequest): Promise<void> {
  await session.run(
    `MERGE (pr:PullRequest {prId: $prId})
     SET pr.number       = toInteger($number),
         pr.title        = $title,
         pr.url          = $url,
         pr.state        = $state,
         pr.isDraft      = $isDraft,
         pr.isMerged     = $isMerged,
         pr.createdAt    = $createdAt,
         pr.updatedAt    = $updatedAt,
         pr.closedAt     = $closedAt,
         pr.mergedAt     = $mergedAt,
         pr.additions    = toInteger($additions),
         pr.deletions    = toInteger($deletions),
         pr.changedFiles = toInteger($changedFiles),
         pr.authorLogin  = $authorLogin
     RETURN pr`,
    {
      prId: pr.id,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.state,
      isDraft: pr.isDraft,
      isMerged: Boolean(pr.mergedAt),
      createdAt: pr.createdAt,
      updatedAt: pr.updatedAt,
      closedAt: pr.closedAt,
      mergedAt: pr.mergedAt,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
      authorLogin: pr.author?.login ?? null,
    },
  );

  if (pr.author?.login) {
    await insertUsers(session, [pr.author]);
    await session.run(
      `MATCH (pr:PullRequest {prId: $prId}), (u:User {login: $login})
       MERGE (pr)-[:AUTHORED_BY]->(u)`,
      { prId: pr.id, login: pr.author.login },
    );
  }

  const assignees = (pr.assignees?.nodes ?? []).filter((u): u is GitHubUser => Boolean(u?.login));
  await session.run('MATCH (pr:PullRequest {prId: $prId})-[r:ASSIGNED_TO]->() DELETE r', {
    prId: pr.id,
  });
  if (assignees.length > 0) {
    await insertUsers(session, assignees);
    await session.run(
      `MATCH (pr:PullRequest {prId: $prId})
       UNWIND $logins AS login
       MATCH (u:User {login: login})
       MERGE (pr)-[:ASSIGNED_TO]->(u)`,
      { prId: pr.id, logins: assignees.map((u) => u.login) },
    );
  }

  const labelNodes = pr.labels?.nodes ?? [];
  await session.run('MATCH (pr:PullRequest {prId: $prId})-[r:HAS_LABEL]->() DELETE r', {
    prId: pr.id,
  });
  if (labelNodes.length > 0) {
    await insertLabels(session, labelNodes);
    await session.run(
      `MATCH (pr:PullRequest {prId: $prId})
       UNWIND $names AS name
       MATCH (l:Label {name: name})
       MERGE (pr)-[:HAS_LABEL]->(l)`,
      { prId: pr.id, names: labelNodes.map((l) => l.name) },
    );
  }

  const closesNumbers = (pr.closingIssuesReferences?.nodes ?? [])
    .map((n) => n.number)
    .filter((n): n is number => typeof n === 'number');
  await session.run('MATCH (pr:PullRequest {prId: $prId})-[r:CLOSES]->() DELETE r', {
    prId: pr.id,
  });
  if (closesNumbers.length > 0) {
    await session.run(
      `MATCH (pr:PullRequest {prId: $prId})
       UNWIND $numbers AS n
       MATCH (i:Issue {number: toInteger(n)})
       MERGE (pr)-[:CLOSES]->(i)`,
      { prId: pr.id, numbers: closesNumbers },
    );
  }
}

export async function ingestPullRequests(prs: GitHubPullRequest[]): Promise<{
  ingested: number;
  errors: { number: number; error: string }[];
}> {
  if (prs.length === 0) return { ingested: 0, errors: [] };

  const session = getDriver().session();
  const errors: { number: number; error: string }[] = [];
  let ingested = 0;
  try {
    console.log(`\n=== Ingesting ${prs.length} pull requests into Neo4j ===`);
    for (let i = 0; i < prs.length; i++) {
      const pr = prs[i];
      try {
        console.log(`[${i + 1}/${prs.length}] PR #${pr.number}: ${pr.title}`);
        await insertPullRequest(session, pr);
        ingested++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  Failed PR #${pr.number}: ${msg}`);
        errors.push({ number: pr.number, error: msg });
      }
    }
    console.log(`\nPull request ingestion: ${ingested} ok, ${errors.length} failed`);
  } finally {
    await session.close();
  }
  return { ingested, errors };
}

/** The last successful pull request sync timestamp. Separate from the issue lastSync so a PR sync can lag an issue sync without resetting it. */
export async function getLastPullRequestSyncTimestamp(): Promise<string | null> {
  const session = getDriver().session();
  try {
    const result = await session.run(
      `MATCH (m:Meta {key: 'lastPullRequestSync'}) RETURN m.value AS ts`,
    );
    if (result.records.length === 0) return null;
    return result.records[0].get('ts') as string | null;
  } finally {
    await session.close();
  }
}

export async function setLastPullRequestSyncTimestamp(iso: string): Promise<void> {
  const session = getDriver().session();
  try {
    await session.run(`MERGE (m:Meta {key: 'lastPullRequestSync'}) SET m.value = $ts`, {
      ts: iso,
    });
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// Batched issue ingestion
// ---------------------------------------------------------------------------

/**
 * Issues per batch. Sized so an ordinary repo sync lands in a single managed
 * transaction: the cost batching removes is commit plus round-trip, and a chunk
 * boundary puts both back. Override with NEO4J_INGEST_BATCH_SIZE.
 */
const DEFAULT_INGEST_BATCH_SIZE = 250;

export function ingestBatchSize(): number {
  const raw = Number.parseInt(process.env.NEO4J_INGEST_BATCH_SIZE ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_INGEST_BATCH_SIZE;
}

/** Per-issue summary. Derived from the input data alone, so the batched and
 * per-issue paths necessarily agree on it. */
function summariseIngestion(issue: GitHubIssue, comments: GitHubComment[]): IngestionResult {
  return {
    success: true,
    issueId: issue.id,
    commentCount: comments.length,
    metadata: {
      labels: issue.labels?.nodes?.length ?? 0,
      issueReactions: issue.reactions?.nodes?.length ?? 0,
      commentReactions: comments.reduce((s, c) => s + (c.reactions?.nodes?.length ?? 0), 0),
      uniqueUsers: new Set(
        [
          issue.author?.login,
          ...comments.filter((c) => c.author?.login).map((c) => c.author!.login),
        ].filter(Boolean),
      ).size,
    },
  };
}

interface BatchStatement {
  query: string;
  params: Record<string, unknown>;
}

/**
 * Flattens a batch of issues into the statements that write them.
 *
 * This must produce the same graph as running `ingestIssueData` once per issue,
 * so every ordering rule of that path is reproduced rather than approximated:
 *
 *   - Users are collected author, assignees, comment authors — the same order
 *     the per-issue path calls insertUsers in — and duplicates are left in
 *     place. MERGE processes rows in order, so the last write wins, which is
 *     exactly what consecutive insertUsers calls did.
 *   - Reactions keep their (content, issueId, userLogin) merge key, and
 *     commentId is still set only ON CREATE. Issue-level reactions are listed
 *     before comment reactions so the same row wins that key first, as before.
 *   - ASSIGNED_TO is cleared for every issue in the batch unconditionally,
 *     because the per-issue path clears it unconditionally (that is what makes
 *     an unassignment take effect).
 *   - The two conditional link statements stay conditional on the same raw
 *     node counts the per-issue path tested, not on the user-filtered ones.
 */
export function planIssueBatch(issuesData: IssueData[]): BatchStatement[] {
  const issueRows: Record<string, unknown>[] = [];
  const users: GitHubUser[] = [];
  const authorLinks: { issueId: string; login: string }[] = [];
  const assigneeLinks: { issueId: string; login: string }[] = [];
  const labels: GitHubLabel[] = [];
  const labelLinks: { issueId: string; name: string }[] = [];
  const reactions: {
    issueId: string;
    content: string;
    userLogin: string;
    commentId: string | null;
  }[] = [];
  const issueReactionIssueIds: string[] = [];
  const comments: {
    id: string;
    issueId: string;
    bodyText: string;
    createdAt: string;
    authorLogin: string | null;
  }[] = [];
  const commentAuthorLinks: { id: string; login: string }[] = [];
  const commentReactionIds: string[] = [];

  for (const { issue, comments: issueComments } of issuesData) {
    issueRows.push({
      issueId: issue.id,
      number: issue.number,
      title: issue.title,
      bodyText: issue.bodyText,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      closedAt: issue.closedAt,
      state: issue.state,
      authorLogin: issue.author?.login ?? null,
    });

    if (issue.author?.login) {
      users.push(issue.author);
      authorLinks.push({ issueId: issue.id, login: issue.author.login });
    }

    for (const a of issue.assignees?.nodes ?? []) {
      if (!a?.login) continue;
      users.push(a);
      assigneeLinks.push({ issueId: issue.id, login: a.login });
    }

    for (const l of issue.labels?.nodes ?? []) {
      labels.push(l);
      labelLinks.push({ issueId: issue.id, name: l.name });
    }

    const issueReactions = issue.reactions?.nodes ?? [];
    if (issueReactions.length > 0) {
      issueReactionIssueIds.push(issue.id);
      for (const r of issueReactions) {
        if (!r.user?.login) continue;
        reactions.push({
          issueId: issue.id,
          content: r.content,
          userLogin: r.user.login,
          commentId: null,
        });
      }
    }

    for (const c of issueComments) {
      comments.push({
        id: c.id,
        issueId: issue.id,
        bodyText: c.bodyText,
        createdAt: c.createdAt,
        authorLogin: c.author?.login ?? null,
      });
      if (c.author?.login) {
        users.push(c.author);
        commentAuthorLinks.push({ id: c.id, login: c.author.login });
      }
      const rxns = c.reactions?.nodes ?? [];
      if (rxns.length > 0) {
        commentReactionIds.push(c.id);
        for (const r of rxns) {
          if (!r.user?.login) continue;
          reactions.push({
            issueId: issue.id,
            content: r.content,
            userLogin: r.user.login,
            commentId: c.id,
          });
        }
      }
    }
  }

  const issueIds = issueRows.map((r) => r.issueId as string);
  const statements: BatchStatement[] = [
    {
      query: `UNWIND $issues AS iss
     MERGE (i:Issue {issueId: iss.issueId})
     SET i.number    = toInteger(iss.number),
         i.title     = iss.title,
         i.bodyText  = iss.bodyText,
         i.createdAt = iss.createdAt,
         i.updatedAt = iss.updatedAt,
         i.closedAt  = iss.closedAt,
         i.state     = iss.state,
         i.authorLogin = iss.authorLogin`,
      params: { issues: issueRows },
    },
  ];

  if (users.length > 0) {
    statements.push({
      query: `UNWIND $users AS user
     MERGE (u:User {login: user.login})
     SET u.name = user.name, u.company = user.company`,
      params: { users },
    });
  }

  if (authorLinks.length > 0) {
    statements.push({
      query: `UNWIND $links AS link
     MATCH (i:Issue {issueId: link.issueId}), (u:User {login: link.login})
     MERGE (i)-[:AUTHORED_BY]->(u)`,
      params: { links: authorLinks },
    });
  }

  statements.push({
    query: `UNWIND $issueIds AS issueId
     MATCH (i:Issue {issueId: issueId})-[r:ASSIGNED_TO]->() DELETE r`,
    params: { issueIds },
  });

  if (assigneeLinks.length > 0) {
    statements.push({
      query: `UNWIND $links AS link
     MATCH (i:Issue {issueId: link.issueId})
     MATCH (u:User {login: link.login})
     MERGE (i)-[:ASSIGNED_TO]->(u)`,
      params: { links: assigneeLinks },
    });
  }

  if (labels.length > 0) {
    statements.push({
      query: `UNWIND $labels AS label
     MERGE (l:Label {name: label.name})
     SET l.description = label.description, l.color = label.color`,
      params: { labels },
    });
  }

  if (labelLinks.length > 0) {
    statements.push({
      query: `UNWIND $links AS link
     MATCH (i:Issue {issueId: link.issueId})
     MATCH (l:Label {name: link.name})
     MERGE (i)-[:HAS_LABEL]->(l)`,
      params: { links: labelLinks },
    });
  }

  if (reactions.length > 0) {
    statements.push({
      query: `UNWIND $reactions AS reaction
     MERGE (r:Reaction {content: reaction.content, issueId: reaction.issueId, userLogin: reaction.userLogin})
     ON CREATE SET r.commentId = reaction.commentId`,
      params: { reactions },
    });
  }

  if (issueReactionIssueIds.length > 0) {
    statements.push({
      query: `UNWIND $issueIds AS issueId
     MATCH (i:Issue {issueId: issueId})
     MATCH (r:Reaction {issueId: issueId})
     WHERE r.commentId IS NULL
     MERGE (i)-[:HAS_REACTION]->(r)`,
      params: { issueIds: issueReactionIssueIds },
    });
  }

  if (comments.length > 0) {
    statements.push({
      query: `UNWIND $comments AS c
     MERGE (comment:Comment {commentId: c.id})
     SET comment.bodyText  = c.bodyText,
         comment.createdAt = c.createdAt,
         comment.authorLogin = c.authorLogin
     WITH comment, c
     MATCH (i:Issue {issueId: c.issueId})
     MERGE (i)-[:HAS_COMMENT]->(comment)`,
      params: { comments },
    });
  }

  if (commentAuthorLinks.length > 0) {
    statements.push({
      query: `UNWIND $items AS item
     MATCH (c:Comment {commentId: item.id}), (u:User {login: item.login})
     MERGE (c)-[:AUTHORED_BY]->(u)`,
      params: { items: commentAuthorLinks },
    });
  }

  if (commentReactionIds.length > 0) {
    statements.push({
      query: `UNWIND $commentIds AS cid
     MATCH (c:Comment {commentId: cid})
     MATCH (r:Reaction {commentId: cid})
     MERGE (c)-[:HAS_REACTION]->(r)`,
      params: { commentIds: commentReactionIds },
    });
  }

  return statements;
}

/**
 * Writes one batch in a single managed transaction.
 *
 * Throws on failure so the caller can fall back; it deliberately does not
 * swallow errors, because a silently partial batch is worse than a slow one.
 */
async function writeIssueBatch(session: Session, issuesData: IssueData[]): Promise<void> {
  const statements = planIssueBatch(issuesData);
  await session.executeWrite(async (tx) => {
    for (const { query, params } of statements) {
      await tx.run(query, params);
    }
  });
}

export async function ingestMultipleIssues(issuesData: IssueData[]): Promise<{
  results: IngestionResult[];
  errors: { issueNumber: number; error: string }[];
}> {
  const results: IngestionResult[] = [];
  const errors: { issueNumber: number; error: string }[] = [];

  console.log(`\n=== Ingesting ${issuesData.length} issues into Neo4j ===`);

  const batchSize = ingestBatchSize();
  const session = getDriver().session();
  try {
    for (let start = 0; start < issuesData.length; start += batchSize) {
      const batch = issuesData.slice(start, start + batchSize);
      console.log(
        `  Batch ${start / batchSize + 1}: issues ${start + 1}-${start + batch.length} in one transaction`,
      );
      try {
        await writeIssueBatch(session, batch);
        for (const { issue, comments } of batch) results.push(summariseIngestion(issue, comments));
      } catch (err: unknown) {
        // Deliberately not all-or-nothing. A single malformed issue would
        // otherwise take the whole sync down; instead the batch is retried
        // issue by issue so the rest of it still lands and the failure is
        // attributed to the issue that caused it.
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`  Batch failed (${msg}); retrying ${batch.length} issues individually`);
        for (const { issue, comments } of batch) {
          try {
            const r = await ingestIssueData(issue, comments);
            results.push(r);
          } catch (inner: unknown) {
            const innerMsg = inner instanceof Error ? inner.message : String(inner);
            console.error(`  Failed issue #${issue.number}: ${innerMsg}`);
            errors.push({ issueNumber: issue.number, error: innerMsg });
          }
        }
      }
    }
  } finally {
    await session.close();
  }

  console.log(`\nIngestion complete: ${results.length} ok, ${errors.length} failed`);
  return { results, errors };
}
