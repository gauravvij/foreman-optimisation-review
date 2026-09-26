/**
 * Reconciles issue open/closed state in the graph against GitHub.
 *
 * The startup sync fetches `ISSUE_STATE=open`, so an issue closed after it was
 * ingested is never re-fetched and keeps a stale OPEN state. The scheduled sync
 * uses `all` but only sees issues touched since its last run, so it cannot clear
 * the backlog. This asks GitHub for the current state of every issue we hold.
 */

import neo4j from 'neo4j-driver';
import { fetchWithRetry } from './http';
import { getDriver } from './neo4j';

export interface LiveIssue {
  number: number;
  state: string;
  closedAt: string | null;
  updatedAt: string;
}

export interface StateDrift {
  number: number;
  storedState: string;
  liveState: string;
  closedAt: string | null;
}

export interface ReconcileResult {
  checked: number;
  resolved: number;
  /** Numbers GitHub could not be asked about. Never treated as deleted. */
  unresolved: number[];
  /** Numbers GitHub reports do not exist: deleted, or never created. */
  ghosts: number[];
  /** Ghosts left in place because they carry a human assessment. */
  ghostsKept: number[];
  drift: StateDrift[];
  applied: number;
  deleted: number;
  dryRun: boolean;
  error?: string;
}

/** What a batch learned: states it resolved, and numbers GitHub says are gone. */
export interface LiveStates {
  live: Map<number, LiveIssue>;
  missing: Set<number>;
}

const BATCH = 50;

/** Current state of each issue, fetched in aliased batches to bound request count. */
export async function fetchLiveStates(
  owner: string,
  repo: string,
  numbers: number[],
): Promise<LiveStates> {
  const live = new Map<number, LiveIssue>();
  const missing = new Set<number>();

  for (let i = 0; i < numbers.length; i += BATCH) {
    const fields = numbers
      .slice(i, i + BATCH)
      .map((n) => `i${n}: issue(number:${n}){ number state closedAt updatedAt }`)
      .join('\n');

    const res = await fetchWithRetry(
      () =>
        fetch('https://api.github.com/graphql', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            query: `query($owner:String!,$repo:String!){ repository(owner:$owner,name:$repo){ ${fields} } }`,
            variables: { owner, repo },
          }),
        }),
      'GitHub issue states',
    );
    if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);

    const json = (await res.json()) as {
      data?: { repository: Record<string, LiveIssue | null> };
      errors?: { message: string; type?: string; path?: (string | number)[] }[];
    };
    // A deleted issue answers with a NOT_FOUND error beside partial data, so
    // the batch's other 49 results are still good. Any other error is not
    // evidence of deletion and must not be read as one.
    const errors = json.errors ?? [];
    const notFound = errors.filter((e) => e.type === 'NOT_FOUND');
    const other = errors.filter((e) => e.type !== 'NOT_FOUND');
    if (other.length > 0) throw new Error(`GraphQL: ${JSON.stringify(other)}`);

    for (const e of notFound) {
      const alias = e.path?.[e.path.length - 1];
      const n =
        typeof alias === 'string' ? Number.parseInt(alias.replace(/^i/, ''), 10) : Number.NaN;
      if (Number.isFinite(n)) missing.add(n);
    }
    for (const v of Object.values(json.data?.repository ?? {})) {
      if (v) live.set(v.number, v);
    }
  }

  return { live, missing };
}

/** Compares stored state against live state. Pure, so the diff is testable. */
export function findDrift(
  stored: { number: number; state: string }[],
  live: Map<number, LiveIssue>,
): StateDrift[] {
  const drift: StateDrift[] = [];
  for (const row of stored) {
    const l = live.get(row.number);
    if (l && l.state !== row.state) {
      drift.push({
        number: row.number,
        storedState: row.state,
        liveState: l.state,
        closedAt: l.closedAt,
      });
    }
  }
  return drift;
}

export async function reconcileIssueState(opts: {
  owner: string;
  repo: string;
  dryRun: boolean;
}): Promise<ReconcileResult> {
  const { owner, repo, dryRun } = opts;
  const session = getDriver().session();

  try {
    const stored = await session.run(
      `MATCH (i:Issue) RETURN i.number AS number, i.state AS state ORDER BY i.number`,
    );
    const rows = stored.records.map((r) => ({
      number: neo4j.int(r.get('number')).toNumber(),
      state: r.get('state') as string,
    }));

    if (rows.length === 0) {
      return {
        checked: 0,
        resolved: 0,
        unresolved: [],
        ghosts: [],
        ghostsKept: [],
        drift: [],
        applied: 0,
        deleted: 0,
        dryRun,
      };
    }

    const { live, missing } = await fetchLiveStates(
      owner,
      repo,
      rows.map((r) => r.number),
    );
    const drift = findDrift(rows, live);
    const ghosts = rows.filter((r) => missing.has(r.number)).map((r) => r.number);
    const unresolved = rows
      .filter((r) => !live.has(r.number) && !missing.has(r.number))
      .map((r) => r.number);

    if (dryRun || (drift.length === 0 && ghosts.length === 0)) {
      return {
        checked: rows.length,
        resolved: live.size,
        unresolved,
        ghosts,
        ghostsKept: [],
        drift,
        applied: 0,
        deleted: 0,
        dryRun,
      };
    }

    let applied = 0;
    for (const d of drift) {
      const l = live.get(d.number) as LiveIssue;
      await session.run(
        `MATCH (i:Issue {number: $n})
         SET i.state = $state, i.closedAt = $closedAt, i.updatedAt = $updatedAt`,
        { n: d.number, state: l.state, closedAt: l.closedAt, updatedAt: l.updatedAt },
      );
      applied++;
    }

    // An Assessment is the only human-authored data on an issue, so a ghost
    // carrying one is reported rather than removed.
    let deleted = 0;
    const ghostsKept: number[] = [];
    for (const n of ghosts) {
      const held = await session.run(
        `MATCH (i:Issue {number: $n})-[:HAS_ASSESSMENT]->(a:Assessment) RETURN count(a) AS c`,
        { n },
      );
      if ((held.records[0]?.get('c')?.toNumber?.() ?? 0) > 0) {
        ghostsKept.push(n);
        continue;
      }
      await session.run(`MATCH (i:Issue {number: $n}) DETACH DELETE i`, { n });
      deleted++;
    }

    return {
      checked: rows.length,
      resolved: live.size,
      unresolved,
      ghosts,
      ghostsKept,
      drift,
      applied,
      deleted,
      dryRun: false,
    };
  } finally {
    await session.close();
  }
}
