import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

const DEFAULT_LIMIT_BYTES = 64 * 1024;
const MAX_LIMIT_BYTES = 512 * 1024;

/**
 * The adapter's attachment note gives the model the file's absolute path on
 * the shared volume, so the tool takes that path directly. The safety check is
 * that the resolved path sits inside AGENT_FILES_DIR, so no crafted or leaked
 * path can leave the volume.
 */
function filesRoot(): string {
  return process.env.AGENT_FILES_DIR ?? '/data/files';
}

function inside(root: string, resolved: string): boolean {
  const rel = path.relative(root, resolved);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function looksBinary(sample: Buffer): boolean {
  if (sample.length === 0) return false;
  // A NUL byte or a high proportion of unprintable bytes both indicate the
  // buffer is not text, so returning it as prompt content would be noise.
  if (sample.includes(0)) return true;
  let unprintable = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13) continue;
    if (byte < 32 || byte === 127) unprintable++;
  }
  return unprintable / sample.length > 0.1;
}

export const readAttachmentTool = createTool({
  id: 'readAttachment',
  description:
    'Read a file the user attached to this turn. Only for non-image files: an ' +
    'image is already visible to the model, and reading its bytes as text is ' +
    'noise. Takes the absolute path the adapter names in "Open them with a ' +
    'file-reading tool at the paths below." A large image forwarded as a file, ' +
    'over the 2 MiB inline budget, is not readable through this tool either.',
  inputSchema: z.object({
    path: z
      .string()
      .describe('Absolute path as the adapter named it, e.g. /data/files/abc-note.md'),
    limitBytes: z
      .number()
      .int()
      .positive()
      .max(MAX_LIMIT_BYTES)
      .optional()
      .describe(`Max bytes to return. Default ${DEFAULT_LIMIT_BYTES}, cap ${MAX_LIMIT_BYTES}.`),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    path: z.string(),
    size: z.number(),
    bytesReturned: z.number(),
    truncated: z.boolean(),
    content: z.string(),
    message: z.string(),
  }),
  execute: async (input) => {
    const requested = input.path;
    const limit = input.limitBytes ?? DEFAULT_LIMIT_BYTES;
    const empty = {
      ok: false,
      path: requested,
      size: 0,
      bytesReturned: 0,
      truncated: false,
      content: '',
    };

    if (!path.isAbsolute(requested)) {
      return {
        ...empty,
        message: `Expected an absolute path, got ${JSON.stringify(requested)}. Use the path the adapter named, not the filename alone.`,
      };
    }

    // Both the root and the resolved path are canonicalized before being
    // compared, so a symlinked prefix like /var to /private/var on macOS does
    // not read as one side sitting outside the other. realpath rejects a path
    // that does not exist, so the missing-file branch relies on the parent
    // resolving even when the file itself is gone.
    const lexical = path.resolve(requested);
    let root: string;
    let real: string;
    let stats: Awaited<ReturnType<typeof stat>>;
    try {
      root = await realpath(filesRoot());
    } catch (err) {
      return {
        ...empty,
        path: lexical,
        message: `Could not resolve the files directory: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    try {
      real = await realpath(lexical);
      stats = await stat(real);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/ENOENT/.test(message)) {
        try {
          const parent = await realpath(path.dirname(lexical));
          const anchored = path.join(parent, path.basename(lexical));
          if (!inside(root, anchored)) {
            return {
              ...empty,
              path: anchored,
              message: `${anchored} is not under ${root}, so this tool will not read it.`,
            };
          }
        } catch {
          // The parent is unreadable; fall through to the absence message.
        }
        return {
          ...empty,
          message: `${lexical} does not exist. It may have been from an earlier turn; the user has to re-upload it.`,
        };
      }
      return { ...empty, message: `Could not read ${lexical}: ${message}` };
    }

    if (!inside(root, real)) {
      return {
        ...empty,
        path: real,
        size: stats.size,
        message: `${real} resolves outside ${root}, so this tool will not read it.`,
      };
    }
    if (!stats.isFile()) {
      return {
        ...empty,
        path: real,
        size: stats.size,
        message: `${real} is not a regular file.`,
      };
    }

    const readN = Math.min(limit, stats.size);
    const buf = Buffer.alloc(readN);
    const fh = await open(real, 'r');
    try {
      await fh.read(buf, 0, readN, 0);
    } finally {
      await fh.close();
    }

    // A binary sample says the file is either an image the sidecar could not
    // inline (over 2 MiB) or a genuine non-text upload. Either way, its bytes
    // are not useful as prompt content.
    if (looksBinary(buf.subarray(0, Math.min(4096, buf.length)))) {
      return {
        ok: false,
        path: real,
        size: stats.size,
        bytesReturned: 0,
        truncated: false,
        content: '',
        message: `${path.basename(real)} does not look like text (${stats.size} bytes). If it is a screenshot, the sidecar inlines images up to 2 MiB — re-upload a smaller or JPEG copy and the model will see it directly.`,
      };
    }

    const truncated = stats.size > readN;
    return {
      ok: true,
      path: real,
      size: stats.size,
      bytesReturned: readN,
      truncated,
      content: buf.toString('utf8'),
      message: truncated
        ? `Read ${readN} of ${stats.size} bytes. Ask for a larger limit or a specific offset if you need more.`
        : `Read ${readN} bytes.`,
    };
  },
});
