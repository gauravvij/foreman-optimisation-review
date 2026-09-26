import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { reconcileIssueState } from '../../src/services/issue-state';

export const reconcileIssueStateTool = createTool({
  id: 'reconcileIssueState',
  description:
    'Check every issue in the graph against GitHub and report which ones have a ' +
    'stale open/closed state, optionally correcting them. Writes only to the ' +
    'graph, never to GitHub. Use this when counts look wrong, when an issue the ' +
    'graph calls open turns out to be closed, or before trusting a state filter.',
  inputSchema: z.object({
    apply: z
      .boolean()
      .default(false)
      .describe('Write the corrections. False reports the drift without changing anything.'),
  }),
  outputSchema: z.object({
    checked: z.number(),
    resolved: z.number(),
    driftCount: z.number(),
    applied: z.number(),
    drift: z.array(
      z.object({
        number: z.number(),
        storedState: z.string(),
        liveState: z.string(),
        closedAt: z.string().nullable(),
      }),
    ),
    unresolved: z.array(z.number()),
    ghosts: z.array(z.number()),
    ghostsKept: z.array(z.number()),
    deleted: z.number(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (input) => {
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const empty = {
      checked: 0,
      resolved: 0,
      driftCount: 0,
      applied: 0,
      drift: [],
      unresolved: [],
      ghosts: [],
      ghostsKept: [],
      deleted: 0,
    };

    if (!owner || !repo) {
      return {
        ...empty,
        message: 'Cannot reconcile: the repository is not configured.',
        error: 'GITHUB_OWNER and GITHUB_REPO are not set',
      };
    }

    try {
      console.log(`  [reconcileIssueState] ${owner}/${repo} apply=${input.apply}`);
      const r = await reconcileIssueState({ owner, repo, dryRun: !input.apply });

      const ghostNote =
        r.ghosts.length === 0
          ? ''
          : input.apply
            ? ` Removed ${r.deleted} issue(s) GitHub no longer has: ${r.ghosts.join(', ')}.` +
              (r.ghostsKept.length > 0
                ? ` Kept ${r.ghostsKept.join(', ')} because a recorded assessment would be lost with them.`
                : '')
            : ` ${r.ghosts.length} issue(s) do not exist on GitHub: ${r.ghosts.join(', ')}. Re-run with apply to remove them.`;

      const unresolvedNote =
        r.unresolved.length === 0
          ? ''
          : ` ${r.unresolved.length} issue(s) could not be checked and were left alone.`;

      const stateNote =
        r.drift.length === 0
          ? r.ghosts.length === 0
            ? `All ${r.checked} issues match GitHub. Nothing to correct.`
            : `All ${r.checked} issues that still exist match GitHub.`
          : input.apply
            ? `Corrected ${r.applied} of ${r.checked} issues.`
            : `${r.drift.length} of ${r.checked} issues have a stale state. Re-run with apply to correct them.`;

      const message = `${stateNote}${ghostNote}${unresolvedNote}`;

      console.log(
        `  [reconcileIssueState] drift=${r.drift.length} applied=${r.applied} ghosts=${r.ghosts.length} deleted=${r.deleted}`,
      );

      return {
        checked: r.checked,
        resolved: r.resolved,
        driftCount: r.drift.length,
        applied: r.applied,
        drift: r.drift,
        unresolved: r.unresolved,
        ghosts: r.ghosts,
        ghostsKept: r.ghostsKept,
        deleted: r.deleted,
        message,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [reconcileIssueState] error: ${msg}`);
      return { ...empty, message: 'Reconcile failed.', error: msg };
    }
  },
});
