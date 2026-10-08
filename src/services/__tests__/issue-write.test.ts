import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDriver, inOrder } from './fake-driver';

const fake = vi.hoisted(() => ({
  ref: null as ReturnType<typeof import('./fake-driver').createFakeDriver> | null,
}));

vi.mock('../neo4j', () => ({ getDriver: () => fake.ref?.mockDriver }));

import {
  applyIssueUpdate,
  commentAttribution,
  createIssue,
  findLikelyDuplicates,
} from '../issue-write';

let db: ReturnType<typeof createFakeDriver>;
/** Every GraphQL body the service sent, in order. */
let sent: { query: string; variables: Record<string, unknown> }[];

const OPEN_ISSUE = {
  id: 'I_1',
  number: 798,
  title: 'Original title',
  state: 'OPEN',
  viewerCanUpdate: true,
  assignees: { nodes: [] as { id: string; login: string }[] },
};

function mockGitHub(
  snapshot: Record<string, unknown> | null,
  overrides: Record<string, unknown> = {},
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      sent.push({ query: body.query, variables: body.variables });

      if (body.query.includes('viewerCanUpdate')) {
        return new Response(JSON.stringify({ data: { repository: { issue: snapshot } } }));
      }
      if (body.query.includes('closeIssue')) {
        return new Response(
          JSON.stringify({ data: { closeIssue: { issue: { state: 'CLOSED' } } } }),
        );
      }
      if (body.query.includes('reopenIssue')) {
        return new Response(
          JSON.stringify({ data: { reopenIssue: { issue: { state: 'OPEN' } } } }),
        );
      }
      if (body.query.includes('updateIssue')) {
        return new Response(JSON.stringify({ data: { updateIssue: { issue: { title: 'x' } } } }));
      }
      if (body.query.includes('user(login:')) {
        const login = (body.variables as { login: string }).login;
        const users = (overrides.users as Record<string, string> | undefined) ?? {};
        const id = users[login];
        return new Response(JSON.stringify({ data: { user: id ? { id, login } : null } }));
      }
      if (body.query.includes('addAssigneesToAssignable')) {
        return new Response(
          JSON.stringify({ data: { addAssigneesToAssignable: { clientMutationId: null } } }),
        );
      }
      if (body.query.includes('removeAssigneesFromAssignable')) {
        return new Response(
          JSON.stringify({ data: { removeAssigneesFromAssignable: { clientMutationId: null } } }),
        );
      }
      if (body.query.includes('viewerPermission')) {
        return new Response(
          JSON.stringify({
            data: { repository: { id: 'R_1', viewerPermission: overrides.permission ?? 'WRITE' } },
          }),
        );
      }
      if (body.query.includes('labels(first:100')) {
        return new Response(
          JSON.stringify({
            data: {
              repository: {
                labels: {
                  nodes: (overrides.labels as { id: string; name: string }[] | undefined) ?? [],
                },
              },
            },
          }),
        );
      }
      if (body.query.includes('createIssue')) {
        return new Response(
          JSON.stringify({
            data: {
              createIssue: {
                issue: {
                  number: 4242,
                  url: 'https://github.com/acme/widgets/issues/4242',
                  title: (body.variables as { title: string }).title,
                },
              },
            },
          }),
        );
      }
      return new Response(JSON.stringify({ data: { addComment: {} }, ...overrides }));
    }),
  );
}

const sentQueries = () => sent.map((s) => s.query).join('\n---\n');

beforeEach(() => {
  db = createFakeDriver();
  fake.ref = db;
  sent = [];
  process.env.GITHUB_TOKEN = 'test-token';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('applyIssueUpdate', () => {
  it('appends the attribution to every comment it posts', async () => {
    mockGitHub(OPEN_ISSUE);
    db.queueEmpty();

    await applyIssueUpdate({
      owner: 'o',
      repo: 'r',
      number: 1,
      comment: 'The plan is in the description.',
    });

    const posted = sent.find((s) => s.query.includes('addComment'));
    expect(posted, 'the comment must actually be posted').toBeDefined();
    const body = (posted?.variables as { body: string }).body;
    expect(body, 'the human text survives').toContain('The plan is in the description.');
    expect(body, 'a reader must be told an AI wrote it').toContain('(AI)');
    expect(body, 'the marker is what a later run greps for').toContain('astro-agent: foreman');
  });

  it('leaves the state alone when no action is given and only the title changes', async () => {
    mockGitHub(OPEN_ISSUE);
    db.queueResult([{ n: 798 }]);

    const r = await applyIssueUpdate({
      owner: 'acme',
      repo: 'widgets',
      number: 798,
      title: 'New title',
    });

    expect(sentQueries(), 'a retitle must not close or reopen anything').not.toContain(
      'closeIssue',
    );
    expect(sentQueries()).not.toContain('reopenIssue');
    expect(sentQueries()).toContain('updateIssue');
    expect(r.titleChanged).toBe(true);
    expect(r.previousState).toBe('OPEN');
    expect(r.newState).toBe('OPEN');
  });

  it('treats a title identical to the current one as no change', async () => {
    mockGitHub(OPEN_ISSUE);
    db.queueResult([{ n: 798 }]);

    const r = await applyIssueUpdate({
      owner: 'acme',
      repo: 'widgets',
      number: 798,
      title: '  Original title  ',
    });

    expect(r.titleChanged, 'whitespace alone is not an edit').toBe(false);
    expect(sentQueries()).not.toContain('updateIssue');
  });

  it('posts the comment before the state change, so the reason reads above it', async () => {
    mockGitHub(OPEN_ISSUE);
    db.queueResult([{ n: 798 }]);

    await applyIssueUpdate({
      owner: 'acme',
      repo: 'widgets',
      number: 798,
      action: 'close',
      comment: 'Shipped.',
    });

    expect(
      inOrder(sentQueries(), 'addComment', 'closeIssue'),
      'the reason must land above the close event, and both must happen',
    ).toBe(true);
  });

  it('refuses before any mutation when the token cannot modify the issue', async () => {
    mockGitHub({ ...OPEN_ISSUE, viewerCanUpdate: false });

    await expect(
      applyIssueUpdate({ owner: 'acme', repo: 'widgets', number: 798, action: 'close' }),
    ).rejects.toThrow('issues:write');

    expect(sentQueries(), 'nothing may be attempted after a failed permission check').not.toContain(
      'closeIssue',
    );
  });

  it('throws a useful message when the issue does not exist', async () => {
    mockGitHub(null);

    await expect(
      applyIssueUpdate({ owner: 'acme', repo: 'widgets', number: 99999, action: 'close' }),
    ).rejects.toThrow('#99999 not found');
  });

  it('does not re-close an already closed issue', async () => {
    mockGitHub({ ...OPEN_ISSUE, state: 'CLOSED' });
    db.queueResult([{ n: 798 }]);

    const r = await applyIssueUpdate({
      owner: 'acme',
      repo: 'widgets',
      number: 798,
      action: 'close',
    });

    expect(sentQueries()).not.toContain('closeIssue');
    expect(r.previousState).toBe('CLOSED');
    expect(r.newState).toBe('CLOSED');
  });

  it('passes the close reason through', async () => {
    mockGitHub(OPEN_ISSUE);
    db.queueResult([{ n: 798 }]);

    await applyIssueUpdate({
      owner: 'acme',
      repo: 'widgets',
      number: 798,
      action: 'close',
      reason: 'duplicate',
    });

    const close = sent.find((s) => s.query.includes('closeIssue'));
    expect(close?.variables.reason).toBe('DUPLICATE');
  });

  it('mirrors the change into the graph so no reconcile is needed', async () => {
    mockGitHub(OPEN_ISSUE);
    db.queueResult([{ n: 798 }]);

    const r = await applyIssueUpdate({
      owner: 'acme',
      repo: 'widgets',
      number: 798,
      action: 'close',
      title: 'New title',
    });

    expect(r.graphUpdated).toBe(true);
    expect(db.queries[0].params).toMatchObject({ n: 798, state: 'CLOSED', title: 'New title' });
  });

  it('leaves the graph title untouched when only the state changed', async () => {
    mockGitHub(OPEN_ISSUE);
    db.queueResult([{ n: 798 }]);

    await applyIssueUpdate({ owner: 'acme', repo: 'widgets', number: 798, action: 'close' });

    expect(db.queries[0].params.title, 'coalesce keeps the stored title').toBeNull();
  });

  it('reports graphUpdated false when the issue is not in the graph', async () => {
    mockGitHub(OPEN_ISSUE);
    db.queueEmpty();

    const r = await applyIssueUpdate({
      owner: 'acme',
      repo: 'widgets',
      number: 798,
      action: 'close',
    });

    expect(r.graphUpdated).toBe(false);
  });

  it('resolves a login to a node id before calling addAssigneesToAssignable', async () => {
    mockGitHub(OPEN_ISSUE, { users: { chris: 'U_chris' } });
    db.queueResult([{ n: 798 }]);
    db.queueEmpty();
    db.queueEmpty();

    const r = await applyIssueUpdate({
      owner: 'acme',
      repo: 'widgets',
      number: 798,
      addAssignees: ['chris'],
    });

    expect(
      inOrder(sentQueries(), 'user(login:', 'addAssigneesToAssignable'),
      'the login resolves before the mutation runs',
    ).toBe(true);
    const add = sent.find((s) => s.query.includes('addAssigneesToAssignable'));
    expect(add?.variables).toMatchObject({ id: 'I_1', ids: ['U_chris'] });
    expect(r.assigneesAfter).toEqual(['chris']);
    expect(r.assigneesChanged).toBe(true);
  });

  it('throws before any mutation when the login does not exist on GitHub', async () => {
    mockGitHub(OPEN_ISSUE, { users: {} });

    await expect(
      applyIssueUpdate({
        owner: 'acme',
        repo: 'widgets',
        number: 798,
        addAssignees: ['notaperson'],
        action: 'close',
      }),
    ).rejects.toThrow(/@notaperson does not exist/);

    expect(sentQueries(), 'nothing may be attempted after a failed login resolution').not.toContain(
      'addAssigneesToAssignable',
    );
    expect(sentQueries(), 'the state change must not happen either').not.toContain('closeIssue');
  });

  it('skips the add mutation entirely when the login is already assigned', async () => {
    const snapshot = { ...OPEN_ISSUE, assignees: { nodes: [{ id: 'U_chris', login: 'chris' }] } };
    mockGitHub(snapshot);
    db.queueResult([{ n: 798 }]);

    const r = await applyIssueUpdate({
      owner: 'acme',
      repo: 'widgets',
      number: 798,
      addAssignees: ['chris'],
    });

    expect(sentQueries(), 'a no-op add must not call GitHub').not.toContain(
      'addAssigneesToAssignable',
    );
    expect(sentQueries(), 'and the login does not need resolving').not.toContain('user(login:');
    expect(r.assigneesChanged).toBe(false);
  });

  it('removes an assignee using the id taken from the live snapshot', async () => {
    const snapshot = { ...OPEN_ISSUE, assignees: { nodes: [{ id: 'U_chris', login: 'chris' }] } };
    mockGitHub(snapshot);
    db.queueResult([{ n: 798 }]);
    db.queueEmpty();
    db.queueEmpty();

    const r = await applyIssueUpdate({
      owner: 'acme',
      repo: 'widgets',
      number: 798,
      removeAssignees: ['chris'],
    });

    const remove = sent.find((s) => s.query.includes('removeAssigneesFromAssignable'));
    expect(remove?.variables).toMatchObject({ id: 'I_1', ids: ['U_chris'] });
    expect(r.assigneesAfter).toEqual([]);
  });

  it('deletes and recreates ASSIGNED_TO edges in the graph when assignees change', async () => {
    mockGitHub(OPEN_ISSUE, { users: { chris: 'U_chris' } });
    db.queueResult([{ n: 798 }]);
    db.queueEmpty();
    db.queueEmpty();

    await applyIssueUpdate({
      owner: 'acme',
      repo: 'widgets',
      number: 798,
      addAssignees: ['chris'],
    });

    expect(
      db.ranInOrder('DELETE r', 'MERGE (u:User'),
      'the delete must land before the merge, so a renamed user cleans up',
    ).toBe(true);
    const merge = db.queries.find((q) => q.query.includes('MERGE (u:User'));
    expect(merge?.params).toMatchObject({ n: 798, logins: ['chris'] });
  });
});

describe('commentAttribution', () => {
  // Context propagation needs a manager; without one getActiveSpan never sees a span.
  beforeAll(() => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    trace.setGlobalTracerProvider(new BasicTracerProvider());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function withSpan<T>(fn: () => T): T {
    const span = trace.getTracer('test').startSpan('test');
    try {
      return context.with(trace.setSpan(context.active(), span), fn);
    } finally {
      span.end();
    }
  }

  it('says the run was manual and untraceable when nothing identifies it', () => {
    const footer = commentAttribution();

    expect(footer, 'a reader must be told an AI wrote this').toContain('(AI)');
    expect(footer, 'a local run has no trace to offer').toContain('Manual local run, no trace id');
    expect(footer, 'the reader is told to check it').toContain('Verify before acting.');
    expect(footer, 'no identifier may be invented for a local run').not.toMatch(/trace `/);
  });

  it('names the deployment and version when the platform supplies them', () => {
    vi.stubEnv('ASTRO_DEPLOYMENT_ID', 'dep-42');
    vi.stubEnv('ASTRO_AGENT_VERSION', 'v9');

    const footer = commentAttribution();

    expect(footer).toContain('deployment `dep-42`');
    expect(footer).toContain('version `v9`');
    expect(footer, 'a deployed run is not a manual one').not.toContain('Manual local run');
  });

  it('carries the trace id when a span is recording', () => {
    vi.stubEnv('ASTRO_DEPLOYMENT_ID', 'dep-42');

    const footer = withSpan(() => commentAttribution());

    expect(footer, 'the trace id is what links a comment to its trace').toMatch(
      /trace `[0-9a-f]{32}`/,
    );
  });

  it('reports no trace rather than a zeroed one when the span is not recording', () => {
    vi.stubEnv('ASTRO_DEPLOYMENT_ID', 'dep-42');

    const footer = commentAttribution();

    expect(footer, 'an all-zero trace id is the absence of a trace').toContain('trace id missing');
    expect(footer).not.toContain('00000000000000000000000000000000');
  });

  it('emits a machine-readable marker a later run can grep for', () => {
    vi.stubEnv('ASTRO_DEPLOYMENT_ID', 'dep-42');

    expect(commentAttribution(), 'the marker is how the agent finds its own comment').toMatch(
      /^<!-- astro-agent: foreman /,
    );
  });

  it('marks the deployment as local when the platform supplies none', () => {
    expect(commentAttribution()).toContain('deployment=local');
  });
});

describe('createIssue', () => {
  it('opens an issue with the attribution footer and returns its number and url', async () => {
    mockGitHub(OPEN_ISSUE);

    const res = await createIssue({
      owner: 'acme',
      repo: 'widgets',
      title: 'A pattern across five closed issues',
      body: 'Body prose',
    });

    expect(res.number).toBe(4242);
    expect(res.url).toContain('/issues/4242');
    const create = sent.find((c) => c.query.includes('createIssue'));
    expect(create, 'the mutation ran').toBeDefined();
    expect(create?.variables.body as string).toContain('Body prose');
    expect(create?.variables.body as string, 'every write signs itself').toContain(
      'astro-agent: foreman',
    );
  });

  it('renders a Draws on block from derivedFrom, keeping the trail visible on the issue', async () => {
    mockGitHub(OPEN_ISSUE);

    await createIssue({
      owner: 'acme',
      repo: 'widgets',
      title: 'A theme',
      derivedFrom: [412, 530, 798],
    });

    const create = sent.find((c) => c.query.includes('createIssue'));
    const body = create?.variables.body as string;
    expect(body, 'the section is a heading so it renders on GitHub').toContain('### Draws on');
    expect(body).toContain('#412, #530, #798');
  });

  it('refuses to write when the token has no permission', async () => {
    mockGitHub(OPEN_ISSUE, { permission: 'READ' });

    await expect(createIssue({ owner: 'acme', repo: 'widgets', title: 'x' })).rejects.toThrow(
      /at least TRIAGE, got READ/,
    );
    expect(
      sent.some((c) => c.query.includes('createIssue')),
      'nothing written',
    ).toBe(false);
  });

  it('refuses when a label the caller asked for does not exist', async () => {
    mockGitHub(OPEN_ISSUE, {
      labels: [{ id: 'L_bug', name: 'bug' }],
    });

    await expect(
      createIssue({ owner: 'acme', repo: 'widgets', title: 'x', labels: ['bug', 'ghost'] }),
    ).rejects.toThrow(/labels do not exist: ghost/);
    expect(sent.some((c) => c.query.includes('createIssue'))).toBe(false);
  });

  it('rejects an empty title before any network call', async () => {
    mockGitHub(OPEN_ISSUE);

    await expect(createIssue({ owner: 'acme', repo: 'widgets', title: '   ' })).rejects.toThrow(
      /title is empty/,
    );
    expect(sent, 'nothing sent').toEqual([]);
  });
});

describe('findLikelyDuplicates', () => {
  it('returns candidates in the graph whose titles share tokens with the proposed title', async () => {
    db.queueResult([
      { number: 123, title: 'Login button unresponsive on Safari', state: 'OPEN', tokenMatches: 2 },
      { number: 456, title: 'Safari login broken since v4', state: 'CLOSED', tokenMatches: 1 },
    ]);

    const hits = await findLikelyDuplicates('Login button broken on Safari again');

    expect(hits).toEqual([
      { number: 123, title: 'Login button unresponsive on Safari', state: 'OPEN', tokenMatches: 2 },
      { number: 456, title: 'Safari login broken since v4', state: 'CLOSED', tokenMatches: 1 },
    ]);
  });

  it('returns nothing when the title has no substantial tokens, so the query is not even run', async () => {
    // No result queued; if the query ran, the driver would throw.
    const hits = await findLikelyDuplicates('a of it');

    expect(hits).toEqual([]);
  });
});
