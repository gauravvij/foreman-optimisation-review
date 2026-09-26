/**
 * Reads the pull requests linked to issues.
 *
 * Two kinds of link exist and they mean different things. A closing reference
 * is the author declaring "this resolves that issue"; a cross reference is only
 * a mention, which a PR picks up by quoting an issue number in passing. Both
 * are reported, tagged, so a caller can decide how much weight to give each.
 */

import { githubGraphQL } from './http';
import { commentAttribution } from './issue-write';

export interface LinkedPullRequest {
  number: number;
  title: string;
  url: string;
  /** OPEN, CLOSED, or MERGED. */
  state: string;
  isDraft: boolean;
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or null when none applies. */
  reviewDecision: string | null;
  author: string | null;
  updatedAt: string;
  /** The PR declares it closes this issue, rather than only mentioning it. */
  closes: boolean;
}

const ISSUE_CHUNK = 20;

interface PullRequestNode {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  reviewDecision: string | null;
  author: { login: string } | null;
  updatedAt: string;
  closingIssuesReferences?: { nodes: { number: number }[] };
}

function toLinked(pr: PullRequestNode, issueNumber: number): LinkedPullRequest {
  const closes = (pr.closingIssuesReferences?.nodes ?? []).some((n) => n.number === issueNumber);
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.state,
    isDraft: pr.isDraft,
    reviewDecision: pr.reviewDecision,
    author: pr.author?.login ?? null,
    updatedAt: pr.updatedAt,
    closes,
  };
}

const PR_FIELDS = `number title url state isDraft reviewDecision updatedAt
        author { login }
        closingIssuesReferences(first:10) { nodes { number } }`;

/** Pull requests referenced from each issue's timeline, newest link last. */
export async function fetchLinkedPullRequests(
  owner: string,
  repo: string,
  issueNumbers: number[],
): Promise<Map<number, LinkedPullRequest[]>> {
  const linked = new Map<number, LinkedPullRequest[]>();

  for (let i = 0; i < issueNumbers.length; i += ISSUE_CHUNK) {
    const chunk = issueNumbers.slice(i, i + ISSUE_CHUNK);
    const aliases = chunk
      .map(
        (n) => `i${n}: issue(number:${n}) {
        number
        timelineItems(first:30, itemTypes:[CROSS_REFERENCED_EVENT, CONNECTED_EVENT]) {
          nodes {
            ... on CrossReferencedEvent { source { ... on PullRequest { ${PR_FIELDS} } } }
            ... on ConnectedEvent { subject { ... on PullRequest { ${PR_FIELDS} } } }
          }
        }
      }`,
      )
      .join('\n    ');

    const data = await githubGraphQL<{
      repository: Record<
        string,
        {
          number: number;
          timelineItems: {
            nodes: ({ source?: PullRequestNode; subject?: PullRequestNode } | null)[];
          };
        } | null
      > | null;
    }>(
      `query($owner:String!, $repo:String!) {
         repository(owner:$owner, name:$repo) {
    ${aliases}
         }
       }`,
      { owner, repo },
      'GitHub linked pull requests',
    );

    for (const value of Object.values(data.repository ?? {})) {
      if (!value?.number) continue;
      const seen = new Map<number, LinkedPullRequest>();
      for (const node of value.timelineItems.nodes) {
        const pr = node?.source ?? node?.subject;
        if (!pr?.number) continue;
        const current = toLinked(pr, value.number);
        // The same PR can appear twice; a closing link outranks a bare mention.
        const existing = seen.get(pr.number);
        if (!existing || (current.closes && !existing.closes)) seen.set(pr.number, current);
      }
      linked.set(
        value.number,
        [...seen.values()].sort((a, b) => a.number - b.number),
      );
    }
  }

  return linked;
}

/** The link state that decides which column an issue belongs in. */
export interface PullRequestSignal {
  /** A pull request that is open and marked ready for review. */
  hasOpenReadyPR: boolean;
  /** A pull request that is open but still a draft. */
  hasDraftPR: boolean;
  /** A pull request that has been merged. */
  hasMergedPR: boolean;
  linkedCount: number;
}

/**
 * The work landed but nobody closed the issue, so it may be finished.
 *
 * A still-open pull request rules this out: a merged first PR with follow-up
 * work in flight is not a finished issue.
 */
export function isShippedButOpen(
  s: Pick<PullRequestSignal, 'hasMergedPR' | 'hasOpenReadyPR' | 'hasDraftPR'>,
): boolean {
  return s.hasMergedPR && !s.hasOpenReadyPR && !s.hasDraftPR;
}

export function summariseLinks(prs: LinkedPullRequest[]): PullRequestSignal {
  const open = prs.filter((p) => p.state === 'OPEN');
  return {
    hasOpenReadyPR: open.some((p) => !p.isDraft),
    hasDraftPR: open.some((p) => p.isDraft),
    hasMergedPR: prs.some((p) => p.state === 'MERGED'),
    linkedCount: prs.length,
  };
}

/** One pull request read directly, rather than as a link from an issue. */
export interface PullRequestDetail {
  number: number;
  title: string;
  url: string;
  /** OPEN, CLOSED, or MERGED. */
  state: string;
  isDraft: boolean;
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or null when none applies. */
  reviewDecision: string | null;
  author: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  headRefName: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  labels: string[];
  /** Issues the PR declares it closes, which is the link that carries weight. */
  closesIssues: number[];
  /** SUCCESS, FAILURE, PENDING, or null when the head commit has no checks. */
  checksState: string | null;
}

interface PullRequestDetailNode {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  reviewDecision: string | null;
  author: { login: string } | null;
  body: string | null;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  headRefName: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  labels?: { nodes: { name: string }[] };
  closingIssuesReferences?: { nodes: { number: number }[] };
  commits?: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
}

/**
 * Reads one pull request as it stands now.
 *
 * Every call goes to GitHub rather than the graph, which holds issues only, so
 * this is also how a caller refetches a PR whose state has moved on.
 */
export async function fetchPullRequest(
  owner: string,
  repo: string,
  number: number,
): Promise<PullRequestDetail | null> {
  const data = await githubGraphQL<{
    repository: { pullRequest: PullRequestDetailNode | null } | null;
  }>(
    `query($owner:String!,$repo:String!,$number:Int!){
       repository(owner:$owner,name:$repo){
         pullRequest(number:$number){
           number title url state isDraft reviewDecision body
           createdAt updatedAt mergedAt headRefName baseRefName
           additions deletions changedFiles
           author { login }
           labels(first:20) { nodes { name } }
           closingIssuesReferences(first:20) { nodes { number } }
           commits(last:1) { nodes { commit { statusCheckRollup { state } } } }
         }
       }
     }`,
    { owner, repo, number },
    'GitHub pull request',
  );

  const pr = data.repository?.pullRequest;
  if (!pr) return null;

  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.state,
    isDraft: pr.isDraft,
    reviewDecision: pr.reviewDecision,
    author: pr.author?.login ?? null,
    body: pr.body ?? '',
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    mergedAt: pr.mergedAt,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    labels: (pr.labels?.nodes ?? []).map((l) => l.name),
    closesIssues: (pr.closingIssuesReferences?.nodes ?? []).map((n) => n.number),
    checksState: pr.commits?.nodes?.[0]?.commit.statusCheckRollup?.state ?? null,
  };
}

export interface PullRequestCommentResult {
  number: number;
  url: string;
  title: string;
}

/**
 * Comments on a pull request.
 *
 * applyIssueUpdate cannot reach a PR: it resolves the subject through
 * repository.issue, which is null for a pull request. The comment mutation is
 * the same one either way, because addComment takes any commentable subject, so
 * only the lookup differs. The attribution footer is shared, so a comment here
 * is signed the same as one on an issue.
 */
export async function commentOnPullRequest(
  owner: string,
  repo: string,
  number: number,
  comment: string,
): Promise<PullRequestCommentResult> {
  const data = await githubGraphQL<{
    repository: { pullRequest: { id: string; number: number; url: string; title: string } | null };
  }>(
    `query($owner:String!,$repo:String!,$number:Int!){
       repository(owner:$owner,name:$repo){
         pullRequest(number:$number){ id number url title }
       }
     }`,
    { owner, repo, number },
    'GitHub pull request',
  );

  const pr = data.repository?.pullRequest;
  if (!pr) throw new Error(`pull request #${number} not found in ${owner}/${repo}`);

  await githubGraphQL(
    'mutation($id:ID!,$body:String!){ addComment(input:{subjectId:$id, body:$body}){ clientMutationId } }',
    { id: pr.id, body: `${comment.trimEnd()}\n\n---\n${commentAttribution()}` },
    'GitHub pull request comment',
  );

  return { number: pr.number, url: pr.url, title: pr.title };
}
