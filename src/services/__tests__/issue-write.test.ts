import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDriver, inOrder } from './fake-driver';

const fake = vi.hoisted(() => ({
  ref: null as ReturnType<typeof import('./fake-driver').createFakeDriver> | null,
}));

vi.mock('../neo4j', () => ({ getDriver: () => fake.ref?.mockDriver }));

import { applyIssueUpdate, commentAttribution } from '../issue-write';

let db: ReturnType<typeof createFakeDriver>;
/** Every GraphQL body the service sent, in order. */
let sent: { query: string; variables: Record<string, unknown> }[];

const OPEN_ISSUE = {
  id: 'I_1',
  number: 798,
  title: 'Original title',
  state: 'OPEN',
  viewerCanUpdate: true,
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
