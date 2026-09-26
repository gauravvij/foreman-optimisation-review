import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _clearRepositoryIdCacheForTests, uploadAttachment } from '../github-attachments';

let filesDir: string;
let outside: string;
/** Every request the code sent, in order. */
let sent: { url: string; init: RequestInit; body: Uint8Array | string | null }[];

function mockFetch(
  handler: (req: { url: URL; init: RequestInit }) => Response | Promise<Response>,
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url =
        typeof input === 'string'
          ? new URL(input)
          : input instanceof URL
            ? input
            : new URL(input.url);
      sent.push({
        url: url.toString(),
        init,
        body: (init.body as Uint8Array | string | null) ?? null,
      });
      return handler({ url, init });
    }),
  );
}

/** Response bodies can only be read once; construct a fresh one per call. */
const resolveIdResponse = () =>
  new Response(JSON.stringify({ data: { repository: { databaseId: 987654321 } } }));

beforeEach(() => {
  filesDir = mkdtempSync(path.join(tmpdir(), 'foreman-files-'));
  outside = mkdtempSync(path.join(tmpdir(), 'foreman-outside-'));
  vi.stubEnv('AGENT_FILES_DIR', filesDir);
  vi.stubEnv('GITHUB_TOKEN', 'test-token');
  sent = [];
  _clearRepositoryIdCacheForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('uploadAttachment', () => {
  it('sends the file to uploads.github.com and returns the embed url', async () => {
    const target = path.join(filesDir, 'shot.png');
    writeFileSync(target, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]));

    mockFetch(({ url }) => {
      if (url.hostname === 'api.github.com') return resolveIdResponse();
      return new Response(
        JSON.stringify({ url: 'https://github.com/user-attachments/assets/abc-shot.png' }),
      );
    });

    const uploaded = await uploadAttachment({ owner: 'acme', repo: 'widgets', path: target });

    expect(uploaded.url).toBe('https://github.com/user-attachments/assets/abc-shot.png');
    expect(uploaded.name).toBe('shot.png');
    expect(uploaded.contentType).toBe('image/png');

    const upload = sent.find((r) => r.url.startsWith('https://uploads.github.com/'));
    expect(upload, 'the upload call happened').toBeDefined();
    expect(upload?.url).toContain('name=shot.png');
    expect(upload?.url).toContain('content_type=image%2Fpng');
    expect(upload?.url).toContain('repository_id=987654321');
    const headers = new Headers(upload?.init.headers);
    expect(headers.get('authorization')).toBe('Bearer test-token');
    expect(upload?.init.method).toBe('POST');
  });

  it('throws with the response body when GitHub returns a non-2xx, so the caller can fail loudly', async () => {
    const target = path.join(filesDir, 'huge.mp4');
    writeFileSync(target, 'x'.repeat(16));

    mockFetch(({ url }) => {
      if (url.hostname === 'api.github.com') return resolveIdResponse();
      return new Response('Payload Too Large', { status: 413, statusText: 'Payload Too Large' });
    });

    await expect(
      uploadAttachment({ owner: 'acme', repo: 'widgets', path: target }),
    ).rejects.toThrow(/HTTP 413.*Payload Too Large/s);
  });

  it('refuses a path that escapes AGENT_FILES_DIR before any network call', async () => {
    const target = path.join(outside, 'secret.txt');
    writeFileSync(target, 'nope');

    mockFetch(() => new Response('should never be called', { status: 500 }));

    await expect(
      uploadAttachment({ owner: 'acme', repo: 'widgets', path: target }),
    ).rejects.toThrow(/is not under.*refusing to upload/);
    expect(sent, 'nothing was sent to the network').toEqual([]);
  });

  it('refuses when GITHUB_TOKEN is unset, before any network call', async () => {
    vi.stubEnv('GITHUB_TOKEN', '');
    const target = path.join(filesDir, 'a.txt');
    writeFileSync(target, 'hi');

    await expect(
      uploadAttachment({ owner: 'acme', repo: 'widgets', path: target }),
    ).rejects.toThrow(/GITHUB_TOKEN is not set/);
    expect(sent).toEqual([]);
  });

  it('infers content-type from the extension, and honours an explicit override', async () => {
    const target = path.join(filesDir, 'trace.log');
    writeFileSync(target, 'stack trace');

    let seenContentType: string | null = null;
    mockFetch(({ url, init }) => {
      if (url.hostname === 'api.github.com') return resolveIdResponse();
      seenContentType = url.searchParams.get('content_type');
      const headers = new Headers(init.headers);
      expect(headers.get('content-type')).toBe(seenContentType);
      return new Response(JSON.stringify({ url: 'https://example.com/x' }));
    });

    await uploadAttachment({ owner: 'acme', repo: 'widgets', path: target });
    expect(seenContentType).toBe('text/plain');

    _clearRepositoryIdCacheForTests();
    sent = [];
    await uploadAttachment({
      owner: 'acme',
      repo: 'widgets',
      path: target,
      contentType: 'application/vnd.custom',
    });
    expect(seenContentType).toBe('application/vnd.custom');
  });

  it('caches the repository id so a batch of uploads makes one id lookup', async () => {
    for (const name of ['a.png', 'b.png']) {
      writeFileSync(path.join(filesDir, name), 'x');
    }

    mockFetch(({ url }) => {
      if (url.hostname === 'api.github.com') return resolveIdResponse();
      return new Response(JSON.stringify({ url: 'https://github.com/user-attachments/assets/x' }));
    });

    await uploadAttachment({ owner: 'acme', repo: 'widgets', path: path.join(filesDir, 'a.png') });
    await uploadAttachment({ owner: 'acme', repo: 'widgets', path: path.join(filesDir, 'b.png') });

    const idLookups = sent.filter((r) => r.url.includes('api.github.com'));
    expect(idLookups, 'the id is looked up once per repo across a run').toHaveLength(1);
  });
});
