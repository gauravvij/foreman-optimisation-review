import { beforeEach, describe, expect, it, vi } from 'vitest';

const svc = vi.hoisted(() => ({ syncLabels: vi.fn() }));

vi.mock('../../../src/services/github-labels', () => ({ syncLabels: svc.syncLabels }));

import { previewLabelSyncTool } from '../preview-label-sync';

const ctx = {} as never;

const plan = (over = {}) => ({
  planned: [],
  labelsCreated: [],
  labelsDeleted: [],
  errors: [],
  ...over,
});

const change = (n: number) => ({ issueNumber: n, add: ['priority:P2'], remove: [] });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GITHUB_OWNER = 'acme';
  process.env.GITHUB_REPO = 'widgets';
});

describe('previewLabelSyncTool', () => {
  it('never reaches a write path, whatever the plan says', async () => {
    svc.syncLabels.mockResolvedValue(plan({ planned: [change(1)] }));

    await previewLabelSyncTool.execute!({ limit: 25 }, ctx);

    expect(svc.syncLabels).toHaveBeenCalledTimes(1);
    expect(
      svc.syncLabels.mock.calls[0][0].dryRun,
      'this tool is the read half of the confirmation gate',
    ).toBe(true);
  });

  it('reports the full count even when the listing is truncated', async () => {
    svc.syncLabels.mockResolvedValue(plan({ planned: [1, 2, 3].map(change) }));

    const r = (await previewLabelSyncTool.execute!({ limit: 2 }, ctx)) as {
      issuesChanged: number;
      changes: unknown[];
      truncated: boolean;
    };

    expect(r.issuesChanged, 'the count is the plan size, not the page size').toBe(3);
    expect(r.changes).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });

  it('does not claim truncation when everything fit', async () => {
    svc.syncLabels.mockResolvedValue(plan({ planned: [change(1)] }));

    const r = (await previewLabelSyncTool.execute!({ limit: 25 }, ctx)) as { truncated: boolean };

    expect(r.truncated).toBe(false);
  });

  it('surfaces the labels the sync would create and delete', async () => {
    svc.syncLabels.mockResolvedValue(
      plan({ labelsCreated: ['priority:P0'], labelsDeleted: ['stale-label'] }),
    );

    const r = (await previewLabelSyncTool.execute!({ limit: 25 }, ctx)) as {
      labelsToCreate: string[];
      labelsToDelete: string[];
    };

    expect(r.labelsToCreate).toEqual(['priority:P0']);
    expect(r.labelsToDelete, 'a delete is the destructive half of the diff').toEqual([
      'stale-label',
    ]);
  });

  it('restricts the preview to one category when asked', async () => {
    svc.syncLabels.mockResolvedValue(plan());

    await previewLabelSyncTool.execute!({ limit: 25, category: 'security' }, ctx);

    expect(svc.syncLabels).toHaveBeenCalledWith(expect.objectContaining({ category: 'security' }));
  });

  it('reports a missing repo rather than calling the service', async () => {
    process.env.GITHUB_REPO = '';

    const r = (await previewLabelSyncTool.execute!({ limit: 25 }, ctx)) as { error?: string };

    expect(svc.syncLabels).not.toHaveBeenCalled();
    expect(r.error).toContain('GITHUB_REPO');
  });

  it('reports a partial plan as an error rather than an incomplete diff', async () => {
    svc.syncLabels.mockResolvedValue(
      plan({ planned: [change(1)], errors: ['rate limited on page 2'] }),
    );

    const r = (await previewLabelSyncTool.execute!({ limit: 25 }, ctx)) as {
      error?: string;
      issuesChanged: number;
    };

    expect(r.error).toContain('rate limited');
    expect(
      r.issuesChanged,
      'confirming against a half-built plan would write the wrong thing',
    ).toBe(0);
  });

  it('shapes a service rejection instead of throwing', async () => {
    svc.syncLabels.mockRejectedValue(new Error('bolt refused'));

    const r = (await previewLabelSyncTool.execute!({ limit: 25 }, ctx)) as { error?: string };

    expect(r.error).toBe('bolt refused');
  });
});
