import { beforeEach, describe, expect, it, vi } from 'vitest';

const svc = vi.hoisted(() => ({
  reconcileIssueState: vi.fn(),
  ingestMissingIssues: vi.fn(),
  refreshIssues: vi.fn(),
}));

vi.mock('../../../src/services/issue-state', () => ({
  reconcileIssueState: svc.reconcileIssueState,
}));
vi.mock('../../../src/services/issue-gap', () => ({
  ingestMissingIssues: svc.ingestMissingIssues,
}));
vi.mock('../../../src/services/issue-refresh', () => ({ refreshIssues: svc.refreshIssues }));

import { ingestMissingIssuesTool } from '../ingest-missing-issues';
import { reconcileIssueStateTool } from '../reconcile-issue-state';
import { refreshIssuesTool } from '../refresh-issues';

const ctx = {} as never;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GITHUB_OWNER = 'acme';
  process.env.GITHUB_REPO = 'widgets';
});

describe('reconcileIssueStateTool', () => {
  const ok = (over = {}) => ({
    checked: 10,
    resolved: 10,
    unresolved: [],
    ghosts: [],
    ghostsKept: [],
    drift: [],
    applied: 0,
    deleted: 0,
    dryRun: true,
    ...over,
  });

  it('reports drift without writing when apply is false', async () => {
    svc.reconcileIssueState.mockResolvedValue(
      ok({ drift: [{ number: 1, storedState: 'OPEN', liveState: 'CLOSED', closedAt: 't' }] }),
    );

    const r = (await reconcileIssueStateTool.execute!({ apply: false }, ctx)) as {
      driftCount: number;
      message: string;
    };

    expect(svc.reconcileIssueState).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    expect(r.driftCount).toBe(1);
    expect(r.message).toContain('Re-run with apply');
  });

  it('names an issue GitHub no longer has instead of failing on it', async () => {
    svc.reconcileIssueState.mockResolvedValue(ok({ ghosts: [2795] }));

    const r = (await reconcileIssueStateTool.execute!({ apply: false }, ctx)) as {
      ghosts: number[];
      message: string;
    };

    expect(r.ghosts, 'a deleted issue is reported, not an error').toEqual([2795]);
    expect(r.message).toContain('do not exist on GitHub');
    expect(r.message, 'a ghost is only removed when asked').toContain('Re-run with apply');
  });

  it('reports removing a ghost, and keeping one that carries an assessment', async () => {
    svc.reconcileIssueState.mockResolvedValue(
      ok({ dryRun: false, ghosts: [2795, 1032], ghostsKept: [1032], deleted: 1 }),
    );

    const r = (await reconcileIssueStateTool.execute!({ apply: true }, ctx)) as {
      deleted: number;
      message: string;
    };

    expect(r.deleted).toBe(1);
    expect(r.message).toContain('Removed 1');
    expect(r.message, 'a human decision must not vanish silently').toContain('1032');
    expect(r.message).toContain('assessment');
  });

  it('keeps an unreachable issue separate from a deleted one', async () => {
    svc.reconcileIssueState.mockResolvedValue(ok({ unresolved: [7] }));

    const r = (await reconcileIssueStateTool.execute!({ apply: false }, ctx)) as {
      ghosts: number[];
      unresolved: number[];
      message: string;
    };

    expect(r.ghosts, 'not checking an issue is not evidence it was deleted').toEqual([]);
    expect(r.unresolved).toEqual([7]);
    expect(r.message).toContain('could not be checked');
  });

  it('writes when apply is true', async () => {
    svc.reconcileIssueState.mockResolvedValue(
      ok({
        applied: 2,
        dryRun: false,
        drift: [
          { number: 1, storedState: 'OPEN', liveState: 'CLOSED', closedAt: 't' },
          { number: 2, storedState: 'OPEN', liveState: 'CLOSED', closedAt: 't' },
        ],
      }),
    );

    const r = (await reconcileIssueStateTool.execute!({ apply: true }, ctx)) as {
      message: string;
    };

    expect(svc.reconcileIssueState).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: false }),
    );
    expect(r.message).toContain('Corrected 2');
  });

  it('says the graph matches when there is no drift', async () => {
    svc.reconcileIssueState.mockResolvedValue(ok());

    const r = (await reconcileIssueStateTool.execute!({ apply: false }, ctx)) as {
      message: string;
    };

    expect(r.message).toContain('Nothing to correct');
  });

  it('shapes a service failure instead of throwing', async () => {
    svc.reconcileIssueState.mockRejectedValue(new Error('bolt refused'));

    const r = (await reconcileIssueStateTool.execute!({ apply: false }, ctx)) as {
      error?: string;
    };

    expect(r.error).toBe('bolt refused');
  });

  it('reports a missing repo rather than calling the service', async () => {
    process.env.GITHUB_OWNER = '';

    const r = (await reconcileIssueStateTool.execute!({ apply: false }, ctx)) as { error?: string };

    expect(svc.reconcileIssueState).not.toHaveBeenCalled();
    expect(r.error).toContain('GITHUB_OWNER');
  });
});

describe('ingestMissingIssuesTool', () => {
  const ok = (over = {}) => ({
    githubOpen: 138,
    graphTotal: 136,
    missing: [],
    ingested: [],
    analyzed: 0,
    errors: [],
    dryRun: true,
    ...over,
  });

  it('reports the gap without fetching when ingest is false', async () => {
    svc.ingestMissingIssues.mockResolvedValue(ok({ missing: [2476, 2477] }));

    const r = (await ingestMissingIssuesTool.execute!(
      { ingest: false, limit: 25, analyze: true },
      ctx,
    )) as { missingCount: number; message: string };

    expect(svc.ingestMissingIssues).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    expect(r.missingCount).toBe(2);
    expect(r.message).toContain('Re-run with ingest');
  });

  it('says how many remain when the batch was capped', async () => {
    svc.ingestMissingIssues.mockResolvedValue(
      ok({ missing: [1, 2, 3], ingested: [1, 2], dryRun: false }),
    );

    const r = (await ingestMissingIssuesTool.execute!(
      { ingest: true, limit: 2, analyze: false },
      ctx,
    )) as { message: string };

    expect(r.message, 'a silent cap reads as "covered everything"').toContain('still missing');
  });

  it('confirms completeness when nothing is missing', async () => {
    svc.ingestMissingIssues.mockResolvedValue(ok());

    const r = (await ingestMissingIssuesTool.execute!(
      { ingest: false, limit: 25, analyze: true },
      ctx,
    )) as { message: string };

    expect(r.message).toContain('every open issue');
  });

  it('shapes a service failure instead of throwing', async () => {
    svc.ingestMissingIssues.mockRejectedValue(new Error('rate limited'));

    const r = (await ingestMissingIssuesTool.execute!(
      { ingest: true, limit: 25, analyze: true },
      ctx,
    )) as { error?: string };

    expect(r.error).toBe('rate limited');
  });
});

describe('refreshIssuesTool', () => {
  const ok = (over = {}) => ({
    checked: 144,
    stale: [],
    refreshed: [],
    analyzed: 0,
    errors: [],
    dryRun: true,
    ...over,
  });

  it('reports stale issues without re-reading when refresh is false', async () => {
    svc.refreshIssues.mockResolvedValue(
      ok({ stale: [{ number: 1584, storedUpdatedAt: 'a', liveUpdatedAt: 'b' }] }),
    );

    const r = (await refreshIssuesTool.execute!(
      { refresh: false, analyze: false, limit: 25 },
      ctx,
    )) as { staleCount: number; stale: number[]; message: string };

    expect(svc.refreshIssues).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    expect(r.stale).toEqual([1584]);
    expect(r.message).toContain('Re-run with refresh');
  });

  it('passes an explicit issue list straight through', async () => {
    svc.refreshIssues.mockResolvedValue(ok({ stale: [], refreshed: [1584], dryRun: false }));

    await refreshIssuesTool.execute!(
      { issueNumbers: [1584], refresh: true, analyze: false, limit: 25 },
      ctx,
    );

    expect(svc.refreshIssues).toHaveBeenCalledWith(
      expect.objectContaining({ issueNumbers: [1584] }),
    );
  });

  it('does not re-classify unless asked, since that costs a model call each', async () => {
    svc.refreshIssues.mockResolvedValue(ok({ refreshed: [1], dryRun: false }));

    await refreshIssuesTool.execute!({ refresh: true, analyze: false, limit: 25 }, ctx);

    expect(svc.refreshIssues).toHaveBeenCalledWith(expect.objectContaining({ analyze: false }));
  });

  it('says the graph matches when nothing changed', async () => {
    svc.refreshIssues.mockResolvedValue(ok());

    const r = (await refreshIssuesTool.execute!(
      { refresh: false, analyze: false, limit: 25 },
      ctx,
    )) as { message: string };

    expect(r.message).toContain('Nothing to re-read');
  });

  it('shapes a service failure instead of throwing', async () => {
    svc.refreshIssues.mockRejectedValue(new Error('graphql 502'));

    const r = (await refreshIssuesTool.execute!(
      { refresh: true, analyze: false, limit: 25 },
      ctx,
    )) as { error?: string };

    expect(r.error).toBe('graphql 502');
  });
});
