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

export async function ingestMultipleIssues(issuesData: IssueData[]): Promise<{
  results: IngestionResult[];
  errors: { issueNumber: number; error: string }[];
}> {
  const results: IngestionResult[] = [];
  const errors: { issueNumber: number; error: string }[] = [];

  console.log(`\n=== Ingesting ${issuesData.length} issues into Neo4j ===`);

  for (let i = 0; i < issuesData.length; i++) {
    const { issue, comments } = issuesData[i];
    try {
      console.log(`[${i + 1}/${issuesData.length}] Issue #${issue.number}...`);
      const result = await ingestIssueData(issue, comments);
      results.push(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  Failed issue #${issue.number}: ${msg}`);
      errors.push({ issueNumber: issue.number, error: msg });
    }
  }

  console.log(`\nIngestion complete: ${results.length} ok, ${errors.length} failed`);
  return { results, errors };
}
