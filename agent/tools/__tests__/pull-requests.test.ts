import { beforeEach, describe, expect, it, vi } from 'vitest';

const svc = vi.hoisted(() => ({
  fetchLinkedPullRequests: vi.fn(),
  fetchPullRequest: vi.fn(),
  commentOnPullRequest: vi.fn(),
  pullRequestStats: vi.fn(),
  refreshAllPullRequests: vi.fn(),
}));

vi.mock('../../../src/services/pull-requests', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/pull-requests')>();
  return {
    ...actual,
    fetchLinkedPullRequests: svc.fetchLinkedPullRequests,
    fetchPullRequest: svc.fetchPullRequest,
    commentOnPullRequest: svc.commentOnPullRequest,
  };
});

vi.mock('../../../src/services/pull-request-stats', () => ({
  pullRequestStats: svc.pullRequestStats,
  refreshAllPullRequests: svc.refreshAllPullRequests,
}));

import {
  commentOnPullRequestTool,
  inspectPullRequestTool,
  pullRequestStatsTool,
  readPullRequestsTool,
} from '../pull-requests';
import { refreshPullRequestsTool } from '../refresh-pull-requests';

const ctx = {} as never;

const pr = (over = {}) => ({
  number: 100,
  title: 'A change',
  url: 'https://github.com/acme/widgets/pull/100',
  state: 'OPEN',
  isDraft: false,
  reviewDecision: null,
  author: 'someone',
  updatedAt: '2026-09-13T00:00:00Z',
  closes: false,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GITHUB_OWNER = 'acme';
  process.env.GITHUB_REPO = 'widgets';
});

describe('readPullRequestsTool', () => {
  it('reports the pull requests linked to each issue', async () => {
    svc.fetchLinkedPullRequests.mockResolvedValue(new Map([[1, [pr()]]]));

    const r = (await readPullRequestsTool.execute!(
      { issueNumbers: [1], openOnly: false },
      ctx,
    )) as { withLinks: number; issues: { hasOpenReadyPR: boolean }[] };

    expect(r.withLinks).toBe(1);
    expect(r.issues[0].hasOpenReadyPR).toBe(true);
  });

  it('leaves out issues that have no linked pull request', async () => {
    svc.fetchLinkedPullRequests.mockResolvedValue(
      new Map([
        [1, [pr()]],
        [2, []],
      ]),
    );

    const r = (await readPullRequestsTool.execute!(
      { issueNumbers: [1, 2], openOnly: false },
      ctx,
    )) as { issues: { issueNumber: number }[]; message: string };

    expect(r.issues.map((i) => i.issueNumber)).toEqual([1]);
    expect(r.message).toContain('1 of 2');
  });

  it('names issues whose pull request merged while the issue stayed open', async () => {
    svc.fetchLinkedPullRequests.mockResolvedValue(new Map([[1, [pr({ state: 'MERGED' })]]]));

    const r = (await readPullRequestsTool.execute!(
      { issueNumbers: [1], openOnly: false },
      ctx,
    )) as { shippedButOpen: number[]; message: string };

    expect(r.shippedButOpen).toEqual([1]);
    expect(r.message).toContain('may be finished');
  });

  it('does not call an issue finished while a pull request is still open', async () => {
    svc.fetchLinkedPullRequests.mockResolvedValue(
      new Map([[1, [pr({ number: 1, state: 'MERGED' }), pr({ number: 2, state: 'OPEN' })]]]),
    );

    const r = (await readPullRequestsTool.execute!(
      { issueNumbers: [1], openOnly: false },
      ctx,
    )) as { shippedButOpen: number[] };

    expect(r.shippedButOpen, 'follow-up work is still in flight').toEqual([]);
  });

  it('filters to issues with an open pull request when asked', async () => {
    svc.fetchLinkedPullRequests.mockResolvedValue(
      new Map([
        [1, [pr({ state: 'MERGED' })]],
        [2, [pr({ isDraft: true })]],
      ]),
    );

    const r = (await readPullRequestsTool.execute!(
      { issueNumbers: [1, 2], openOnly: true },
      ctx,
    )) as { issues: { issueNumber: number }[] };

    expect(r.issues.map((i) => i.issueNumber)).toEqual([2]);
  });

  it('counts drafts separately from work awaiting review', async () => {
    svc.fetchLinkedPullRequests.mockResolvedValue(
      new Map([
        [1, [pr({ isDraft: true })]],
        [2, [pr()]],
      ]),
    );

    const r = (await readPullRequestsTool.execute!(
      { issueNumbers: [1, 2], openOnly: false },
      ctx,
    )) as { message: string };

    expect(r.message).toContain('1 awaiting review');
    expect(r.message).toContain('1 still in draft');
  });

  it('does not call GitHub when given no issues', async () => {
    const r = (await readPullRequestsTool.execute!({ issueNumbers: [], openOnly: false }, ctx)) as {
      message: string;
    };

    expect(svc.fetchLinkedPullRequests).not.toHaveBeenCalled();
    expect(r.message).toContain('No issues given');
  });

  it('says so plainly when nothing is linked', async () => {
    svc.fetchLinkedPullRequests.mockResolvedValue(new Map([[1, []]]));

    const r = (await readPullRequestsTool.execute!(
      { issueNumbers: [1], openOnly: false },
      ctx,
    )) as { message: string };

    expect(r.message).toContain('None of those issues');
  });

  it('reports a missing repo rather than calling the service', async () => {
    process.env.GITHUB_OWNER = '';

    const r = (await readPullRequestsTool.execute!(
      { issueNumbers: [1], openOnly: false },
      ctx,
    )) as { error?: string };

    expect(svc.fetchLinkedPullRequests).not.toHaveBeenCalled();
    expect(r.error).toContain('GITHUB_OWNER');
  });

  it('shapes a service failure instead of throwing', async () => {
    svc.fetchLinkedPullRequests.mockRejectedValue(new Error('rate limited'));

    const r = (await readPullRequestsTool.execute!(
      { issueNumbers: [1], openOnly: false },
      ctx,
    )) as { error?: string };

    expect(r.error).toBe('rate limited');
  });
});

const detail = (over = {}) => ({
  number: 88,
  title: 'hot-reload the directories the spec names',
  url: 'https://github.com/acme/widgets/pull/88',
  state: 'OPEN',
  isDraft: false,
  reviewDecision: 'APPROVED',
  author: 'someone',
  body: 'why this change exists',
  createdAt: '2026-09-25T00:00:00Z',
  updatedAt: '2026-09-26T00:00:00Z',
  mergedAt: null,
  headRefName: 'fix/dev-mount-src',
  baseRefName: 'main',
  additions: 901,
  deletions: 22,
  changedFiles: 8,
  labels: ['dev'],
  closesIssues: [2110],
  checksState: 'SUCCESS',
  ...over,
});

describe('inspectPullRequestTool', () => {
  it('reads one pull request by its own number', async () => {
    svc.fetchPullRequest.mockResolvedValue(detail());

    const r = (await inspectPullRequestTool.execute!({ number: 88 }, ctx)) as {
      found: boolean;
      message: string;
      pullRequest: { checksState: string; closesIssues: number[]; bodyTruncated: boolean };
    };

    expect(svc.fetchPullRequest).toHaveBeenCalledWith('acme', 'widgets', 88);
    expect(r.found).toBe(true);
    expect(r.pullRequest.checksState, 'check state is why someone asks if it is mergeable').toBe(
      'SUCCESS',
    );
    expect(r.pullRequest.closesIssues).toEqual([2110]);
    expect(r.message).toContain('#88');
    expect(r.message).toContain('approved');
  });

  it('renders a wire review decision as prose', async () => {
    svc.fetchPullRequest.mockResolvedValue(detail({ reviewDecision: 'CHANGES_REQUESTED' }));

    const r = (await inspectPullRequestTool.execute!({ number: 88 }, ctx)) as { message: string };

    expect(r.message, 'a summary is read by a person, not a parser').toContain('changes requested');
  });

  it('says a missing number may be an issue rather than a pull request', async () => {
    svc.fetchPullRequest.mockResolvedValue(null);

    const r = (await inspectPullRequestTool.execute!({ number: 4242 }, ctx)) as {
      found: boolean;
      message: string;
    };

    expect(r.found).toBe(false);
    expect(
      r.message,
      'the numbers share a space, so the reply says which kind was missing',
    ).toContain('issue with that number is a different thing');
  });

  it('truncates a long body and says it did', async () => {
    svc.fetchPullRequest.mockResolvedValue(detail({ body: 'x'.repeat(9000) }));

    const r = (await inspectPullRequestTool.execute!({ number: 88 }, ctx)) as {
      pullRequest: { body: string; bodyTruncated: boolean };
    };

    expect(r.pullRequest.body.length).toBe(4000);
    expect(r.pullRequest.bodyTruncated, 'a short read must not look like a short body').toBe(true);
  });

  it('omits the body when asked to', async () => {
    svc.fetchPullRequest.mockResolvedValue(detail());

    const r = (await inspectPullRequestTool.execute!({ number: 88, includeBody: false }, ctx)) as {
      pullRequest: { body: string; bodyTruncated: boolean };
    };

    expect(r.pullRequest.body).toBe('');
    expect(r.pullRequest.bodyTruncated).toBe(false);
  });
});

describe('commentOnPullRequestTool', () => {
  const suspending = { agent: { suspend: vi.fn() } } as never;

  it('writes nothing before it is confirmed', async () => {
    svc.fetchPullRequest.mockResolvedValue(detail());

    await commentOnPullRequestTool.execute!({ number: 88, comment: 'a note' }, suspending);

    expect(svc.commentOnPullRequest, 'a write tool asks first').not.toHaveBeenCalled();
  });

  it('posts once confirmed', async () => {
    svc.commentOnPullRequest.mockResolvedValue({
      number: 88,
      url: 'https://github.com/acme/widgets/pull/88',
      title: 'a change',
    });

    const r = (await commentOnPullRequestTool.execute!({ number: 88, comment: 'a note' }, {
      agent: { resumeData: { confirm: true } },
    } as never)) as { posted: boolean; url: string };

    expect(svc.commentOnPullRequest).toHaveBeenCalledWith('acme', 'widgets', 88, 'a note');
    expect(r.posted).toBe(true);
  });

  it('posts nothing when declined', async () => {
    const r = (await commentOnPullRequestTool.execute!({ number: 88, comment: 'a note' }, {
      agent: { resumeData: { confirm: false } },
    } as never)) as { posted: boolean; message: string };

    expect(svc.commentOnPullRequest).not.toHaveBeenCalled();
    expect(r.posted).toBe(false);
    expect(r.message).toContain('Cancelled');
  });

  it('does not ask about a pull request that does not exist', async () => {
    svc.fetchPullRequest.mockResolvedValue(null);

    const r = (await commentOnPullRequestTool.execute!(
      { number: 4242, comment: 'a note' },
      suspending,
    )) as { posted: boolean; message: string };

    expect(r.posted).toBe(false);
    expect(r.message).toContain('nothing to comment on');
    expect(svc.commentOnPullRequest).not.toHaveBeenCalled();
  });
});

describe('pullRequestStatsTool', () => {
  it('passes the user inputs through and formats a human summary', async () => {
    svc.pullRequestStats.mockResolvedValue({
      author: 'alice',
      window: { since: '2026-10-09T00:00:00.000Z', until: '2026-10-16T00:00:00.000Z', days: 7 },
      opened: 4,
      merged: 2,
      closed: 1,
      sample: [],
    });

    const r = (await pullRequestStatsTool.execute!({ author: 'alice', windowDays: 7 }, ctx)) as {
      message: string;
      opened: number;
      merged: number;
      closed: number;
    };

    expect(svc.pullRequestStats).toHaveBeenCalledWith(
      expect.objectContaining({ author: 'alice', windowDays: 7 }),
    );
    expect(r.opened).toBe(4);
    expect(r.merged).toBe(2);
    expect(r.closed).toBe(1);
    expect(r.message, 'the summary names the author').toContain('@alice');
    expect(r.message, 'and the window').toContain('7 days');
    expect(r.message, 'and the three counts').toContain('opened 4, merged 2');
  });

  it('says "everyone" when no author filter is given', async () => {
    svc.pullRequestStats.mockResolvedValue({
      window: { since: 'a', until: 'b', days: 1 },
      opened: 0,
      merged: 0,
      closed: 0,
      sample: [],
    });

    const r = (await pullRequestStatsTool.execute!({ windowDays: 1 }, ctx)) as {
      message: string;
    };

    expect(r.message).toContain('everyone');
  });

  it('returns zeros and the service error when the Cypher fails', async () => {
    svc.pullRequestStats.mockRejectedValue(new Error('neo4j is down'));

    const r = (await pullRequestStatsTool.execute!({}, ctx)) as {
      opened: number;
      merged: number;
      closed: number;
      error?: string;
      message: string;
    };

    expect(r.opened).toBe(0);
    expect(r.error).toBe('neo4j is down');
    expect(r.message).toContain('Could not read');
  });
});

describe('refreshPullRequestsTool', () => {
  it('reports the gap without writing when refresh is false', async () => {
    svc.refreshAllPullRequests.mockResolvedValue({
      graphBefore: 25,
      fetched: 500,
      ingested: 0,
      errors: [],
    });

    const r = (await refreshPullRequestsTool.execute!({ refresh: false, limit: 0 }, ctx)) as {
      graphBefore: number;
      fetched: number;
      ingested: number;
      gap: number;
      message: string;
    };

    expect(svc.refreshAllPullRequests).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'acme', repo: 'widgets', dryRun: true, limit: 0 }),
    );
    expect(r.gap).toBe(475);
    expect(r.ingested).toBe(0);
    expect(r.message, 'the dry-run message names both sides of the gap').toContain('500');
    expect(r.message).toContain('25');
  });

  it('upserts and reports the ingested count when refresh is true', async () => {
    svc.refreshAllPullRequests.mockResolvedValue({
      graphBefore: 25,
      fetched: 500,
      ingested: 475,
      errors: [],
    });

    const r = (await refreshPullRequestsTool.execute!({ refresh: true, limit: 0 }, ctx)) as {
      ingested: number;
      message: string;
    };

    expect(svc.refreshAllPullRequests).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: false }),
    );
    expect(r.ingested).toBe(475);
    expect(r.message, 'the write-run message names the before and after totals').toContain('25');
    expect(r.message).toContain('500');
  });

  it('reports a missing repo rather than calling the service', async () => {
    process.env.GITHUB_OWNER = '';

    const r = (await refreshPullRequestsTool.execute!({ refresh: true, limit: 0 }, ctx)) as {
      error?: string;
    };

    expect(svc.refreshAllPullRequests).not.toHaveBeenCalled();
    expect(r.error).toContain('GITHUB_OWNER');
  });

  it('shapes a service failure instead of throwing', async () => {
    svc.refreshAllPullRequests.mockRejectedValue(new Error('rate limited'));

    const r = (await refreshPullRequestsTool.execute!({ refresh: false, limit: 0 }, ctx)) as {
      error?: string;
      message: string;
    };

    expect(r.error).toBe('rate limited');
    expect(r.message).toContain('Refresh failed');
  });
});
