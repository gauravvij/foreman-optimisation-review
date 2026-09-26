import { beforeEach, describe, expect, it, vi } from 'vitest';

const svc = vi.hoisted(() => ({
  createIssue: vi.fn(),
  findLikelyDuplicates: vi.fn(),
  uploadAttachment: vi.fn(),
}));

vi.mock('../../../src/services/issue-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/services/issue-write')>();
  return {
    ...actual,
    createIssue: svc.createIssue,
    findLikelyDuplicates: svc.findLikelyDuplicates,
  };
});

vi.mock('../../../src/services/github-attachments', () => ({
  uploadAttachment: svc.uploadAttachment,
}));

import { createIssueTool } from '../create-issue';

const ctx = {} as never;
const suspending = { agent: { suspend: vi.fn() } } as never;
const confirmed = { agent: { resumeData: { confirm: true } } } as never;
const declined = { agent: { resumeData: { confirm: false } } } as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('GITHUB_OWNER', 'acme');
  vi.stubEnv('GITHUB_REPO', 'widgets');
});

const run = (
  ctxArg: unknown,
  input: { title: string; body?: string; derivedFrom?: number[]; labels?: string[] } = {
    title: 'A theme',
  },
) =>
  createIssueTool.execute!(input, ctxArg as never) as Promise<{
    opened: boolean;
    number: number;
    url: string;
    duplicateCandidates: number;
    message: string;
  }>;

describe('createIssueTool', () => {
  it('runs the duplicate check and asks for confirmation before writing', async () => {
    svc.findLikelyDuplicates.mockResolvedValue([
      { number: 123, title: 'Existing but similar', state: 'OPEN', tokenMatches: 2 },
    ]);

    const r = await run(suspending, { title: 'A pattern across issues' });

    expect(svc.findLikelyDuplicates).toHaveBeenCalledWith('A pattern across issues');
    expect(svc.createIssue, 'nothing is written before confirmation').not.toHaveBeenCalled();
    expect(r.opened).toBe(false);
    expect(r.duplicateCandidates).toBe(1);
    const suspend = (suspending as unknown as { agent: { suspend: ReturnType<typeof vi.fn> } })
      .agent.suspend;
    const message = suspend.mock.calls[0]?.[0]?.message as string;
    expect(message, 'the duplicate is named so a person can pick it instead').toContain('#123');
    expect(message).toContain('duplicates');
  });

  it('opens the issue once confirmed and reports back the number and url', async () => {
    svc.createIssue.mockResolvedValue({
      number: 4242,
      url: 'https://github.com/acme/widgets/issues/4242',
      title: 'A theme',
    });

    const r = await run(confirmed, { title: 'A theme', derivedFrom: [1, 2] });

    expect(svc.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'acme',
        repo: 'widgets',
        title: 'A theme',
        derivedFrom: [1, 2],
      }),
    );
    expect(r.opened).toBe(true);
    expect(r.number).toBe(4242);
    expect(r.url).toContain('/issues/4242');
  });

  it('opens nothing when declined', async () => {
    const r = await run(declined);

    expect(svc.createIssue).not.toHaveBeenCalled();
    expect(r.opened).toBe(false);
    expect(r.message).toContain('Cancelled');
  });

  it('surfaces a service failure without half-writing', async () => {
    svc.createIssue.mockRejectedValue(
      new Error('the configured token cannot open issues on acme/widgets'),
    );

    const r = await run(confirmed);

    expect(r.opened).toBe(false);
    expect(r.message).toContain('Failed to open the issue');
    expect(r.message).toContain('cannot open issues');
  });

  it('carries on when the duplicate check itself fails, since it is a helper not a gate', async () => {
    svc.findLikelyDuplicates.mockRejectedValue(new Error('graph unreachable'));

    const r = await run(suspending);

    expect(svc.createIssue).not.toHaveBeenCalled();
    expect(r.opened).toBe(false);
    expect(r.duplicateCandidates).toBe(0);
    const suspend = (suspending as unknown as { agent: { suspend: ReturnType<typeof vi.fn> } })
      .agent.suspend;
    expect(suspend, 'the confirmation prompt is still raised').toHaveBeenCalled();
  });

  it('refuses to write when GITHUB_OWNER or GITHUB_REPO is unset', async () => {
    vi.stubEnv('GITHUB_OWNER', '');

    const r = await run(confirmed);

    expect(svc.createIssue).not.toHaveBeenCalled();
    expect(r.message).toContain('not configured');
  });
});

describe('createIssueTool: attachments', () => {
  it('uploads each attachment, embeds it in the body, then creates the issue', async () => {
    svc.uploadAttachment.mockResolvedValueOnce({
      url: 'https://github.com/user-attachments/assets/abc-shot.png',
      name: 'shot.png',
      contentType: 'image/png',
      size: 1024,
    });
    svc.createIssue.mockResolvedValue({
      number: 4242,
      url: 'https://github.com/acme/widgets/issues/4242',
      title: 'A theme',
    });

    const r = (await createIssueTool.execute!(
      {
        title: 'A theme',
        body: 'context prose',
        attachments: [{ path: '/data/files/abc-shot.png', alt: 'the failing UI' }],
      },
      confirmed,
    )) as { opened: boolean };

    expect(svc.uploadAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'acme', repo: 'widgets', path: '/data/files/abc-shot.png' }),
    );
    expect(r.opened).toBe(true);
    const create = svc.createIssue.mock.calls[0]?.[0] as { body?: string };
    expect(create.body, 'the image embeds as markdown').toContain(
      '![the failing UI](https://github.com/user-attachments/assets/abc-shot.png)',
    );
    expect(create.body, 'the original prose survives').toContain('context prose');
  });

  it('renders a non-image attachment as a link, not an image', async () => {
    svc.uploadAttachment.mockResolvedValueOnce({
      url: 'https://github.com/user-attachments/assets/xyz-run.log',
      name: 'run.log',
      contentType: 'text/plain',
      size: 512,
    });
    svc.createIssue.mockResolvedValue({
      number: 5,
      url: 'https://github.com/acme/widgets/issues/5',
      title: 'A theme',
    });

    await createIssueTool.execute!(
      { title: 'A theme', attachments: [{ path: '/data/files/xyz-run.log' }] },
      confirmed,
    );

    const create = svc.createIssue.mock.calls[0]?.[0] as { body?: string };
    expect(create.body).toContain(
      '[run.log](https://github.com/user-attachments/assets/xyz-run.log)',
    );
    expect(create.body, 'a non-image should not render as an image').not.toContain('![run.log]');
  });

  it('fails the whole write when any upload fails, and no issue is created', async () => {
    svc.uploadAttachment.mockRejectedValueOnce(
      new Error('github user-attachments upload failed: HTTP 413 Payload Too Large'),
    );

    const r = (await createIssueTool.execute!(
      { title: 'A theme', attachments: [{ path: '/data/files/huge.mp4' }] },
      confirmed,
    )) as { opened: boolean; message: string };

    expect(svc.createIssue, 'no issue is created when any upload fails').not.toHaveBeenCalled();
    expect(r.opened).toBe(false);
    expect(r.message).toContain('Failed to upload');
    expect(r.message).toContain('HTTP 413');
    expect(r.message).toContain('no issue was opened');
  });

  it('lists the attachments in the confirmation prompt so the user can see them', async () => {
    svc.findLikelyDuplicates.mockResolvedValue([]);

    await createIssueTool.execute!(
      {
        title: 'A theme',
        attachments: [{ path: '/data/files/a.png' }, { path: '/data/files/b.log' }],
      },
      suspending,
    );

    const suspend = (suspending as unknown as { agent: { suspend: ReturnType<typeof vi.fn> } })
      .agent.suspend;
    const message = suspend.mock.calls[0]?.[0]?.message as string;
    expect(message).toContain('Attachments:');
    expect(message).toContain('/data/files/a.png');
    expect(message).toContain('/data/files/b.log');
  });
});
