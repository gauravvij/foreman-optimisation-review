import { beforeEach, describe, expect, it, vi } from 'vitest';

const svc = vi.hoisted(() => ({ syncFields: vi.fn(), listProjectBoards: vi.fn() }));

vi.mock('../../../src/services/github-project', () => ({
  FIELD_KEYS: ['priority', 'size', 'status'] as const,
  syncFields: svc.syncFields,
  listProjectBoards: svc.listProjectBoards,
}));

import {
  applyBoardSyncTool,
  countOverwrites,
  listProjectBoardsTool,
  previewBoardSyncTool,
} from '../sync-board-fields';

const ORDER = {
  priority: ['P0', 'P1', 'P2'],
  size: ['XS', 'S', 'M', 'L', 'XL'],
  status: ['Backlog', 'Ready', 'In progress', 'In review', 'Done'],
};
const ctx = {} as never;
const suspend = vi.fn();
const ctxWith = (resumeData?: { confirm: boolean }) =>
  ({ agent: { suspend, resumeData } }) as unknown as Parameters<
    NonNullable<typeof applyBoardSyncTool.execute>
  >[1];

const change = (
  n: number,
  field: 'priority' | 'size' | 'status',
  from: string | null,
  to: string | null,
  addToBoard = false,
) => ({
  issueNumber: n,
  field,
  fieldName: field === 'priority' ? 'Priority' : field === 'size' ? 'Size' : 'Status',
  from,
  to,
  addToBoard,
});

const plan = (over = {}) => ({
  planned: [],
  applied: 0,
  added: 0,
  cleared: 0,
  remaining: 0,
  unmapped: [],
  shippedButOpen: [],
  optionOrder: ORDER,
  projectNumber: 2,
  projectTitle: 'AI managed',
  fieldNames: ['Priority', 'Size', 'Status'],
  dryRun: true,
  errors: [],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GITHUB_OWNER = 'acme';
  process.env.GITHUB_REPO = 'widgets';
});

describe('countOverwrites', () => {
  it('counts only changes over a value the board already held', () => {
    const r = countOverwrites(
      [change(1, 'priority', null, 'P0'), change(2, 'priority', 'P1', 'P2')],
      ORDER,
    );

    expect(r.total, 'filling an empty field overwrites nothing').toBe(1);
  });

  it('ranks a downgrade by that field own option order, not by the option name', () => {
    // Board order is Urgent > Normal > Later; sorting the names inverts it.
    const order = { priority: ['Urgent', 'Normal', 'Later'], size: [], status: [] };

    const down = countOverwrites([change(1, 'priority', 'Urgent', 'Later')], order);
    const up = countOverwrites([change(1, 'priority', 'Later', 'Urgent')], order);

    expect(down.downgrades, 'Urgent -> Later drops urgency however the options are named').toBe(1);
    expect(up.downgrades, 'and the reverse is a promotion').toBe(0);
  });

  it('ranks each field against its own scale', () => {
    // S -> L is index 1 -> 3 in the size scale, a growth, not a priority drop.
    const r = countOverwrites([change(1, 'size', 'S', 'L')], ORDER);

    expect(r.downgrades, 'size uses the size options, not the priority ones').toBe(1);
  });

  it('does not count a clear as a downgrade', () => {
    const r = countOverwrites([change(1, 'priority', 'P1', null)], ORDER);

    expect(r).toEqual({ total: 1, downgrades: 0 });
  });
});

describe('previewBoardSyncTool', () => {
  it('never reaches a write path', async () => {
    svc.syncFields.mockResolvedValue(plan({ planned: [change(1, 'priority', null, 'P0')] }));

    await previewBoardSyncTool.execute!({ limit: 25 }, ctx);

    expect(svc.syncFields.mock.calls[0][0].dryRun).toBe(true);
  });

  it('passes the requested board and fields through', async () => {
    svc.syncFields.mockResolvedValue(plan());

    await previewBoardSyncTool.execute!({ limit: 25, projectNumber: 2, fields: ['size'] }, ctx);

    expect(svc.syncFields).toHaveBeenCalledWith(
      expect.objectContaining({ projectNumber: 2, fields: ['size'] }),
    );
  });

  it('counts issues separately from changes, since one issue can carry two', async () => {
    svc.syncFields.mockResolvedValue(
      plan({ planned: [change(1, 'priority', null, 'P0'), change(1, 'size', null, 'S')] }),
    );

    const r = (await previewBoardSyncTool.execute!({ limit: 25 }, ctx)) as {
      changesPlanned: number;
      issuesAffected: number;
    };

    expect(r.changesPlanned).toBe(2);
    expect(r.issuesAffected).toBe(1);
  });

  it('says how many changes replace a value someone already set', async () => {
    svc.syncFields.mockResolvedValue(
      plan({ planned: [change(1, 'priority', 'P0', 'P2'), change(2, 'size', null, 'S')] }),
    );

    const r = (await previewBoardSyncTool.execute!({ limit: 25 }, ctx)) as {
      overwrites: number;
      downgrades: number;
      message: string;
    };

    expect(r.overwrites).toBe(1);
    expect(r.downgrades).toBe(1);
    expect(r.message).toContain('replace a value already set');
  });

  it('names the board it planned against, so the target is never ambiguous', async () => {
    svc.syncFields.mockResolvedValue(plan({ planned: [change(1, 'priority', null, 'P0')] }));

    const r = (await previewBoardSyncTool.execute!({ limit: 25 }, ctx)) as { message: string };

    expect(r.message).toContain('#2');
    expect(r.message).toContain('AI managed');
  });

  it('warns per field when a value has no option', async () => {
    svc.syncFields.mockResolvedValue(
      plan({
        planned: [change(1, 'priority', 'P2', null)],
        unmapped: [{ field: 'Priority', values: ['P3'] }],
      }),
    );

    const r = (await previewBoardSyncTool.execute!({ limit: 25 }, ctx)) as { message: string };

    expect(r.message).toContain('Priority has no option for P3');
  });

  it('names issues whose work already merged, so they can be closed', async () => {
    svc.syncFields.mockResolvedValue(
      plan({ planned: [change(1, 'status', null, 'In review')], shippedButOpen: [1370, 1371] }),
    );

    const r = (await previewBoardSyncTool.execute!({ limit: 25 }, ctx)) as {
      shippedButOpen: number[];
      message: string;
    };

    expect(r.shippedButOpen).toEqual([1370, 1371]);
    expect(r.message, 'a finished issue left open is worth naming, not just filing').toContain(
      'may be finished',
    );
  });

  it('surfaces a skipped field rather than reporting a clean plan', async () => {
    svc.syncFields.mockResolvedValue(
      plan({
        planned: [change(1, 'priority', null, 'P0')],
        errors: ['skipped Size (field has no options defined)'],
      }),
    );

    const r = (await previewBoardSyncTool.execute!({ limit: 25 }, ctx)) as { message: string };

    expect(r.message).toContain('skipped Size');
  });

  it('reports the full count even when the listing is truncated', async () => {
    svc.syncFields.mockResolvedValue(
      plan({ planned: [1, 2, 3].map((n) => change(n, 'priority', null, 'P1')) }),
    );

    const r = (await previewBoardSyncTool.execute!({ limit: 2 }, ctx)) as {
      changesPlanned: number;
      changes: unknown[];
      truncated: boolean;
    };

    expect(r.changesPlanned).toBe(3);
    expect(r.changes).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });

  it('surfaces an ambiguous target as an error rather than a clean plan', async () => {
    svc.syncFields.mockRejectedValue(new Error('2 projects with a managed field'));

    const r = (await previewBoardSyncTool.execute!({ limit: 25 }, ctx)) as { error?: string };

    expect(r.error).toContain('2 projects');
  });

  it('reports a missing repo rather than calling the service', async () => {
    process.env.GITHUB_OWNER = '';

    const r = (await previewBoardSyncTool.execute!({ limit: 25 }, ctx)) as { error?: string };

    expect(svc.syncFields).not.toHaveBeenCalled();
    expect(r.error).toContain('GITHUB_OWNER');
  });
});

describe('applyBoardSyncTool', () => {
  it('suspends for confirmation and writes nothing on the first call', async () => {
    svc.syncFields.mockResolvedValue(plan({ planned: [change(1, 'priority', 'P0', 'P2')] }));

    const r = (await applyBoardSyncTool.execute!({}, ctxWith())) as { confirmed: boolean };

    expect(suspend).toHaveBeenCalledTimes(1);
    expect(svc.syncFields.mock.calls.every((c) => c[0].dryRun === true)).toBe(true);
    expect(r.confirmed).toBe(false);
  });

  it('puts the overwrite count in the confirmation, not just the diff', async () => {
    svc.syncFields.mockResolvedValue(
      plan({ planned: [change(1, 'priority', 'P0', 'P2'), change(2, 'size', null, 'S')] }),
    );

    await applyBoardSyncTool.execute!({}, ctxWith());

    const call = suspend.mock.calls[0][0];
    expect(
      call.message,
      'downgrading work someone prioritised is the consequential part',
    ).toContain('replace a value already set');
    expect(call.overwrites).toBe(1);
  });

  it('counts an added issue once even when it needs two fields set', async () => {
    svc.syncFields.mockResolvedValue(
      plan({
        planned: [change(7, 'priority', null, 'P0', true), change(7, 'size', null, 'S', true)],
      }),
    );

    await applyBoardSyncTool.execute!({}, ctxWith());

    const call = suspend.mock.calls[0][0];
    expect(call.issuesAdded, 'one card, two fields').toBe(1);
    expect(call.message).toContain('not on the board yet');
  });

  it('names the board in the confirmation', async () => {
    svc.syncFields.mockResolvedValue(plan({ planned: [change(1, 'priority', null, 'P0')] }));

    await applyBoardSyncTool.execute!({}, ctxWith());

    const call = suspend.mock.calls[0][0];
    expect(call.message).toContain('#2');
    expect(call.projectNumber).toBe(2);
  });

  it('says how long the write will take, since it then runs silently', async () => {
    svc.syncFields.mockResolvedValue(
      plan({ planned: [1, 2, 3].map((n) => change(n, 'status', null, 'Ready')) }),
    );

    await applyBoardSyncTool.execute!({}, ctxWith());

    expect(
      suspend.mock.calls[0][0].message,
      'confirming and then seeing nothing for minutes reads as a hang',
    ).toContain('about 3 seconds');
  });

  it('counts a card add as its own write when estimating', async () => {
    svc.syncFields.mockResolvedValue(plan({ planned: [change(7, 'status', null, 'Ready', true)] }));

    await applyBoardSyncTool.execute!({}, ctxWith());

    expect(suspend.mock.calls[0][0].message, 'one add plus one field set').toContain(
      'about 2 seconds',
    );
  });

  it('writes nothing when the user declines', async () => {
    svc.syncFields.mockResolvedValue(plan({ planned: [change(1, 'priority', null, 'P0')] }));

    const r = (await applyBoardSyncTool.execute!({}, ctxWith({ confirm: false }))) as {
      message: string;
    };

    expect(svc.syncFields.mock.calls.every((c) => c[0].dryRun === true)).toBe(true);
    expect(suspend, 'a decline must not re-prompt').not.toHaveBeenCalled();
    expect(r.message).toContain('Cancelled');
  });

  it('writes only after an explicit confirm', async () => {
    svc.syncFields.mockResolvedValue(
      plan({ planned: [change(1, 'priority', null, 'P0')], applied: 1, dryRun: false }),
    );

    const r = (await applyBoardSyncTool.execute!(
      { projectNumber: 2, fields: ['priority'] },
      ctxWith({ confirm: true }),
    )) as { applied: number; confirmed: boolean };

    expect(svc.syncFields).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: false, projectNumber: 2, fields: ['priority'] }),
    );
    expect(r.applied).toBe(1);
    expect(r.confirmed).toBe(true);
  });

  it('reports a field that failed to write rather than a clean apply', async () => {
    svc.syncFields.mockResolvedValue(
      plan({
        planned: [change(57, 'priority', null, 'P2'), change(57, 'size', null, 'L')],
        applied: 1,
        dryRun: false,
        errors: ['#57 Size: no Size option named L'],
      }),
    );

    const r = (await applyBoardSyncTool.execute!({}, ctxWith({ confirm: true }))) as {
      message: string;
      errors: string[];
    };

    expect(r.message, 'the apply message names the field that failed').toContain('#57 Size');
    expect(r.errors, 'the failure is still returned structurally').toHaveLength(1);
  });

  it('reports an effort the board has no size option for', async () => {
    svc.syncFields.mockResolvedValue(
      plan({
        planned: [change(57, 'priority', null, 'P2')],
        applied: 1,
        dryRun: false,
        unmapped: [{ field: 'Size', values: ['L'] }],
      }),
    );

    const r = (await applyBoardSyncTool.execute!({}, ctxWith({ confirm: true }))) as {
      message: string;
    };

    expect(r.message, 'the apply message says the size was left unset').toContain(
      'Size has no option for L',
    );
  });

  it('carries the shipped-but-open note into the applied result, not just the preview', async () => {
    svc.syncFields.mockResolvedValue(
      plan({
        planned: [change(1, 'status', null, 'In review')],
        applied: 1,
        dryRun: false,
        shippedButOpen: [57],
      }),
    );

    const r = (await applyBoardSyncTool.execute!({}, ctxWith({ confirm: true }))) as {
      message: string;
    };

    expect(r.message, 'the apply path must report what the preview reported').toContain(
      'may be finished',
    );
  });

  it('does not prompt when the board already matches', async () => {
    svc.syncFields.mockResolvedValue(plan());

    const r = (await applyBoardSyncTool.execute!({}, ctxWith())) as { message: string };

    expect(suspend).not.toHaveBeenCalled();
    expect(r.message).toContain('already matches');
  });

  it('reports a planning failure instead of prompting to confirm one', async () => {
    svc.syncFields.mockRejectedValue(new Error('no usable managed field'));

    const r = (await applyBoardSyncTool.execute!({}, ctxWith())) as {
      errors: string[];
      message: string;
    };

    expect(suspend).not.toHaveBeenCalled();
    expect(r.errors[0]).toContain('no usable managed field');
    expect(r.message).toContain('nothing was written');
  });

  it('reports a missing repo rather than calling the service', async () => {
    process.env.GITHUB_REPO = '';

    const r = (await applyBoardSyncTool.execute!({}, ctxWith())) as { errors: string[] };

    expect(svc.syncFields).not.toHaveBeenCalled();
    expect(r.errors[0]).toContain('GITHUB_REPO');
  });
});

describe('listProjectBoardsTool', () => {
  it('reports which boards carry a usable managed field', async () => {
    svc.listProjectBoards.mockResolvedValue([
      {
        number: 1,
        title: 'Human',
        items: 141,
        fields: [
          { name: 'Priority', options: ['P0', 'P1', 'P2'] },
          { name: 'Size', options: ['S', 'M', 'L'] },
        ],
      },
      { number: 2, title: 'AI managed', items: 0, fields: [{ name: 'Priority', options: [] }] },
    ]);

    const r = (await listProjectBoardsTool.execute!({}, ctx)) as {
      boards: unknown[];
      message: string;
    };

    expect(r.boards).toHaveLength(2);
    expect(r.message).toContain('1 carry a usable managed field');
  });

  it('says so when the repo has no boards', async () => {
    svc.listProjectBoards.mockResolvedValue([]);

    const r = (await listProjectBoardsTool.execute!({}, ctx)) as { message: string };

    expect(r.message).toContain('No project boards');
  });

  it('shapes a service failure instead of throwing', async () => {
    svc.listProjectBoards.mockRejectedValue(new Error('bad credentials'));

    const r = (await listProjectBoardsTool.execute!({}, ctx)) as { error?: string };

    expect(r.error).toBe('bad credentials');
  });
});
