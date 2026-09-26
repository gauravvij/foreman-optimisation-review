import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readAttachmentTool } from '../read-attachment';

const ctx = {} as never;
let filesDir: string;
let outside: string;

beforeEach(() => {
  filesDir = mkdtempSync(path.join(tmpdir(), 'analyzer-files-'));
  outside = mkdtempSync(path.join(tmpdir(), 'analyzer-outside-'));
  // stubEnv restores the original on unstub, including the not-set case.
  // process.env.KEY = undefined stores the literal string "undefined", which
  // is truthy, so a fallback ?? '/data/files' would never fire.
  vi.stubEnv('AGENT_FILES_DIR', filesDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const run = async (input: { path: string; limitBytes?: number }) =>
  (await readAttachmentTool.execute!(input, ctx)) as {
    ok: boolean;
    path: string;
    size: number;
    bytesReturned: number;
    truncated: boolean;
    content: string;
    message: string;
  };

describe('readAttachmentTool', () => {
  it('reads a text file the user attached', async () => {
    const target = path.join(filesDir, 'abc-note.md');
    writeFileSync(target, 'stack trace here');

    const r = await run({ path: target });

    expect(r.ok).toBe(true);
    expect(r.content).toBe('stack trace here');
    expect(r.truncated).toBe(false);
  });

  it('truncates a large file and says it did', async () => {
    const target = path.join(filesDir, 'big.log');
    writeFileSync(target, 'x'.repeat(200_000));

    const r = await run({ path: target, limitBytes: 4096 });

    expect(r.ok).toBe(true);
    expect(r.bytesReturned).toBe(4096);
    expect(r.truncated, 'a short read must not look like a short file').toBe(true);
    expect(r.message).toContain('200000');
  });

  it('refuses a relative path, since the adapter names an absolute one', async () => {
    const r = await run({ path: 'note.md' });

    expect(r.ok).toBe(false);
    expect(r.message).toContain('absolute path');
  });

  it('refuses a path outside the files dir', async () => {
    const target = path.join(outside, 'secret');
    writeFileSync(target, 'nope');

    const r = await run({ path: target });

    expect(r.ok).toBe(false);
    expect(r.content).toBe('');
    expect(r.message).toContain('will not read');
  });

  it('refuses a symlink inside the files dir that points outside it', async () => {
    const target = path.join(outside, 'real');
    writeFileSync(target, 'still not yours');
    const link = path.join(filesDir, 'link');
    symlinkSync(target, link);

    const r = await run({ path: link });

    expect(r.ok, 'the lexical check passes here, so the resolved check has to catch it').toBe(
      false,
    );
    expect(r.message).toContain('resolves outside');
  });

  it('says a missing file may have been from an earlier turn', async () => {
    const r = await run({ path: path.join(filesDir, 'gone.md') });

    expect(r.ok).toBe(false);
    expect(r.message).toContain('re-upload');
  });

  it('reports binary bytes as unreadable rather than returning them', async () => {
    const target = path.join(filesDir, 'screenshot.png');
    // PNG signature plus enough bytes that the sample is not empty.
    writeFileSync(
      target,
      Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(512)]),
    );

    const r = await run({ path: target });

    expect(r.ok).toBe(false);
    expect(r.content).toBe('');
    expect(r.message).toContain('2 MiB');
  });
});
