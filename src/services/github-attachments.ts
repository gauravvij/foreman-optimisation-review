/**
 * Uploads an attachment to GitHub's user-attachments store, which is the CDN
 * the web UI writes to when you drag an image into an issue. The returned URL
 * is embeddable in issue and comment bodies exactly like a drag-drop upload.
 *
 * The endpoint (uploads.github.com/user-attachments/assets) is undocumented
 * but public and PAT-authenticated. It has been in continuous use by third-
 * party CLIs (gh-attach and others) since GitHub rolled it out to their own
 * web UI. If GitHub restricts or changes it, this function starts returning
 * an error and the tool fails loudly rather than silently dropping the image.
 */

import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { githubGraphQL } from './http';

/** Cache resolved repository ids across a process lifetime; the value is stable. */
const repositoryIdCache = new Map<string, string>();

/** MIME types the endpoint accepts, mirroring what the web UI drag-and-drop accepts. */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.zip': 'application/zip',
};

function inferMime(filePath: string): string {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function filesRoot(): string {
  return process.env.AGENT_FILES_DIR ?? '/data/files';
}

/**
 * The path arriving here comes from the model, which the adapter gave the
 * absolute path on the shared volume. Resolve and confirm it sits inside
 * AGENT_FILES_DIR so a crafted path cannot exfiltrate anything else.
 */
async function readFileFromVolume(requested: string): Promise<{ bytes: Buffer; realPath: string }> {
  if (!path.isAbsolute(requested)) {
    throw new Error(
      `Expected an absolute path on the shared volume, got ${JSON.stringify(requested)}`,
    );
  }
  const root = await realpath(filesRoot());
  const real = await realpath(path.resolve(requested));
  const rel = path.relative(root, real);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`${real} is not under ${root}, refusing to upload`);
  }
  const info = await stat(real);
  if (!info.isFile()) {
    throw new Error(`${real} is not a regular file`);
  }

  const fh = await open(real, 'r');
  try {
    const bytes = Buffer.alloc(info.size);
    await fh.read(bytes, 0, info.size, 0);
    return { bytes, realPath: real };
  } finally {
    await fh.close();
  }
}

async function resolveRepositoryId(owner: string, repo: string): Promise<string> {
  const key = `${owner}/${repo}`;
  const cached = repositoryIdCache.get(key);
  if (cached) return cached;
  const data = await githubGraphQL<{ repository: { databaseId: number } | null }>(
    'query($owner:String!,$repo:String!){ repository(owner:$owner,name:$repo){ databaseId } }',
    { owner, repo },
    'GitHub repository id',
  );
  const id = data.repository?.databaseId;
  if (typeof id !== 'number') throw new Error(`repository ${owner}/${repo} not found`);
  const asString = String(id);
  repositoryIdCache.set(key, asString);
  return asString;
}

export interface UploadOptions {
  owner: string;
  repo: string;
  /** Absolute path on the shared volume, as the adapter's attachment note names it. */
  path: string;
  /** Filename the attachment is stored under. Defaults to the source basename. */
  name?: string;
  /** MIME type. Inferred from the extension when omitted. */
  contentType?: string;
}

export interface UploadedAttachment {
  url: string;
  name: string;
  contentType: string;
  size: number;
}

/**
 * Uploads one file and returns its embed URL. On any non-2xx the function
 * throws with GitHub's response text, so a caller failing the write loudly
 * is the default; there is no fallback path here on purpose.
 */
export async function uploadAttachment(opts: UploadOptions): Promise<UploadedAttachment> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set');

  const { bytes, realPath } = await readFileFromVolume(opts.path);
  const name = opts.name ?? path.basename(realPath);
  const contentType = opts.contentType ?? inferMime(realPath);
  const repositoryId = await resolveRepositoryId(opts.owner, opts.repo);

  const url = new URL('https://uploads.github.com/user-attachments/assets');
  url.searchParams.set('name', name);
  url.searchParams.set('content_type', contentType);
  url.searchParams.set('repository_id', repositoryId);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': contentType,
    },
    body: new Uint8Array(bytes),
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    throw new Error(
      `github user-attachments upload failed: HTTP ${res.status} ${res.statusText}${detail ? `\n${detail}` : ''}`,
    );
  }

  const data = (await res.json()) as { url?: string; asset_url?: string; href?: string };
  const embedUrl = data.url ?? data.asset_url ?? data.href;
  if (typeof embedUrl !== 'string' || !embedUrl.startsWith('https://')) {
    throw new Error(
      `github user-attachments upload returned no url: ${JSON.stringify(data).slice(0, 200)}`,
    );
  }

  return { url: embedUrl, name, contentType, size: bytes.length };
}

export function _clearRepositoryIdCacheForTests(): void {
  repositoryIdCache.clear();
}
