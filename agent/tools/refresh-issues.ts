import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { refreshIssues } from '../../src/services/issue-refresh';

export const refreshIssuesTool = createTool({
  id: 'refreshIssues',
  description:
    'Re-read issues from GitHub whose title, body, labels, or comments have ' +
    'changed since they were ingested. Use this when an issue has been edited ' +
    'or commented on, or when the graph disagrees with what the user sees on ' +
    'GitHub. Distinct from reconcileIssueState, which only syncs open and ' +
    'closed, and from ingestMissingIssues, which only adds issues the graph ' +
    'does not hold.',
  inputSchema: z.object({
    issueNumbers: z
      .array(z.number())
      .optional()
      .describe('Refresh exactly these. Omit to find every issue whose content has changed.'),
    refresh: z
      .boolean()
      .default(false)
      .describe('Re-read the stale issues. False only reports which ones changed.'),
    analyze: z
      .boolean()
      .default(false)
      .describe('Re-classify what was refreshed. Costs a model call per issue.'),
    limit: z.number().default(25).describe('Max issues to re-read in one call'),
  }),
  outputSchema: z.object({
    checked: z.number(),
    staleCount: z.number(),
    stale: z.array(z.number()),
    refreshed: z.array(z.number()),
    analyzed: z.number(),
    errors: z.array(z.string()),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (input) => {
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const empty = { checked: 0, staleCount: 0, stale: [], refreshed: [], analyzed: 0, errors: [] };

    if (!owner || !repo) {
      return {
        ...empty,
        message: 'Cannot refresh: the repository is not configured.',
        error: 'GITHUB_OWNER and GITHUB_REPO are not set',
      };
    }

    try {
      console.log(
        `  [refreshIssues] ${owner}/${repo} refresh=${input.refresh} scope=${input.issueNumbers?.length ?? 'all'}`,
      );
      const r = await refreshIssues({
        owner,
        repo,
        dryRun: !input.refresh,
        issueNumbers: input.issueNumbers,
        analyze: input.analyze,
        limit: input.limit,
      });

      const capped = r.stale.length > input.limit;
      const message =
        r.stale.length === 0
          ? `All ${r.checked} issues match GitHub. Nothing to re-read.`
          : input.refresh
            ? `Re-read ${r.refreshed.length} issue(s)${r.analyzed ? `, re-classified ${r.analyzed}` : ''}.${capped ? ` ${r.stale.length - r.refreshed.length} still stale; run again to continue.` : ''}`
            : `${r.stale.length} of ${r.checked} issues have changed on GitHub since they were ingested. Re-run with refresh to re-read them.`;

      console.log(`  [refreshIssues] stale=${r.stale.length} refreshed=${r.refreshed.length}`);

      return {
        checked: r.checked,
        staleCount: r.stale.length,
        stale: r.stale.map((s) => s.number),
        refreshed: r.refreshed,
        analyzed: r.analyzed,
        errors: r.errors,
        message,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [refreshIssues] error: ${msg}`);
      return { ...empty, message: 'Refresh failed.', error: msg };
    }
  },
});
