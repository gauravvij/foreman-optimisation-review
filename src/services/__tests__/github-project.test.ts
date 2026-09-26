import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardItem, ClassifiedIssue, FieldKey, ResolvedField } from '../github-project';
import {
  deriveStatus,
  managedFields,
  planFieldChanges,
  resolveBoard,
  setBoardColumn,
} from '../github-project';

const field = (key: FieldKey, name: string, options: string[]): ResolvedField => ({
  key,
  name,
  fieldId: `f-${key}`,
  options: new Map(options.map((o) => [o, `opt-${o}`])),
});

const PRIORITY = field('priority', 'Priority', ['P0', 'P1', 'P2']);
const SIZE = field('size', 'Size', ['XS', 'S', 'M', 'L', 'XL']);

const item = (values: Record<string, string> = {}): BoardItem => ({
  itemId: 'item-1',
  values: new Map(Object.entries(values)),
});

/** score 85 -> P0, 65 -> P1, 45 -> P2, 10 -> P3 (which the board has no option for). */
const issue = (
  number: number,
  priorityScore: number,
  effort: string | null,
  over: Partial<ClassifiedIssue> = {},
): ClassifiedIssue => ({
  number,
  state: 'OPEN',
  priorityScore,
  effort,
  needsClarification: false,
  ...over,
});

beforeEach(() => {
  process.env.PROJECT_PRIORITY_FIELD = '';
  process.env.PROJECT_SIZE_FIELD = '';
  process.env.PROJECT_SIZE_MAP = '';
  process.env.PROJECT_STATUS_FIELD = '';
  process.env.PROJECT_STATUS_MAP = '';
  process.env.PROJECT_HOLD_COLUMNS = '';
  process.env.PROJECT_NUMBER = '';
  process.env.GITHUB_TOKEN = 'test-token';
});

describe('managedFields', () => {
  it('derives a priority band from the score', () => {
    const priority = managedFields().find((f) => f.key === 'priority');

    expect(priority?.valueFor(issue(1, 85, null))).toBe('P0');
    expect(priority?.valueFor(issue(1, 10, null))).toBe('P3');
  });

  it('maps the three analyzer efforts onto sizes', () => {
    const size = managedFields().find((f) => f.key === 'size');

    expect(size?.valueFor(issue(1, 50, 'small'))).toBe('S');
    expect(size?.valueFor(issue(1, 50, 'medium'))).toBe('M');
    expect(size?.valueFor(issue(1, 50, 'large'))).toBe('L');
  });

  it('sizes an issue whose stored effort differs only in case or padding', () => {
    const size = managedFields().find((f) => f.key === 'size');

    expect(size?.valueFor(issue(1, 50, 'Large')), 'capitalised effort maps to L').toBe('L');
    expect(size?.valueFor(issue(1, 50, 'MEDIUM')), 'upper-case effort maps to M').toBe('M');
    expect(size?.valueFor(issue(1, 50, ' small ')), 'padded effort maps to S').toBe('S');
  });

  it('has no size for an issue the analyzer never sized', () => {
    const size = managedFields().find((f) => f.key === 'size');

    expect(size?.valueFor(issue(1, 50, null))).toBeNull();
    expect(size?.valueFor(issue(1, 50, 'enormous'))).toBeNull();
  });

  it('honours a custom effort-to-size map', () => {
    process.env.PROJECT_SIZE_MAP = 'small=XS, medium=S, large=XL';
    const size = managedFields().find((f) => f.key === 'size');

    expect(size?.valueFor(issue(1, 50, 'small'))).toBe('XS');
    expect(size?.valueFor(issue(1, 50, 'large'))).toBe('XL');
  });

  it('falls back to the default map when the override is unparseable', () => {
    process.env.PROJECT_SIZE_MAP = 'nonsense';
    const size = managedFields().find((f) => f.key === 'size');

    expect(size?.valueFor(issue(1, 50, 'small'))).toBe('S');
  });

  it('honours custom field names', () => {
    process.env.PROJECT_PRIORITY_FIELD = 'Urgency';
    process.env.PROJECT_SIZE_FIELD = 'Effort';

    expect(managedFields().map((f) => f.name)).toEqual(['Urgency', 'Effort', 'Status']);
  });
});

const COLUMNS_FIELD = field('status', 'Status', [
  'Backlog',
  'Ready',
  'In progress',
  'In review',
  'Done',
]);

const STATUS = {
  backlog: 'Backlog',
  ready: 'Ready',
  progress: 'In progress',
  review: 'In review',
  done: 'Done',
};

describe('deriveStatus', () => {
  it('sends a closed issue to Done whatever else is true of it', () => {
    const closed = issue(1, 85, 'small', { state: 'CLOSED', assigned: true, hasOpenReadyPR: true });

    expect(deriveStatus(closed, STATUS)).toBe('Done');
  });

  it('ranks a ready pull request above an assignee', () => {
    const both = issue(1, 45, 'small', { assigned: true, hasOpenReadyPR: true });

    expect(deriveStatus(both, STATUS), 'a PR offered for review outranks an assignee').toBe(
      'In review',
    );
  });

  it('treats a draft pull request as work started, not work up for review', () => {
    const draft = issue(1, 45, 'small', { hasDraftPR: true });

    expect(deriveStatus(draft, STATUS)).toBe('In progress');
  });

  it('sends an open issue whose pull request already merged to In review', () => {
    const shipped = issue(1, 45, 'small', { hasMergedPR: true });

    expect(deriveStatus(shipped, STATUS), 'the work landed, the issue just is not closed').toBe(
      'In review',
    );
  });

  it('ranks a merged pull request above a draft on the same issue', () => {
    const both = issue(1, 45, 'small', { hasDraftPR: true, hasMergedPR: true });

    expect(deriveStatus(both, STATUS)).toBe('In review');
  });

  it('treats an assignee as work started', () => {
    expect(deriveStatus(issue(1, 45, 'small', { assigned: true }), STATUS)).toBe('In progress');
  });

  it('promotes an untouched high-priority issue to Ready', () => {
    expect(deriveStatus(issue(1, 85, 'small'), STATUS)).toBe('Ready');
    expect(deriveStatus(issue(2, 65, 'small'), STATUS)).toBe('Ready');
  });

  it('leaves a lower-priority issue in Backlog', () => {
    expect(deriveStatus(issue(1, 45, 'small'), STATUS)).toBe('Backlog');
    expect(deriveStatus(issue(2, 10, 'small'), STATUS)).toBe('Backlog');
  });

  it('holds a high-priority issue back when it cannot be acted on as written', () => {
    const unclear = issue(1, 85, 'small', { needsClarification: true });

    expect(deriveStatus(unclear, STATUS), 'Ready must mean someone could pick it up').toBe(
      'Backlog',
    );
  });

  it('still advances an unclear issue that someone is already working on', () => {
    const unclear = issue(1, 85, 'small', { needsClarification: true, assigned: true });

    expect(deriveStatus(unclear, STATUS)).toBe('In progress');
  });

  it('uses the column names it is given', () => {
    const renamed = { ...STATUS, ready: 'Up next' };

    expect(deriveStatus(issue(1, 85, 'small'), renamed)).toBe('Up next');
  });
});

describe('planFieldChanges: status is forward-only', () => {
  it('fills an empty column from the derived status', () => {
    const { planned } = planFieldChanges([issue(1, 85, 'small')], new Map([[1, item()]]), [
      COLUMNS_FIELD,
    ]);

    expect(planned[0]).toMatchObject({ field: 'status', from: null, to: 'Ready' });
  });

  it('advances a card when the evidence moved it later', () => {
    const withPR = issue(1, 85, 'small', { hasOpenReadyPR: true });
    const { planned } = planFieldChanges(
      [withPR],
      new Map([[1, item({ Status: 'In progress' })]]),
      [COLUMNS_FIELD],
    );

    expect(planned[0]).toMatchObject({ from: 'In progress', to: 'In review' });
  });

  it('never pulls a card back to an earlier column', () => {
    const quiet = issue(1, 45, 'small');
    const { planned } = planFieldChanges([quiet], new Map([[1, item({ Status: 'In progress' })]]), [
      COLUMNS_FIELD,
    ]);

    expect(planned, 'a column someone dragged a card into is a coordination signal').toEqual([]);
  });

  it('does not fight a human who moved a card ahead of the evidence', () => {
    const ready = issue(1, 85, 'small');
    const { planned } = planFieldChanges([ready], new Map([[1, item({ Status: 'In review' })]]), [
      COLUMNS_FIELD,
    ]);

    expect(planned).toEqual([]);
  });

  it('moves a closed card to Done', () => {
    const closed = issue(1, 85, 'small', { state: 'CLOSED' });
    const { planned } = planFieldChanges([closed], new Map([[1, item({ Status: 'In review' })]]), [
      COLUMNS_FIELD,
    ]);

    expect(planned[0]).toMatchObject({ from: 'In review', to: 'Done' });
  });

  it('never clears the column, since clearing is the furthest move backwards', () => {
    const narrow = field('status', 'Status', ['Backlog']);
    const withPR = issue(1, 85, 'small', { hasOpenReadyPR: true });
    const { planned } = planFieldChanges([withPR], new Map([[1, item({ Status: 'Backlog' })]]), [
      narrow,
    ]);

    expect(planned, 'In review has no option, but Backlog must survive').toEqual([]);
  });

  it('leaves a card a person parked on hold, even placed before Backlog', () => {
    const board = field('status', 'Status', [
      'On hold',
      'Backlog',
      'Ready',
      'In progress',
      'In review',
      'Done',
    ]);
    const ready = issue(1, 85, 'small');

    const { planned } = planFieldChanges([ready], new Map([[1, item({ Status: 'On hold' })]]), [
      board,
    ]);

    expect(planned, 'a hold is a decision to pause, not a column to promote out of').toEqual([]);
  });

  it('still moves a parked card to Done once its issue closes', () => {
    const board = field('status', 'Status', ['On hold', 'Backlog', 'Ready', 'Done']);
    const closed = issue(1, 85, 'small', { state: 'CLOSED' });

    const { planned } = planFieldChanges([closed], new Map([[1, item({ Status: 'On hold' })]]), [
      board,
    ]);

    expect(planned[0], 'a hold on finished work is stale, not a decision').toMatchObject({
      from: 'On hold',
      to: 'Done',
    });
  });

  it('never derives a hold column, so only a person puts a card there', () => {
    const board = field('status', 'Status', ['On hold', 'Backlog', 'Ready', 'Done']);
    const issues = [
      issue(1, 85, 'small'),
      issue(2, 10, 'small'),
      issue(3, 85, 'small', { needsClarification: true }),
      issue(4, 85, 'small', { assigned: true }),
      issue(5, 85, 'small', { state: 'CLOSED' }),
    ];

    const { planned } = planFieldChanges(issues, new Map(), [board]);

    expect(planned.map((c) => c.to)).not.toContain('On hold');
  });

  it('honours a custom hold column name', () => {
    process.env.PROJECT_HOLD_COLUMNS = 'Blocked, Parked';
    const board = field('status', 'Status', ['Blocked', 'Backlog', 'Ready', 'Done']);
    const ready = issue(1, 85, 'small');

    const { planned } = planFieldChanges([ready], new Map([[1, item({ Status: 'Blocked' })]]), [
      board,
    ]);

    expect(planned).toEqual([]);
  });

  it('leaves a board without a hold column exactly as it was', () => {
    const ready = issue(1, 85, 'small');

    const { planned } = planFieldChanges([ready], new Map([[1, item({ Status: 'Backlog' })]]), [
      COLUMNS_FIELD,
    ]);

    expect(planned[0], 'the default hold name matches no column here').toMatchObject({
      from: 'Backlog',
      to: 'Ready',
    });
  });

  it('is a no-op on a repeat run once the column already matches', () => {
    const ready = issue(1, 85, 'small');
    const board = new Map([[1, item({ Status: 'Ready' })]]);

    expect(planFieldChanges([ready], board, [COLUMNS_FIELD]).planned).toEqual([]);
  });
});

describe('planFieldChanges: closed issues', () => {
  it('leaves the priority and size of a closed card alone', () => {
    const closed = issue(1, 85, 'large', { state: 'CLOSED' });
    const { planned } = planFieldChanges(
      [closed],
      new Map([[1, item({ Priority: 'P2', Size: 'S' })]]),
      [PRIORITY, SIZE],
    );

    expect(planned, 're-triaging finished work is noise').toEqual([]);
  });

  it('does not put a closed issue on the board it is absent from', () => {
    const closed = issue(9, 85, 'small', { state: 'CLOSED' });
    const { planned } = planFieldChanges([closed], new Map(), [PRIORITY, SIZE, COLUMNS_FIELD]);

    expect(planned).toEqual([]);
  });
});

describe('planFieldChanges', () => {
  it('sets both fields on a board item that has neither', () => {
    const { planned } = planFieldChanges([issue(1, 85, 'small')], new Map([[1, item()]]), [
      PRIORITY,
      SIZE,
    ]);

    expect(planned).toEqual([
      {
        issueNumber: 1,
        field: 'priority',
        fieldName: 'Priority',
        from: null,
        to: 'P0',
        addToBoard: false,
      },
      { issueNumber: 1, field: 'size', fieldName: 'Size', from: null, to: 'S', addToBoard: false },
    ]);
  });

  it('leaves a field alone when the board already shows the right value', () => {
    const { planned } = planFieldChanges(
      [issue(1, 85, 'small')],
      new Map([[1, item({ Priority: 'P0', Size: 'S' })]]),
      [PRIORITY, SIZE],
    );

    expect(planned).toEqual([]);
  });

  it('changes only the field that disagrees', () => {
    const { planned } = planFieldChanges(
      [issue(1, 85, 'large')],
      new Map([[1, item({ Priority: 'P0', Size: 'S' })]]),
      [PRIORITY, SIZE],
    );

    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({ field: 'size', from: 'S', to: 'L' });
  });

  it('syncs only the fields it was given', () => {
    const { planned } = planFieldChanges([issue(1, 85, 'small')], new Map([[1, item()]]), [
      PRIORITY,
    ]);

    expect(planned.map((c) => c.field)).toEqual(['priority']);
  });

  it('adds an off-board issue once, flagged on every change it needs', () => {
    const { planned } = planFieldChanges([issue(7, 85, 'small')], new Map(), [PRIORITY, SIZE]);

    expect(planned).toHaveLength(2);
    expect(planned.every((c) => c.addToBoard)).toBe(true);
  });

  it('clears a field the board has no option for', () => {
    const { planned } = planFieldChanges(
      [issue(1, 10, 'small')],
      new Map([[1, item({ Priority: 'P2', Size: 'S' })]]),
      [PRIORITY, SIZE],
    );

    expect(planned, 'a stale P2 is worse than an empty field').toEqual([
      {
        issueNumber: 1,
        field: 'priority',
        fieldName: 'Priority',
        from: 'P2',
        to: null,
        addToBoard: false,
      },
    ]);
  });

  it('does not add a card to the board when every field would be empty', () => {
    const { planned } = planFieldChanges([issue(9, 10, null)], new Map(), [PRIORITY, SIZE]);

    expect(planned).toEqual([]);
  });

  it('does add a card when at least one field would be set', () => {
    const { planned } = planFieldChanges([issue(9, 10, 'small')], new Map(), [PRIORITY, SIZE]);

    expect(
      planned.map((c) => c.field),
      'priority is unmapped, size is not',
    ).toEqual(['size']);
    expect(planned[0].addToBoard).toBe(true);
  });

  it('names each unmapped value once, grouped by field', () => {
    process.env.PROJECT_SIZE_MAP = 'small=XXS';
    const { unmapped } = planFieldChanges(
      [issue(1, 10, 'small'), issue(2, 10, 'small')],
      new Map([
        [1, item()],
        [2, item()],
      ]),
      [PRIORITY, SIZE],
    );

    expect(unmapped).toEqual([
      { field: 'Priority', values: ['P3'] },
      { field: 'Size', values: ['XXS'] },
    ]);
  });

  it('reports nothing unmapped when every value has an option', () => {
    const { unmapped } = planFieldChanges([issue(1, 85, 'small')], new Map([[1, item()]]), [
      PRIORITY,
      SIZE,
    ]);

    expect(unmapped).toEqual([]);
  });
});

describe('resolveBoard', () => {
  const P012 = [
    { id: 'o0', name: 'P0' },
    { id: 'o1', name: 'P1' },
    { id: 'o2', name: 'P2' },
  ];
  const SIZES = ['XS', 'S', 'M', 'L', 'XL'].map((n) => ({ id: `s-${n}`, name: n }));
  const COLUMNS = ['Backlog', 'Ready', 'In progress', 'In review', 'Done'].map((n) => ({
    id: `c-${n}`,
    name: n,
  }));

  const project = (
    number: number,
    title: string,
    fields: { id: string; name: string; options: { id: string; name: string }[] }[],
  ) => ({ id: `PVT_${number}`, number, title, fields: { nodes: fields } });

  const full = (n: number, title: string) =>
    project(n, title, [
      { id: `f-p-${n}`, name: 'Priority', options: P012 },
      { id: `f-s-${n}`, name: 'Size', options: SIZES },
      { id: `f-c-${n}`, name: 'Status', options: COLUMNS },
    ]);

  function mockProjects(nodes: unknown[]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: { repository: { projectsV2: { nodes } } } })),
      ),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves every managed field off the only board that carries them', async () => {
    mockProjects([full(1, 'Kanban')]);

    const { board, skipped } = await resolveBoard('acme', 'widgets');

    expect(board.fields.map((f) => f.key)).toEqual(['priority', 'size', 'status']);
    expect(skipped).toEqual([]);
  });

  it('refuses to choose when two boards carry a managed field', async () => {
    mockProjects([full(1, 'Human'), full(2, 'AI managed')]);

    await expect(resolveBoard('acme', 'widgets')).rejects.toThrow(
      /2 projects with a managed field/,
    );
  });

  it('names both candidates so the caller can pick one', async () => {
    mockProjects([full(1, 'Human'), full(2, 'AI managed')]);

    await expect(resolveBoard('acme', 'widgets')).rejects.toThrow(/AI managed/);
  });

  it('uses the requested board when the repo has several', async () => {
    mockProjects([full(1, 'Human'), full(2, 'AI managed')]);

    const { board } = await resolveBoard('acme', 'widgets', 2);

    expect(board.projectNumber).toBe(2);
    expect(board.projectTitle).toBe('AI managed');
  });

  it('prefers an explicit number over PROJECT_NUMBER', async () => {
    process.env.PROJECT_NUMBER = '1';
    mockProjects([full(1, 'Human'), full(2, 'AI managed')]);

    const { board } = await resolveBoard('acme', 'widgets', 2);

    expect(board.projectNumber).toBe(2);
  });

  it('falls back to PROJECT_NUMBER when no number is passed', async () => {
    process.env.PROJECT_NUMBER = '2';
    mockProjects([full(1, 'Human'), full(2, 'AI managed')]);

    const { board } = await resolveBoard('acme', 'widgets');

    expect(board.projectNumber).toBe(2);
  });

  it('rejects a board number the repository does not have', async () => {
    mockProjects([full(1, 'Human')]);

    await expect(resolveBoard('acme', 'widgets', 99)).rejects.toThrow('no project #99');
  });

  it('keeps the usable field and notes the one with no options', async () => {
    mockProjects([
      project(2, 'AI managed', [
        { id: 'f-p', name: 'Priority', options: P012 },
        { id: 'f-s', name: 'Size', options: [] },
      ]),
    ]);

    const { board, skipped } = await resolveBoard('acme', 'widgets', 2);

    expect(
      board.fields.map((f) => f.key),
      'one broken field must not sink the sync',
    ).toEqual(['priority']);
    expect(skipped.join(' ')).toContain('Size (field has no options defined)');
  });

  it('notes each field the board does not define at all', async () => {
    mockProjects([project(1, 'Kanban', [{ id: 'f-p', name: 'Priority', options: P012 }])]);

    const { board, skipped } = await resolveBoard('acme', 'widgets');

    expect(
      board.fields.map((f) => f.key),
      'the one usable field still resolves',
    ).toEqual(['priority']);
    expect(skipped.join(' ')).toContain('Size (no such field on the board)');
    expect(skipped.join(' ')).toContain('Status (no such field on the board)');
  });

  it('refuses when no managed field on the board is usable', async () => {
    mockProjects([
      project(2, 'AI managed', [
        { id: 'f-p', name: 'Priority', options: [] },
        { id: 'f-s', name: 'Size', options: [] },
      ]),
    ]);

    await expect(resolveBoard('acme', 'widgets', 2)).rejects.toThrow(/no usable managed field/);
  });

  it('restricts resolution to the requested field', async () => {
    mockProjects([full(1, 'Kanban')]);

    const { board } = await resolveBoard('acme', 'widgets', undefined, ['size']);

    expect(board.fields.map((f) => f.key)).toEqual(['size']);
  });

  it('reports when no board carries any managed field', async () => {
    mockProjects([project(1, 'Kanban', [{ id: 'x', name: 'Team', options: P012 }])]);

    await expect(resolveBoard('acme', 'widgets')).rejects.toThrow(/no single-select field named/);
  });

  it('reports when the repository has no projects', async () => {
    mockProjects([]);

    await expect(resolveBoard('acme', 'widgets')).rejects.toThrow('no GitHub project is linked');
  });
});

describe('setBoardColumn', () => {
  const COLUMNS_WITH_HOLD = ['On hold', 'Backlog', 'Ready', 'Done'].map((n) => ({
    id: `c-${n}`,
    name: n,
  }));

  const board = {
    id: 'PVT_4',
    number: 4,
    title: 'Astro Kanban (AI)',
    fields: {
      nodes: [{ id: 'f-status', name: 'Status', options: COLUMNS_WITH_HOLD }],
    },
  };

  /** Routes each GraphQL call by what it asks for, so one mock serves the chain. */
  function mockGitHub(opts: {
    items: { id: string; number: number; status?: string }[];
    nodeIds?: Record<number, string>;
  }) {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        const query = String(JSON.parse(init.body).query);
        calls.push(query);

        if (query.includes('projectsV2')) {
          return new Response(
            JSON.stringify({ data: { repository: { projectsV2: { nodes: [board] } } } }),
          );
        }
        if (query.includes('items(first')) {
          return new Response(
            JSON.stringify({
              data: {
                node: {
                  items: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: opts.items.map((i) => ({
                      id: i.id,
                      content: { number: i.number },
                      fieldValues: {
                        nodes: i.status ? [{ name: i.status, field: { name: 'Status' } }] : [],
                      },
                    })),
                  },
                },
              },
            }),
          );
        }
        if (query.includes('issue(number:')) {
          const repository = Object.fromEntries(
            Object.entries(opts.nodeIds ?? {}).map(([n, id]) => [`i${n}`, { id, number: +n }]),
          );
          return new Response(JSON.stringify({ data: { repository } }));
        }
        if (query.includes('addProjectV2ItemById')) {
          return new Response(
            JSON.stringify({ data: { addProjectV2ItemById: { item: { id: 'new-item' } } } }),
          );
        }
        return new Response(
          JSON.stringify({
            data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'x' } } },
          }),
        );
      }),
    );
    return calls;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('plans a move to a column the derived sync would never choose', async () => {
    mockGitHub({ items: [{ id: 'item-2689', number: 2689, status: 'Ready' }] });

    const result = await setBoardColumn({
      owner: 'astropods',
      repo: 'astro',
      issueNumbers: [2689],
      column: 'On hold',
      projectNumber: 4,
      dryRun: true,
    });

    expect(result.moved).toEqual([{ issueNumber: 2689, from: 'Ready' }]);
    expect(result.errors).toEqual([]);
  });

  it('names the columns the board has when asked for one it does not', async () => {
    mockGitHub({ items: [{ id: 'item-1', number: 1, status: 'Ready' }] });

    const result = await setBoardColumn({
      owner: 'astropods',
      repo: 'astro',
      issueNumbers: [1],
      column: 'Paused',
      projectNumber: 4,
      dryRun: true,
    });

    expect(result.moved).toEqual([]);
    expect(result.errors[0]).toContain('no Status option named Paused');
    expect(
      result.options,
      'a wrong name is the likely mistake, so the reply lists the real ones',
    ).toEqual(['On hold', 'Backlog', 'Ready', 'Done']);
  });

  it('writes nothing for a card already in the column', async () => {
    const calls = mockGitHub({ items: [{ id: 'item-1', number: 1, status: 'On hold' }] });

    const result = await setBoardColumn({
      owner: 'astropods',
      repo: 'astro',
      issueNumbers: [1],
      column: 'On hold',
      projectNumber: 4,
    });

    expect(result.unchanged).toEqual([1]);
    expect(result.moved).toEqual([]);
    expect(calls.some((q) => q.includes('updateProjectV2ItemFieldValue'))).toBe(false);
  });

  it('sets the column and touches no other field', async () => {
    const calls = mockGitHub({ items: [{ id: 'item-2689', number: 2689, status: 'Ready' }] });

    const result = await setBoardColumn({
      owner: 'astropods',
      repo: 'astro',
      issueNumbers: [2689],
      column: 'On hold',
      projectNumber: 4,
    });

    expect(result.moved).toEqual([{ issueNumber: 2689, from: 'Ready' }]);
    const writes = calls.filter((q) => q.includes('updateProjectV2ItemFieldValue'));
    expect(writes, 'one write, for the status field alone').toHaveLength(1);
  });

  it('adds an issue that is not on the board yet', async () => {
    mockGitHub({ items: [], nodeIds: { 77: 'I_77' } });

    const result = await setBoardColumn({
      owner: 'astropods',
      repo: 'astro',
      issueNumbers: [77],
      column: 'On hold',
      projectNumber: 4,
    });

    expect(result.addedToBoard).toEqual([77]);
    expect(result.moved).toEqual([{ issueNumber: 77, from: null }]);
  });
});
