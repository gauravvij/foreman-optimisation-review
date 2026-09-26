import { beforeEach, describe, expect, it, vi } from 'vitest';

const svc = vi.hoisted(() => ({ backfillIssueTypes: vi.fn(), syncIssueTypes: vi.fn() }));

vi.mock('../../../src/services/issue-type', () => ({
  backfillIssueTypes: svc.backfillIssueTypes,
  syncIssueTypes: svc.syncIssueTypes,
}));

import { applyIssueTypeSyncTool, classifyIssueTypesTool } from '../issue-types';

const ctx = {} as never;
const suspend = vi.fn();
const ctxWith = (resumeData?: { confirm: boolean }) =>
  ({ agent: { suspend, resumeData } }) as unknown as Parameters<
    NonNullable<typeof applyIssueTypeSyncTool.execute>
  >[1];

const backfill = (over = {}) => ({
  missing: [],
  classified: [],
  remaining: 0,
  errors: [],
  dryRun: true,
  ...over,
});

const sync = (over = {}) => ({
  planned: [],
  applied: 0,
  keptExisting: 0,
  unmapped: [],
  remaining: 0,
  repoTypes: ['Task', 'Bug', 'Feature'],
  dryRun: true,
  errors: [],
  ...over,
});

const change = (n: number, from: string | null, to: string) => ({ issueNumber: n, from, to });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GITHUB_OWNER = 'acme';
  process.env.GITHUB_REPO = 'widgets';
});

describe('classifyIssueTypesTool', () => {
  it('spends no model call unless asked to classify', async () => {
    svc.backfillIssueTypes.mockResolvedValue(backfill({ missing: [1, 2] }));

    const r = (await classifyIssueTypesTool.execute!({ classify: false, limit: 25 }, ctx)) as {
      untyped: number;
      message: string;
    };

    expect(svc.backfillIssueTypes).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    expect(r.untyped).toBe(2);
    expect(r.message).toContain('Re-run with classify');
  });

  it('reports how many need clarification, since that gates Ready', async () => {
    svc.backfillIssueTypes.mockResolvedValue(
      backfill({
        missing: [1, 2],
        dryRun: false,
        classified: [
          { number: 1, issueType: 'bug', needsClarification: true },
          { number: 2, issueType: 'task', needsClarification: false },
        ],
      }),
    );

    const r = (await classifyIssueTypesTool.execute!({ classify: true, limit: 25 }, ctx)) as {
      message: string;
    };

    expect(r.message).toContain('1 need clarification');
  });

  it('says how many are left when the batch was capped', async () => {
    svc.backfillIssueTypes.mockResolvedValue(
      backfill({
        missing: [1, 2, 3],
        dryRun: false,
        remaining: 2,
        classified: [{ number: 1, issueType: 'bug', needsClarification: false }],
      }),
    );

    const r = (await classifyIssueTypesTool.execute!({ classify: true, limit: 1 }, ctx)) as {
      message: string;
    };

    expect(r.message).toContain('2 still unclassified');
  });

  it('confirms completeness when nothing is untyped', async () => {
    svc.backfillIssueTypes.mockResolvedValue(backfill());

    const r = (await classifyIssueTypesTool.execute!({ classify: false, limit: 25 }, ctx)) as {
      message: string;
    };

    expect(r.message).toContain('already has a kind');
  });

  it('shapes a service failure instead of throwing', async () => {
    svc.backfillIssueTypes.mockRejectedValue(new Error('gateway down'));

    const r = (await classifyIssueTypesTool.execute!({ classify: true, limit: 25 }, ctx)) as {
      error?: string;
    };

    expect(r.error).toBe('gateway down');
  });
});

describe('applyIssueTypeSyncTool', () => {
  it('suspends for confirmation and writes nothing on the first call', async () => {
    svc.syncIssueTypes.mockResolvedValue(sync({ planned: [change(1, null, 'Bug')] }));

    const r = (await applyIssueTypeSyncTool.execute!({ overwrite: false }, ctxWith())) as {
      confirmed: boolean;
    };

    expect(suspend).toHaveBeenCalledTimes(1);
    expect(svc.syncIssueTypes.mock.calls.every((c) => c[0].dryRun === true)).toBe(true);
    expect(r.confirmed).toBe(false);
  });

  it('warns in the confirmation that this writes to the issues, not a board', async () => {
    svc.syncIssueTypes.mockResolvedValue(sync({ planned: [change(1, null, 'Bug')] }));

    await applyIssueTypeSyncTool.execute!({ overwrite: false }, ctxWith());

    expect(suspend.mock.calls[0][0].message).toContain('not to a project board');
  });

  it('says how many issues it left alone because a person had typed them', async () => {
    svc.syncIssueTypes.mockResolvedValue(
      sync({ planned: [change(1, null, 'Bug')], keptExisting: 17 }),
    );

    await applyIssueTypeSyncTool.execute!({ overwrite: false }, ctxWith());

    const msg = suspend.mock.calls[0][0].message;
    expect(msg).toContain('17 issue(s) already have a kind');
    expect(msg).toContain('pass overwrite');
  });

  it('counts how many would replace an existing type', async () => {
    svc.syncIssueTypes.mockResolvedValue(
      sync({ planned: [change(1, 'Task', 'Bug'), change(2, null, 'Feature')] }),
    );

    await applyIssueTypeSyncTool.execute!({ overwrite: true }, ctxWith());

    expect(suspend.mock.calls[0][0].replacing).toBe(1);
  });

  it('names the kinds the repository has no type for', async () => {
    svc.syncIssueTypes.mockResolvedValue(
      sync({ planned: [change(1, null, 'Bug')], unmapped: ['chore'] }),
    );

    await applyIssueTypeSyncTool.execute!({ overwrite: false }, ctxWith());

    const msg = suspend.mock.calls[0][0].message;
    expect(msg).toContain('no issue type for chore');
    expect(msg, 'saying what it does offer makes the fix obvious').toContain('Task, Bug, Feature');
  });

  it('writes nothing when the user declines', async () => {
    svc.syncIssueTypes.mockResolvedValue(sync({ planned: [change(1, null, 'Bug')] }));

    const r = (await applyIssueTypeSyncTool.execute!(
      { overwrite: false },
      ctxWith({ confirm: false }),
    )) as { message: string };

    expect(svc.syncIssueTypes.mock.calls.every((c) => c[0].dryRun === true)).toBe(true);
    expect(suspend, 'a decline must not re-prompt').not.toHaveBeenCalled();
    expect(r.message).toContain('Cancelled');
  });

  it('writes only after an explicit confirm, passing overwrite through', async () => {
    svc.syncIssueTypes.mockResolvedValue(
      sync({ planned: [change(1, 'Task', 'Bug')], applied: 1, dryRun: false }),
    );

    const r = (await applyIssueTypeSyncTool.execute!(
      { overwrite: true },
      ctxWith({ confirm: true }),
    )) as { applied: number; confirmed: boolean };

    expect(svc.syncIssueTypes).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: false, overwrite: true }),
    );
    expect(r.applied).toBe(1);
    expect(r.confirmed).toBe(true);
  });

  it('does not prompt when GitHub already matches', async () => {
    svc.syncIssueTypes.mockResolvedValue(sync({ keptExisting: 3 }));

    const r = (await applyIssueTypeSyncTool.execute!({ overwrite: false }, ctxWith())) as {
      message: string;
      keptExisting: number;
    };

    expect(suspend).not.toHaveBeenCalled();
    expect(r.message).toContain('already match');
    expect(r.keptExisting, 'the skipped ones are still worth surfacing').toBe(3);
  });

  it('reports a planning failure instead of prompting to confirm one', async () => {
    svc.syncIssueTypes.mockRejectedValue(new Error('no enabled issue types'));

    const r = (await applyIssueTypeSyncTool.execute!({ overwrite: false }, ctxWith())) as {
      errors: string[];
    };

    expect(suspend).not.toHaveBeenCalled();
    expect(r.errors[0]).toContain('no enabled issue types');
  });

  it('reports a missing repo rather than calling the service', async () => {
    process.env.GITHUB_REPO = '';

    const r = (await applyIssueTypeSyncTool.execute!({ overwrite: false }, ctxWith())) as {
      errors: string[];
    };

    expect(svc.syncIssueTypes).not.toHaveBeenCalled();
    expect(r.errors[0]).toContain('GITHUB_REPO');
  });
});
