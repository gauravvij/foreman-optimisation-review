/**
 * Shared GitHub HTTP retry policy.
 *
 * Both the GraphQL read client and the REST label writer talk to the same API
 * and hit the same rate limits, so the backoff lives here rather than in each.
 */

const MAX_RETRIES = 5;
const RETRY_STATUS_CODES = new Set([429, 500, 502, 503]);
const MAX_BACKOFF_MS = 30_000;

/** GitHub asks for roughly one write per second; anything faster risks a secondary limit. */
export const WRITE_INTERVAL_MS = 1000;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffFor(attempt: number, res: Response): number {
  const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
  if (Number.isFinite(retryAfter) && retryAfter > 0)
    return Math.min(retryAfter * 1000, MAX_BACKOFF_MS);
  return Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
}

/**
 * Calls `send` until it returns a non-retryable response or the retries run out.
 * Returns the final Response; the caller decides what a non-ok status means.
 */
export async function fetchWithRetry(
  send: () => Promise<Response>,
  label: string,
): Promise<Response> {
  let res = await send();

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (res.ok || !RETRY_STATUS_CODES.has(res.status)) return res;

    const backoff = backoffFor(attempt, res);
    console.warn(
      `  ${label}: HTTP ${res.status}, retrying in ${backoff / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})...`,
    );
    await sleep(backoff);
    res = await send();
  }

  return res;
}

export interface GraphQLError {
  type?: string;
  message?: string;
}

/** GitHub reports a GraphQL rate limit in the body with HTTP 200, which no status check sees. */
export function isRateLimited(errors: GraphQLError[]): boolean {
  return errors.some(
    (e) =>
      e.type === 'RATE_LIMITED' || e.type === 'RATE_LIMIT' || /rate limit/i.test(e.message ?? ''),
  );
}

/**
 * POSTs a GraphQL operation to GitHub and unwraps `data`.
 *
 * Reads the token per call rather than at import, so a token supplied after
 * module load still applies.
 */
export async function githubGraphQL<T>(
  query: string,
  variables: Record<string, unknown> = {},
  label = 'GitHub GraphQL',
): Promise<T> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN environment variable is required');

  for (let attempt = 0; ; attempt++) {
    const res = await fetchWithRetry(
      () =>
        fetch('https://api.github.com/graphql', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, variables }),
        }),
      label,
    );

    if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);

    const json = (await res.json()) as { data?: T; errors?: GraphQLError[] };
    if (!json.errors) return json.data as T;

    if (!isRateLimited(json.errors) || attempt >= MAX_RETRIES - 1) {
      throw new Error(`GraphQL: ${JSON.stringify(json.errors)}`);
    }

    const backoff = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
    console.warn(
      `  ${label}: rate limited, retrying in ${backoff / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})...`,
    );
    await sleep(backoff);
  }
}
