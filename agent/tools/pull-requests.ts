import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { pullRequestStats } from '../../src/services/pull-request-stats';
import type { PullRequestDetail } from '../../src/services/pull-requests';
import {
  commentOnPullRequest,
  fetchLinkedPullRequests,
  fetchPullRequest,
  isShippedButOpen,
  summariseLinks,
} from '../../src/services/pull-requests';

const PR = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  isDraft: z.boolean(),
  reviewDecision: z.string().nullable(),
  author: z.string().nullable(),
  updatedAt: z.string(),
  closes: z.boolean(),
});

export const readPullRequestsTool = createTool({
  id: 'readPullRequests',
  description:
    'Read the pull requests linked to issues: their state, whether they are ' +
    'still a draft, and whether the pull request declares it closes the issue ' +
    'rather than only mentioning it. Read-only. Use it to answer whether work ' +
    'has started on an issue, what is awaiting review, or which issues have ' +
    'shipped but are still open.\n\n' +
    'Rules:\n' +
    '- Two tools read pull requests and they start from different things. This ' +
    'one answers "what is linked to these issues" from issue numbers. ' +
    'inspectPullRequest reads one pull request by its own number, in full, and ' +
    'is also how to refetch one whose state has moved on. Neither reads the ' +
    'graph, which holds issues only.\n' +
    '- Individual pull request details (reviewDecision, checksState, draft flag) ' +
    'are not in the graph, so use this tool or inspectPullRequest to answer why ' +
    'a board card sits where it does.',
  inputSchema: z.object({
    issueNumbers: z
      .array(z.number())
      .describe('Issues to look up. Ask for the ones you care about, not the whole repo.'),
    openOnly: z
      .boolean()
      .default(false)
      .describe('Report only issues that have an open pull request'),
  }),
  outputSchema: z.object({
    issues: z.array(
      z.object({
        issueNumber: z.number(),
        pullRequests: z.array(PR),
        hasOpenReadyPR: z.boolean(),
        hasDraftPR: z.boolean(),
        hasMergedPR: z.boolean(),
      }),
    ),
    withLinks: z.number(),
    shippedButOpen: z.array(z.number()),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (input) => {
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    if (!owner || !repo) {
      return {
        issues: [],
        withLinks: 0,
        shippedButOpen: [],
        message: 'Cannot read pull requests: the repository is not configured.',
        error: 'GITHUB_OWNER and GITHUB_REPO are not set',
      };
    }

    if (input.issueNumbers.length === 0) {
      return {
        issues: [],
        withLinks: 0,
        shippedButOpen: [],
        message: 'No issues given, so nothing was looked up.',
      };
    }

    try {
      console.log(`  [readPullRequests] ${input.issueNumbers.length} issue(s)`);
      const linked = await fetchLinkedPullRequests(owner, repo, input.issueNumbers);

      const issues = [];
      const shippedButOpen: number[] = [];

      for (const [issueNumber, pullRequests] of linked) {
        const s = summariseLinks(pullRequests);
        if (pullRequests.length === 0) continue;
        if (input.openOnly && !s.hasOpenReadyPR && !s.hasDraftPR) continue;
        if (isShippedButOpen(s)) shippedButOpen.push(issueNumber);
        issues.push({
          issueNumber,
          pullRequests,
          hasOpenReadyPR: s.hasOpenReadyPR,
          hasDraftPR: s.hasDraftPR,
          hasMergedPR: s.hasMergedPR,
        });
      }

      const awaiting = issues.filter((i) => i.hasOpenReadyPR).length;
      const drafting = issues.filter((i) => i.hasDraftPR).length;

      return {
        issues,
        withLinks: issues.length,
        shippedButOpen,
        message:
          issues.length === 0
            ? 'None of those issues has a linked pull request.'
            : [
                `${issues.length} of ${input.issueNumbers.length} issue(s) have a linked pull request.`,
                awaiting > 0 ? `${awaiting} awaiting review.` : '',
                drafting > 0 ? `${drafting} still in draft.` : '',
                shippedButOpen.length > 0
                  ? `${shippedButOpen.length} have a merged pull request but are still open, so they may be finished: ${shippedButOpen.map((n) => `#${n}`).join(', ')}.`
                  : '',
              ]
                .filter(Boolean)
                .join(' '),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [readPullRequests] error: ${msg}`);
      return {
        issues: [],
        withLinks: 0,
        shippedButOpen: [],
        message: 'Could not read the linked pull requests.',
        error: msg,
      };
    }
  },
});

const BODY_PREVIEW = 4000;

/** APPROVED and CHANGES_REQUESTED are wire values; a summary is read by a person. */
function readable(value: string): string {
  return value.toLowerCase().replace(/_/g, ' ');
}

function summarise(pr: PullRequestDetail): string {
  const readiness = pr.isDraft
    ? 'draft'
    : pr.reviewDecision
      ? readable(pr.reviewDecision)
      : 'no review yet';
  const checks = pr.checksState ? `, checks ${readable(pr.checksState)}` : '';
  const closes = pr.closesIssues.length > 0 ? `, closes #${pr.closesIssues.join(', #')}` : '';
  return (
    `#${pr.number} "${pr.title}" by ${pr.author ?? 'unknown'} — ${readable(pr.state)}, ` +
    `${readiness}${checks}${closes}. ` +
    `${pr.headRefName} into ${pr.baseRefName}, ${pr.changedFiles} file(s) ` +
    `(+${pr.additions}/-${pr.deletions}). ${pr.url}`
  );
}

export const inspectPullRequestTool = createTool({
  id: 'inspectPullRequest',
  description:
    'Read one pull request as it stands right now: state, draft flag, review ' +
    'decision, check status, branches, diff size, labels, the issues it closes, ' +
    'and its body. Goes to GitHub rather than the graph, so this is also how to ' +
    'refetch a PR whose state has moved on. Takes a pull request number; use ' +
    'readPullRequests when starting from issue numbers.\n\n' +
    'Rules:\n' +
    '- Two tools read pull requests and they start from different things. ' +
    'readPullRequests answers "what is linked to these issues" from issue ' +
    'numbers. This one reads a single pull request by its own number, in full. ' +
    'Neither reads the graph, which holds issues only.',
  inputSchema: z.object({
    number: z.number().describe('The pull request number'),
    includeBody: z
      .boolean()
      .optional()
      .describe('Include the PR description. Defaults to true; set false for just the state.'),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    pullRequest: z
      .object({
        number: z.number(),
        title: z.string(),
        url: z.string(),
        state: z.string(),
        isDraft: z.boolean(),
        reviewDecision: z.string().nullable(),
        author: z.string().nullable(),
        body: z.string(),
        bodyTruncated: z.boolean(),
        createdAt: z.string(),
        updatedAt: z.string(),
        mergedAt: z.string().nullable(),
        headRefName: z.string(),
        baseRefName: z.string(),
        additions: z.number(),
        deletions: z.number(),
        changedFiles: z.number(),
        labels: z.array(z.string()),
        closesIssues: z.array(z.number()),
        checksState: z.string().nullable(),
      })
      .nullable(),
    message: z.string(),
  }),
  execute: async (input) => {
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    if (!owner || !repo) {
      return {
        found: false,
        pullRequest: null,
        message: 'Cannot read the pull request: the repository is not configured.',
      };
    }

    console.log(`  [inspectPullRequest] #${input.number} from ${owner}/${repo}`);
    const pr = await fetchPullRequest(owner, repo, input.number);
    if (!pr) {
      return {
        found: false,
        pullRequest: null,
        message: `${owner}/${repo} has no pull request #${input.number}. An issue with that number is a different thing; read it as an issue instead.`,
      };
    }

    const wantBody = input.includeBody !== false;
    const body = wantBody ? pr.body.slice(0, BODY_PREVIEW) : '';
    return {
      found: true,
      pullRequest: {
        ...pr,
        body,
        bodyTruncated: wantBody && pr.body.length > BODY_PREVIEW,
      },
      message: summarise(pr),
    };
  },
});

export const commentOnPullRequestTool = createTool({
  id: 'commentOnPullRequest',
  description:
    'Post a comment on a pull request. Use this for review feedback or a status ' +
    'note that belongs on the PR rather than on the issue it closes. The comment ' +
    'is signed as agent-written, like every comment this agent posts. Shows the ' +
    'comment and waits for confirmation before posting. Use updateIssue to ' +
    'comment on an issue instead.\n\n' +
    'Rules:\n' +
    '- A comment about the code under review belongs here. A comment about ' +
    'whether the work is worth doing belongs on the issue, through updateIssue. ' +
    'Do not post the same note to both.\n' +
    '- This number is a pull request number, not an issue number. A comment ' +
    'posted on the wrong one cannot be withdrawn.',
  inputSchema: z.object({
    number: z.number().describe('The pull request number'),
    comment: z.string().min(1).describe('The comment body, in GitHub markdown'),
  }),
  suspendSchema: z.object({
    message: z.string(),
    number: z.number(),
    title: z.string(),
    url: z.string(),
  }),
  resumeSchema: z.object({
    confirm: z.boolean().describe('Set true to post the comment. False cancels.'),
  }),
  outputSchema: z.object({
    posted: z.boolean(),
    number: z.number(),
    url: z.string(),
    message: z.string(),
  }),
  execute: async (input, ctx) => {
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const empty = { posted: false, number: input.number, url: '' };
    if (!owner || !repo) {
      return { ...empty, message: 'Cannot comment: the repository is not configured.' };
    }

    const resumeData = ctx?.agent?.resumeData as { confirm?: boolean } | undefined;

    if (resumeData?.confirm === true) {
      console.log(`  [commentOnPullRequest] confirmed, posting on #${input.number}`);
      const result = await commentOnPullRequest(owner, repo, input.number, input.comment);
      return {
        posted: true,
        number: result.number,
        url: result.url,
        message: `Commented on #${result.number} "${result.title}". ${result.url}`,
      };
    }

    if (resumeData) {
      console.log('  [commentOnPullRequest] declined, nothing posted');
      return { ...empty, message: 'Cancelled. Nothing was posted.' };
    }

    // Read it first, so the confirmation names the PR rather than a bare number
    // and a wrong number is caught before anything is written.
    const pr = await fetchPullRequest(owner, repo, input.number);
    if (!pr) {
      return {
        ...empty,
        message: `${owner}/${repo} has no pull request #${input.number}, so there is nothing to comment on.`,
      };
    }

    console.log(`  [commentOnPullRequest] awaiting confirmation for #${input.number}`);
    await ctx.agent?.suspend({
      message: [
        `About to comment on #${pr.number} "${pr.title}" (${pr.state.toLowerCase()}). ${pr.url}`,
        '',
        input.comment,
        '',
        'The comment is signed as agent-written. Confirm to post it.',
      ].join('\n'),
      number: pr.number,
      title: pr.title,
      url: pr.url,
    });

    return { ...empty, url: pr.url, message: 'Waiting for confirmation before posting.' };
  },
});

const STATS_SAMPLE = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  author: z.string().nullable(),
  state: z.string(),
  isDraft: z.boolean(),
  isMerged: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().nullable(),
  mergedAt: z.string().nullable(),
});

export const pullRequestStatsTool = createTool({
  id: 'pullRequestStats',
  description:
    'Count pull requests opened, merged, or closed during a time window, ' +
    'optionally filtered to a GitHub login. The three counts are independent: ' +
    'a PR merged this week may have been opened earlier, and one closed ' +
    'without being merged counts under closed, not merged. Windowed, so it ' +
    'does NOT answer point-in-time totals such as "how many are open right ' +
    'now" — use queryNeo4j on PullRequest nodes for those. Read-only, backed ' +
    'by the graph. Returns a short sample of recent PRs alongside the counts.\n\n' +
    'Rules:\n' +
    '- The graph is fed by a sync that only picks up pull requests updated since ' +
    'the last run, so a dormant open PR untouched since the first startup may ' +
    'never land in it. If a count comes back lower than the user expects, run ' +
    'refreshPullRequests (dry run first, then with refresh: true) before ' +
    'reporting the number.',
  inputSchema: z.object({
    author: z
      .string()
      .optional()
      .describe('GitHub login (no leading @). Omit for repo-wide counts across every author.'),
    since: z
      .string()
      .optional()
      .describe('ISO 8601 window start. Omit to use windowDays ending at `until` or now.'),
    until: z.string().optional().describe('ISO 8601 window end. Omit to use now.'),
    windowDays: z
      .number()
      .int()
      .min(1)
      .max(90)
      .optional()
      .describe('Window length when `since` is omitted. Default 7, max 90.'),
    sampleLimit: z
      .number()
      .int()
      .min(0)
      .max(20)
      .optional()
      .describe('Number of example pull requests to return, newest activity first. Default 5.'),
  }),
  outputSchema: z.object({
    author: z.string().optional(),
    window: z.object({ since: z.string(), until: z.string(), days: z.number() }),
    opened: z.number(),
    merged: z.number(),
    closed: z.number(),
    sample: z.array(STATS_SAMPLE),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (input) => {
    const emptyWindow = { since: '', until: '', days: 0 };
    const empty = {
      window: emptyWindow,
      opened: 0,
      merged: 0,
      closed: 0,
      sample: [] as z.infer<typeof STATS_SAMPLE>[],
    };

    try {
      console.log(
        `  [pullRequestStats] author=${input.author ?? '*'} window=${input.since ?? `${input.windowDays ?? 7}d`}..${input.until ?? 'now'}`,
      );
      const stats = await pullRequestStats({
        author: input.author,
        since: input.since,
        until: input.until,
        windowDays: input.windowDays,
        sampleLimit: input.sampleLimit,
      });

      const who = stats.author ? `@${stats.author}` : 'everyone';
      const period = `the last ${stats.window.days} day${stats.window.days === 1 ? '' : 's'}`;
      const message = `${who} in ${period}: opened ${stats.opened}, merged ${stats.merged}, closed without merge ${stats.closed}.`;

      return {
        author: stats.author,
        window: stats.window,
        opened: stats.opened,
        merged: stats.merged,
        closed: stats.closed,
        sample: stats.sample,
        message,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [pullRequestStats] error: ${msg}`);
      return { ...empty, message: 'Could not read pull request stats.', error: msg };
    }
  },
});
