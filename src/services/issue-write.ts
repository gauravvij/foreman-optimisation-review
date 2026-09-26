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

export interface IssueSnapshot {
  id: string;
  number: number;
  title: string;
  state: string;
  viewerCanUpdate: boolean;
}

export interface WriteResult {
  number: number;
  title: string;
  previousTitle: string;
  titleChanged: boolean;
  previousState: string;
  newState: string;
  commented: boolean;
  graphUpdated: boolean;
}

/** Reads the issue and whether this token may change it, before anything is written. */
export async function getIssueSnapshot(
  owner: string,
  repo: string,
  number: number,
): Promise<IssueSnapshot | null> {
  const data = await githubGraphQL<{ repository: { issue: IssueSnapshot | null } }>(
    `query($owner:String!,$repo:String!,$number:Int!){
       repository(owner:$owner,name:$repo){
         issue(number:$number){ id number title state viewerCanUpdate }
       }
     }`,
    { owner, repo, number },
  );
  return data.repository.issue;
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
}): Promise<WriteResult> {
  const { owner, repo, number, action, reason = 'completed', comment, title } = opts;

  const snapshot = await getIssueSnapshot(owner, repo, number);
  if (!snapshot) throw new Error(`issue #${number} not found in ${owner}/${repo}`);
  if (!snapshot.viewerCanUpdate) {
    throw new Error(
      `the configured token cannot modify issue #${number}; it needs issues:write on ${owner}/${repo}`,
    );
  }

  const wantedTitle = title?.trim();
  const titleChanged = !!wantedTitle && wantedTitle !== snapshot.title;

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
    graphUpdated: await syncGraph(number, newState, titleChanged ? wantedTitle : undefined),
  };
}

/** Keeps the graph consistent immediately, so a reconcile is not needed afterwards. */
async function syncGraph(number: number, state: string, title?: string): Promise<boolean> {
  const session = getDriver().session();
  try {
    const res = await session.run(
      `MATCH (i:Issue {number: $n})
       SET i.state = $state,
           i.closedAt = CASE WHEN $state = 'CLOSED' THEN coalesce(i.closedAt, $now) ELSE null END,
           i.title = coalesce($title, i.title)
       RETURN i.number AS n`,
      { n: number, state, title: title ?? null, now: new Date().toISOString() },
    );
    return res.records.length > 0;
  } finally {
    await session.close();
  }
}
