import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { refreshAllPullRequests } from '../../src/services/pull-request-stats';

export const refreshPullRequestsTool = createTool({
  id: 'refreshPullRequests',
  description:
    'Pull every pull request from GitHub and upsert each into the graph, ' +
    "ignoring the scheduled sync's lastPullRequestSync filter. Use this when " +
    'a point-in-time pull request total (open, closed, by author) disagrees ' +
    'with what the user sees on GitHub, which happens for pull requests ' +
    'opened long ago and not touched since the last incremental sync fetched ' +
    'them. One-shot reconciliation, not a routine refresh.',
  inputSchema: z.object({
    refresh: z
      .boolean()
      .default(false)
      .describe('Fetch and upsert. False only reports the gap, no writes.'),
    limit: z.number().int().min(0).default(0).describe('Max pull requests to fetch (0 = all).'),
  }),
  outputSchema: z.object({
    graphBefore: z.number(),
    fetched: z.number(),
    ingested: z.number(),
    gap: z.number(),
    errors: z.array(z.string()),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (input) => {
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const empty = { graphBefore: 0, fetched: 0, ingested: 0, gap: 0, errors: [] };

    if (!owner || !repo) {
      return {
        ...empty,
        message: 'Cannot refresh pull requests: the repository is not configured.',
        error: 'GITHUB_OWNER and GITHUB_REPO are not set',
      };
    }

    try {
      console.log(
        `  [refreshPullRequests] ${owner}/${repo} refresh=${input.refresh} limit=${input.limit}`,
      );
      const r = await refreshAllPullRequests({
        owner,
        repo,
        dryRun: !input.refresh,
        limit: input.limit,
      });

      const gap = Math.max(r.fetched - r.graphBefore, 0);
      const errorStrings = r.errors.map((e) => `#${e.number}: ${e.error}`);
      const message = input.refresh
        ? `Reconciled ${r.ingested} pull request(s). Graph went from ${r.graphBefore} to ${r.graphBefore + gap}.`
        : `GitHub holds ${r.fetched} pull request(s); the graph holds ${r.graphBefore}. ${gap} are new. Re-run with refresh to upsert them.`;

      return {
        graphBefore: r.graphBefore,
        fetched: r.fetched,
        ingested: r.ingested,
        gap,
        errors: errorStrings,
        message,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [refreshPullRequests] error: ${msg}`);
      return { ...empty, message: 'Refresh failed.', error: msg };
    }
  },
});
