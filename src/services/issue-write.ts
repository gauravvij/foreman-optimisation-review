/**
 * Writes issue state back to GitHub.
 *
 * This is the only path in the project that mutates the source repository's
 * issues, so it is deliberately narrow: one issue per call, an explicit action,
 * and a permission check before anything is attempted. The confirmation gate
 * lives in the tool layer, because the agent reads issue text it does not
 * control and must not be able to close issues on the strength of that text.
 */

import { trace } from '@opentelemetry/api';
import neo4j from 'neo4j-driver';
import { githubGraphQL } from './http';
import { getDriver } from './neo4j';

/** A span that is not recording reports this as its trace id. */
const ABSENT_TRACE_ID = '0'.repeat(32);

const LOCAL_NOTE =
  'Written by Foreman (AI). Manual local run, no trace id. ' + 'Verify before acting.';

function activeTraceId(): string | null {
  const id = trace.getActiveSpan()?.spanContext().traceId;
  return id && id !== ABSENT_TRACE_ID ? id : null;
}

/**
 * The footer every comment this agent posts carries. The HTML comment is what
 * a later run greps for to find and edit its own comment instead of adding a
 * second one.
 */
export function commentAttribution(): string {
  const traceId = activeTraceId();
  const deployment = process.env.ASTRO_DEPLOYMENT_ID;
  const version = process.env.ASTRO_AGENT_VERSION || process.env.ASTRO_AGENT_BUILD;

  const marker = [
    'astro-agent: foreman',
    deployment ? `deployment=${deployment}` : 'deployment=local',
    traceId ? `trace=${traceId}` : 'trace=none',
    version ? `version=${version}` : null,
  ]
    .filter(Boolean)
    .join(' ');

  if (!traceId && !deployment) {
    return `<!-- ${marker} -->\n<sub>${LOCAL_NOTE}</sub>`;
  }

  const where = [
    deployment ? `deployment \`${deployment}\`` : null,
    version ? `version \`${version}\`` : null,
    traceId ? `trace \`${traceId}\`` : 'trace id missing',
  ]
    .filter(Boolean)
    .join(', ');

  return `<!-- ${marker} -->\n<sub>Written by Foreman (AI): ${where}. Verify before acting.</sub>`;
}

export type IssueAction = 'close' | 'reopen';
export type CloseReason = 'completed' | 'not_planned' | 'duplicate';

export interface AssigneeRef {
  id: string;
  login: string;
}

export interface IssueSnapshot {
  id: string;
  number: number;
  title: string;
  state: string;
  viewerCanUpdate: boolean;
  assignees: AssigneeRef[];
}

export interface WriteResult {
  number: number;
  title: string;
  previousTitle: string;
  titleChanged: boolean;
  previousState: string;
  newState: string;
  commented: boolean;
  assigneesBefore: string[];
  assigneesAfter: string[];
  assigneesChanged: boolean;
  graphUpdated: boolean;
}

/** Reads the issue and whether this token may change it, before anything is written. */
export async function getIssueSnapshot(
  owner: string,
  repo: string,
  number: number,
): Promise<IssueSnapshot | null> {
  const data = await githubGraphQL<{
    repository: {
      issue: (Omit<IssueSnapshot, 'assignees'> & { assignees: { nodes: AssigneeRef[] } }) | null;
    };
  }>(
    `query($owner:String!,$repo:String!,$number:Int!){
       repository(owner:$owner,name:$repo){
         issue(number:$number){
           id number title state viewerCanUpdate
           assignees(first:20){ nodes { id login } }
         }
       }
     }`,
    { owner, repo, number },
  );
  const issue = data.repository.issue;
  if (!issue) return null;
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    state: issue.state,
    viewerCanUpdate: issue.viewerCanUpdate,
    assignees: issue.assignees?.nodes ?? [],
  };
}

/**
 * Resolves a GitHub login to its node id. The id is what every assignee mutation
 * takes. Throws when the login does not exist or belongs to an org, so a typo
 * fails loudly instead of silently assigning nobody.
 */
async function resolveLoginId(login: string): Promise<string> {
  const data = await githubGraphQL<{ user: { id: string; login: string } | null }>(
    'query($login:String!){ user(login:$login){ id login } }',
    { login },
    `resolve GitHub user ${login}`,
  );
  if (!data.user) throw new Error(`GitHub user @${login} does not exist`);
  return data.user.id;
}

const CLOSE_REASON: Record<CloseReason, string> = {
  completed: 'COMPLETED',
  not_planned: 'NOT_PLANNED',
  duplicate: 'DUPLICATE',
};

/**
 * Applies the state change, optionally leaving a comment first so the reason is
 * visible on the issue rather than only in the close event.
 */
export async function applyIssueUpdate(opts: {
  owner: string;
  repo: string;
  number: number;
  /** Omit to leave the state alone and only retitle or comment. */
  action?: IssueAction;
  reason?: CloseReason;
  comment?: string;
  /** New title. Omit to leave it unchanged. */
  title?: string;
  /** GitHub logins to assign; already-assigned logins are a no-op. */
  addAssignees?: string[];
  /** GitHub logins to remove; a login not currently assigned is a no-op. */
  removeAssignees?: string[];
}): Promise<WriteResult> {
  const {
    owner,
    repo,
    number,
    action,
    reason = 'completed',
    comment,
    title,
    addAssignees,
    removeAssignees,
  } = opts;

  const snapshot = await getIssueSnapshot(owner, repo, number);
  if (!snapshot) throw new Error(`issue #${number} not found in ${owner}/${repo}`);
  if (!snapshot.viewerCanUpdate) {
    throw new Error(
      `the configured token cannot modify issue #${number}; it needs issues:write on ${owner}/${repo}`,
    );
  }

  const wantedTitle = title?.trim();
  const titleChanged = !!wantedTitle && wantedTitle !== snapshot.title;

  const assigneesBefore = snapshot.assignees.map((a) => a.login);
  const currentById = new Map(snapshot.assignees.map((a) => [a.login, a.id]));

  const toAddLogins = (addAssignees ?? []).filter((l) => !currentById.has(l));
  const toRemoveLogins = (removeAssignees ?? []).filter((l) => currentById.has(l));

  // Resolve new logins to node ids before any write, so a typo throws before
  // mutating anything else on the issue.
  const addIdByLogin = new Map<string, string>();
  for (const login of toAddLogins) {
    addIdByLogin.set(login, await resolveLoginId(login));
  }

  // Comment first, so the reason is visible above the change it explains.
  let commented = false;
  if (comment) {
    await githubGraphQL(
      'mutation($id:ID!,$body:String!){ addComment(input:{subjectId:$id, body:$body}){ clientMutationId } }',
      { id: snapshot.id, body: `${comment.trimEnd()}\n\n---\n${commentAttribution()}` },
    );
    commented = true;
  }

  if (titleChanged) {
    await githubGraphQL(
      'mutation($id:ID!,$title:String!){ updateIssue(input:{id:$id, title:$title}){ issue{ title } } }',
      { id: snapshot.id, title: wantedTitle },
    );
  }

  if (toAddLogins.length > 0) {
    await githubGraphQL(
      'mutation($id:ID!,$ids:[ID!]!){ addAssigneesToAssignable(input:{assignableId:$id, assigneeIds:$ids}){ clientMutationId } }',
      { id: snapshot.id, ids: toAddLogins.map((l) => addIdByLogin.get(l) as string) },
    );
  }
  if (toRemoveLogins.length > 0) {
    await githubGraphQL(
      'mutation($id:ID!,$ids:[ID!]!){ removeAssigneesFromAssignable(input:{assignableId:$id, assigneeIds:$ids}){ clientMutationId } }',
      { id: snapshot.id, ids: toRemoveLogins.map((l) => currentById.get(l) as string) },
    );
  }

  const assigneesAfter = [
    ...assigneesBefore.filter((l) => !toRemoveLogins.includes(l)),
    ...toAddLogins,
  ];
  const assigneesChanged = toAddLogins.length > 0 || toRemoveLogins.length > 0;

  // An omitted action means retitle or comment only; leave the state alone.
  let newState = snapshot.state;
  if (action) {
    const wanted = action === 'close' ? 'CLOSED' : 'OPEN';
    if (snapshot.state !== wanted) {
      newState =
        action === 'close'
          ? (
              await githubGraphQL<{ closeIssue: { issue: { state: string } } }>(
                `mutation($id:ID!,$reason:IssueClosedStateReason!){
                   closeIssue(input:{issueId:$id, stateReason:$reason}){ issue{ state } } }`,
                { id: snapshot.id, reason: CLOSE_REASON[reason] },
              )
            ).closeIssue.issue.state
          : (
              await githubGraphQL<{ reopenIssue: { issue: { state: string } } }>(
                'mutation($id:ID!){ reopenIssue(input:{issueId:$id}){ issue{ state } } }',
                { id: snapshot.id },
              )
            ).reopenIssue.issue.state;
    }
  }

  return {
    number,
    title: titleChanged ? (wantedTitle as string) : snapshot.title,
    previousTitle: snapshot.title,
    titleChanged,
    previousState: snapshot.state,
    newState,
    commented,
    assigneesBefore,
    assigneesAfter,
    assigneesChanged,
    graphUpdated: await syncGraph(number, newState, {
      title: titleChanged ? wantedTitle : undefined,
      assignees: assigneesChanged ? assigneesAfter : undefined,
    }),
  };
}

/** Keeps the graph consistent immediately, so a reconcile is not needed afterwards. */
async function syncGraph(
  number: number,
  state: string,
  opts: { title?: string; assignees?: string[] } = {},
): Promise<boolean> {
  const session = getDriver().session();
  try {
    const res = await session.run(
      `MATCH (i:Issue {number: $n})
       SET i.state = $state,
           i.closedAt = CASE WHEN $state = 'CLOSED' THEN coalesce(i.closedAt, $now) ELSE null END,
           i.title = coalesce($title, i.title)
       RETURN i.number AS n`,
      { n: number, state, title: opts.title ?? null, now: new Date().toISOString() },
    );
    if (res.records.length === 0) return false;

    if (opts.assignees) {
      await session.run('MATCH (i:Issue {number: $n})-[r:ASSIGNED_TO]->() DELETE r', {
        n: number,
      });
      if (opts.assignees.length > 0) {
        await session.run(
          `MATCH (i:Issue {number: $n})
           UNWIND $logins AS login
           MERGE (u:User {login: login})
           MERGE (i)-[:ASSIGNED_TO]->(u)`,
          { n: number, logins: opts.assignees },
        );
      }
    }
    return true;
  } finally {
    await session.close();
  }
}

export interface CreateIssueOptions {
  owner: string;
  repo: string;
  title: string;
  /** Markdown body; the attribution footer is appended before the write. */
  body?: string;
  /** Existing issue numbers this new issue is drawn from, linked in the body. */
  derivedFrom?: number[];
  /** Label names that already exist on the repository. Missing ones fail. */
  labels?: string[];
}

export interface CreateIssueResult {
  number: number;
  url: string;
  title: string;
}

interface RepoIdResult {
  repository: { id: string; viewerPermission: string | null } | null;
}

/**
 * Opens a new issue on the repository.
 *
 * The body carries the same attribution footer every other agent write does,
 * so a person searching the repo for agent-written content finds this issue
 * the same way. Numbers listed in derivedFrom are rendered as a "Draws on"
 * block so the trail back to the observed evidence is visible on the issue.
 */
export async function createIssue(opts: CreateIssueOptions): Promise<CreateIssueResult> {
  const { owner, repo, title, body, derivedFrom, labels } = opts;

  const trimmed = title.trim();
  if (!trimmed) throw new Error('createIssue: title is empty');

  const repoData = await githubGraphQL<RepoIdResult>(
    `query($owner:String!,$repo:String!){
       repository(owner:$owner,name:$repo){ id viewerPermission }
     }`,
    { owner, repo },
  );
  const repository = repoData.repository;
  if (!repository) throw new Error(`repository ${owner}/${repo} not found`);
  const permission = repository.viewerPermission;
  if (
    permission !== 'ADMIN' &&
    permission !== 'MAINTAIN' &&
    permission !== 'WRITE' &&
    permission !== 'TRIAGE'
  ) {
    throw new Error(
      `the configured token cannot open issues on ${owner}/${repo}; it needs at least TRIAGE, got ${permission ?? 'no'} permission`,
    );
  }

  let labelIds: string[] | undefined;
  if (labels && labels.length > 0) {
    const data = await githubGraphQL<{
      repository: { labels: { nodes: { id: string; name: string }[] } } | null;
    }>(
      `query($owner:String!,$repo:String!,$q:String!){
         repository(owner:$owner,name:$repo){
           labels(first:100, query:$q){ nodes { id name } }
         }
       }`,
      { owner, repo, q: labels.join(' ') },
    );
    const found = new Map((data.repository?.labels.nodes ?? []).map((n) => [n.name, n.id]));
    const missing = labels.filter((name) => !found.has(name));
    if (missing.length > 0) throw new Error(`labels do not exist: ${missing.join(', ')}`);
    labelIds = labels.map((name) => {
      const id = found.get(name);
      if (!id) throw new Error(`label ${name} disappeared between lookup and use`);
      return id;
    });
  }

  const parts: string[] = [];
  if (body?.trim()) parts.push(body.trim());
  if (derivedFrom && derivedFrom.length > 0) {
    const linked = derivedFrom.map((n) => `#${n}`).join(', ');
    parts.push(`### Draws on\n\n${linked}`);
  }
  parts.push(`---\n${commentAttribution()}`);
  const finalBody = parts.join('\n\n');

  const created = await githubGraphQL<{
    createIssue: { issue: { number: number; url: string; title: string } };
  }>(
    `mutation($repo:ID!,$title:String!,$body:String,$labels:[ID!]){
       createIssue(input:{repositoryId:$repo, title:$title, body:$body, labelIds:$labels}){
         issue{ number url title }
       }
     }`,
    { repo: repository.id, title: trimmed, body: finalBody, labels: labelIds ?? null },
  );

  return created.createIssue.issue;
}

/** Cheap duplicate suggestions before opening a new issue. */
export interface DuplicateCandidate {
  number: number;
  title: string;
  state: string;
  tokenMatches: number;
}

/**
 * Looks for existing issues whose titles share tokens with the proposed title.
 * Read-only, and cheap enough to run inline before the create prompt.
 */
export async function findLikelyDuplicates(
  title: string,
  limit = 5,
): Promise<DuplicateCandidate[]> {
  const tokens = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 4);

  if (tokens.length === 0) return [];

  const driver = getDriver();
  const session = driver.session();
  try {
    const res = await session.run(
      `MATCH (i:Issue)
       WITH i, [t IN $tokens WHERE toLower(i.title) CONTAINS t] AS hits
       WHERE size(hits) > 0
       RETURN i.number AS number, i.title AS title, i.state AS state, size(hits) AS tokenMatches
       ORDER BY tokenMatches DESC, i.number DESC
       LIMIT $limit`,
      { tokens, limit: neo4j.int(limit) },
    );
    return res.records.map((r) => ({
      number: neo4j.int(r.get('number')).toNumber(),
      title: r.get('title') as string,
      state: r.get('state') as string,
      tokenMatches: neo4j.int(r.get('tokenMatches')).toNumber(),
    }));
  } finally {
    await session.close();
  }
}
