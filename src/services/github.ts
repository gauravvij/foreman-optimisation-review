/**
 * GitHub GraphQL API — fetches issue data (issue + comments + reactions + labels).
 */

import { githubGraphQL } from './http';
import type { GitHubComment, GitHubIssue, GitHubPullRequest, IssueData } from './neo4j';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// GraphQL queries
// ---------------------------------------------------------------------------

const ISSUE_NUMBERS_QUERY = `
query ($owner: String!, $repo: String!, $after: String, $states: [IssueState!], $since: DateTime) {
  repository(owner: $owner, name: $repo) {
    issues(first: 100, after: $after, states: $states, filterBy: {since: $since}) {
      nodes { number title createdAt updatedAt state }
      pageInfo { hasNextPage endCursor }
      totalCount
    }
  }
}`;

const COMPLETE_ISSUE_DATA_QUERY = `
query ($owner: String!, $repo: String!, $issueNumber: Int!, $commentsAfter: String, $reactionsAfter: String) {
  repository(owner: $owner, name: $repo) {
    issue(number: $issueNumber) {
      id number title bodyText createdAt updatedAt closedAt state
      author {
        login
        ... on User { name company }
      }
      assignees(first: 10) {
        nodes {
          login
          ... on User { name company }
        }
      }
      labels(first: 50) {
        nodes { name description color }
      }
      reactions(first: 100, after: $reactionsAfter) {
        nodes { content user { login } }
        pageInfo { hasNextPage endCursor }
        totalCount
      }
      comments(first: 100, after: $commentsAfter) {
        nodes {
          id bodyText createdAt
          author {
            login
            ... on User { name company }
          }
          reactions(first: 100) {
            nodes { content user { login } }
            totalCount
          }
        }
        pageInfo { hasNextPage endCursor }
        totalCount
      }
    }
  }
}`;

// ---------------------------------------------------------------------------
// GraphQL helper
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fetch single issue with pagination
// ---------------------------------------------------------------------------

async function fetchCompleteIssue(
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<IssueData> {
  let allComments: GitHubComment[] = [];
  let hasNextPage = true;
  let commentsAfter: string | null = null;
  let issueData: GitHubIssue | null = null;

  console.log(`  Fetching issue #${issueNumber} from ${owner}/${repo}...`);

  // Paginate through comments
  while (hasNextPage) {
    const data = await githubGraphQL<{ repository: { issue: Record<string, unknown> } }>(
      COMPLETE_ISSUE_DATA_QUERY,
      {
        owner,
        repo,
        issueNumber,
        commentsAfter,
      },
    );

    const issue = data.repository?.issue;
    if (!issue) throw new Error(`Issue #${issueNumber} not found`);

    if (!issueData) {
      const comments = issue.comments as {
        nodes: GitHubComment[];
        pageInfo: { hasNextPage: boolean; endCursor: string };
        totalCount: number;
      };
      issueData = {
        id: issue.id as string,
        number: issue.number as number,
        title: issue.title as string,
        bodyText: issue.bodyText as string,
        createdAt: issue.createdAt as string,
        updatedAt: issue.updatedAt as string,
        closedAt: issue.closedAt as string | null,
        state: issue.state as string,
        author: issue.author as GitHubIssue['author'],
        assignees: issue.assignees as GitHubIssue['assignees'],
        labels: issue.labels as GitHubIssue['labels'],
        reactions: issue.reactions as GitHubIssue['reactions'],
        totalComments: comments.totalCount,
      };
    }

    const commentsPage = issue.comments as {
      nodes: GitHubComment[];
      pageInfo: { hasNextPage: boolean; endCursor: string };
    };
    allComments = allComments.concat(commentsPage.nodes);
    hasNextPage = commentsPage.pageInfo.hasNextPage;
    commentsAfter = commentsPage.pageInfo.endCursor;
  }

  // Paginate through issue reactions
  let allReactions: { content: string; user: { login: string } | null }[] = [];
  let reactionsHasNextPage = true;
  let reactionsAfter: string | null = null;

  while (reactionsHasNextPage) {
    const data = await githubGraphQL<{ repository: { issue: Record<string, unknown> } }>(
      COMPLETE_ISSUE_DATA_QUERY,
      {
        owner,
        repo,
        issueNumber,
        commentsAfter: null,
        reactionsAfter,
      },
    );

    const reactions = data.repository.issue.reactions as {
      nodes: { content: string; user: { login: string } | null }[];
      pageInfo: { hasNextPage: boolean; endCursor: string };
    };
    allReactions = allReactions.concat(reactions.nodes);
    reactionsHasNextPage = reactions.pageInfo.hasNextPage;
    reactionsAfter = reactions.pageInfo.endCursor;
  }

  if (issueData) {
    issueData.reactions = { nodes: allReactions, totalCount: allReactions.length };
  }

  return { issue: issueData!, comments: allComments };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type IssueState = 'open' | 'closed' | 'all';

const STATE_MAP: Record<IssueState, string[]> = {
  open: ['OPEN'],
  closed: ['CLOSED'],
  all: ['OPEN', 'CLOSED'],
};

export interface IssueListing {
  number: number;
  title: string;
  createdAt: string;
  updatedAt: string;
  state: string;
}

export async function getAllIssueNumbers(
  owner: string,
  repo: string,
  state: IssueState = 'open',
  limit = 0,
  since?: string | null,
): Promise<{ issueNumbers: number[]; issues: IssueListing[]; total: number }> {
  const states = STATE_MAP[state];
  if (!states) throw new Error(`Invalid state: ${state}`);

  let allIssues: IssueListing[] = [];
  let hasNextPage = true;
  let after: string | null = null;

  const sinceLabel = since ? ` (since: ${since})` : '';
  console.log(
    `Fetching ${state} issues from ${owner}/${repo}${limit > 0 ? ` (limit: ${limit})` : ''}${sinceLabel}...`,
  );

  type IssueNumbersResponse = {
    repository: {
      issues: {
        nodes: IssueListing[];
        pageInfo: { hasNextPage: boolean; endCursor: string };
        totalCount: number;
      };
    };
  };

  while (hasNextPage) {
    const data: IssueNumbersResponse = await githubGraphQL<IssueNumbersResponse>(
      ISSUE_NUMBERS_QUERY,
      {
        owner,
        repo,
        after,
        states,
        since: since ?? null,
      },
    );

    const page = data.repository.issues;
    allIssues = allIssues.concat(page.nodes);
    hasNextPage = page.pageInfo.hasNextPage;
    after = page.pageInfo.endCursor;
    console.log(`  Found ${allIssues.length} issues so far...`);

    // Stop early if we have enough
    if (limit > 0 && allIssues.length >= limit) {
      allIssues = allIssues.slice(0, limit);
      break;
    }
  }

  console.log(`Found ${allIssues.length} total ${state} issues`);
  return {
    issueNumbers: allIssues.map((i) => i.number),
    issues: allIssues,
    total: allIssues.length,
  };
}

export async function getIssuesData(
  owner: string,
  repo: string,
  issueNumbers: number[],
): Promise<{ results: IssueData[]; errors: { issueNumber: number; error: string }[] }> {
  const results: IssueData[] = [];
  const errors: { issueNumber: number; error: string }[] = [];

  console.log(`Fetching ${issueNumbers.length} issues from ${owner}/${repo}...`);

  for (let i = 0; i < issueNumbers.length; i++) {
    const num = issueNumbers[i];
    try {
      console.log(`[${i + 1}/${issueNumbers.length}] Issue #${num}...`);
      const data = await fetchCompleteIssue(owner, repo, num);
      results.push(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  Failed #${num}: ${msg}`);
      errors.push({ issueNumber: num, error: msg });
    }
  }

  console.log(`Fetch complete: ${results.length} ok, ${errors.length} failed`);
  return { results, errors };
}

// ---------------------------------------------------------------------------
// Pull request fetch
// ---------------------------------------------------------------------------

const PULL_REQUESTS_QUERY = `
query ($owner: String!, $repo: String!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequests(first: 50, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        id number title url state isDraft createdAt updatedAt closedAt mergedAt
        additions deletions changedFiles
        author { login ... on User { name company } }
        assignees(first: 10) { nodes { login ... on User { name company } } }
        labels(first: 20) { nodes { name description color } }
        closingIssuesReferences(first: 10) { nodes { number } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

/**
 * Fetches pull requests ordered by most recent activity. Stops paging as soon
 * as a page is entirely older than `since`, so an incremental sync does not
 * walk back further than it has to.
 */
export async function getPullRequests(
  owner: string,
  repo: string,
  since?: string | null,
  limit = 0,
): Promise<GitHubPullRequest[]> {
  const sinceLabel = since ? ` (since: ${since})` : '';
  console.log(`Fetching pull requests from ${owner}/${repo}${sinceLabel}...`);

  type PullRequestsResponse = {
    repository: {
      pullRequests: {
        nodes: GitHubPullRequest[];
        pageInfo: { hasNextPage: boolean; endCursor: string };
      };
    };
  };

  const sinceMs = since ? new Date(since).getTime() : null;
  const all: GitHubPullRequest[] = [];
  let after: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data: PullRequestsResponse = await githubGraphQL<PullRequestsResponse>(
      PULL_REQUESTS_QUERY,
      { owner, repo, after },
    );
    const page: PullRequestsResponse['repository']['pullRequests'] = data.repository.pullRequests;

    let keptFromPage = 0;
    for (const pr of page.nodes) {
      if (sinceMs !== null && new Date(pr.updatedAt).getTime() < sinceMs) continue;
      all.push(pr);
      keptFromPage++;
      if (limit > 0 && all.length >= limit) break;
    }

    if (limit > 0 && all.length >= limit) break;
    // When filtering by `since`, if nothing in this page passes the filter the
    // next page is strictly older, so stop walking back.
    if (sinceMs !== null && keptFromPage === 0 && page.nodes.length > 0) break;

    hasNextPage = page.pageInfo.hasNextPage;
    after = page.pageInfo.endCursor;
    console.log(`  Found ${all.length} pull requests so far...`);
  }

  console.log(`Found ${all.length} total pull requests`);
  return all;
}
