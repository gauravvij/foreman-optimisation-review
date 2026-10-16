/**
 * Reads pull request counts from the knowledge graph.
 *
 * The ingestion pipeline mirrors every pull request into Neo4j as a
 * `(:PullRequest)` node with `(:PullRequest)-[:AUTHORED_BY]->(:User)`, so the
 * question "how many pull requests did @X open this week" is answered by one
 * Cypher pass rather than four GitHub searches.
 */

import neo4j from 'neo4j-driver';
import { getDriver } from './neo4j';

export interface PullRequestStatsOptions {
  /** Filter to this GitHub login. Omit for repo-wide stats. */
  author?: string;
  /** ISO 8601 start of the window, inclusive. Omit to use `windowDays`. */
  since?: string;
  /** ISO 8601 end of the window, inclusive. Omit to use "now". */
  until?: string;
  /**
   * Window length in days when neither since nor until is set. Default 7 so
   * "this week" is the natural question answered without extra inputs.
   */
  windowDays?: number;
  /** 0-20 example pull requests, ordered by most recent activity in the window. */
  sampleLimit?: number;
}

export interface PullRequestStatsSample {
  number: number;
  title: string;
  url: string;
  author: string | null;
  state: string;
  isDraft: boolean;
  isMerged: boolean;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
}

export interface PullRequestStats {
  author?: string;
  window: { since: string; until: string; days: number };
  /** Opened in the window. */
  opened: number;
  /** Merged in the window; may have been opened outside it. */
  merged: number;
  /** Closed in the window without being merged. */
  closed: number;
  sample: PullRequestStatsSample[];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 7;
const MAX_SAMPLE = 20;

function parseIso(iso: string, label: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`${label} is not a valid date: ${iso}`);
  return d.toISOString();
}

export async function pullRequestStats(
  opts: PullRequestStatsOptions = {},
): Promise<PullRequestStats> {
  const { author, since, until, windowDays = DEFAULT_WINDOW_DAYS, sampleLimit = 5 } = opts;

  const untilIso = until ? parseIso(until, 'until') : new Date().toISOString();
  const sinceIso = since
    ? parseIso(since, 'since')
    : new Date(new Date(untilIso).getTime() - windowDays * MS_PER_DAY).toISOString();
  const days = Math.max(
    1,
    Math.round((new Date(untilIso).getTime() - new Date(sinceIso).getTime()) / MS_PER_DAY),
  );
  const limit = Math.min(Math.max(sampleLimit, 0), MAX_SAMPLE);

  const session = getDriver().session();
  try {
    // Three counts in one pass. The author filter is applied by a sub-match
    // only when $author is non-null, so a repo-wide question stays index-free
    // on authorLogin.
    const counts = await session.run(
      `MATCH (pr:PullRequest)
       WHERE $author IS NULL OR pr.authorLogin = $author
       WITH pr,
            datetime(pr.createdAt) AS created,
            CASE WHEN pr.mergedAt IS NOT NULL THEN datetime(pr.mergedAt) ELSE null END AS mergedAt,
            CASE WHEN pr.closedAt IS NOT NULL THEN datetime(pr.closedAt) ELSE null END AS closedAt,
            coalesce(pr.isMerged, false) AS isMerged
       RETURN
         sum(CASE WHEN created >= datetime($since) AND created <= datetime($until) THEN 1 ELSE 0 END) AS opened,
         sum(CASE WHEN mergedAt IS NOT NULL AND mergedAt >= datetime($since) AND mergedAt <= datetime($until) THEN 1 ELSE 0 END) AS merged,
         sum(CASE WHEN isMerged = false AND closedAt IS NOT NULL AND closedAt >= datetime($since) AND closedAt <= datetime($until) THEN 1 ELSE 0 END) AS closed`,
      { author: author ?? null, since: sinceIso, until: untilIso },
    );

    const row = counts.records[0];
    const opened = row ? neo4j.int(row.get('opened')).toNumber() : 0;
    const merged = row ? neo4j.int(row.get('merged')).toNumber() : 0;
    const closed = row ? neo4j.int(row.get('closed')).toNumber() : 0;

    let sample: PullRequestStatsSample[] = [];
    if (limit > 0) {
      const res = await session.run(
        `MATCH (pr:PullRequest)
         WHERE ($author IS NULL OR pr.authorLogin = $author)
           AND datetime(pr.updatedAt) >= datetime($since)
           AND datetime(pr.updatedAt) <= datetime($until)
         RETURN pr
         ORDER BY pr.updatedAt DESC
         LIMIT toInteger($limit)`,
        { author: author ?? null, since: sinceIso, until: untilIso, limit },
      );
      sample = res.records.map((r) => {
        const pr = r.get('pr').properties as Record<string, unknown>;
        return {
          number: neo4j.int(pr.number as number).toNumber(),
          title: pr.title as string,
          url: pr.url as string,
          author: (pr.authorLogin as string | null) ?? null,
          state: pr.state as string,
          isDraft: Boolean(pr.isDraft),
          isMerged: Boolean(pr.isMerged),
          createdAt: pr.createdAt as string,
          updatedAt: pr.updatedAt as string,
          closedAt: (pr.closedAt as string | null) ?? null,
          mergedAt: (pr.mergedAt as string | null) ?? null,
        };
      });
    }

    return {
      author,
      window: { since: sinceIso, until: untilIso, days },
      opened,
      merged,
      closed,
      sample,
    };
  } finally {
    await session.close();
  }
}
