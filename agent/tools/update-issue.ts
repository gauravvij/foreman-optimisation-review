import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { applyIssueUpdate, getIssueSnapshot } from '../../src/services/issue-write';

export const updateIssueTool = createTool({
  id: 'updateIssue',
  description:
    'Change a single GitHub issue: retitle it, close or reopen it, or leave a ' +
    'comment, in any combination. This writes to the real repository. It always ' +
    'shows what it is about to do and waits for the user to confirm before ' +
    'writing. Only call this when the user has asked, in their own words, to ' +
    'change the issue.',
  inputSchema: z.object({
    issueNumber: z.number().describe('The issue to update'),
    title: z.string().optional().describe('New title. Omit to leave it unchanged.'),
    action: z
      .enum(['close', 'reopen'])
      .optional()
      .describe('Omit to leave the state alone and only retitle or comment.'),
    reason: z
      .enum(['completed', 'not_planned', 'duplicate'])
      .default('completed')
      .describe('Why it is being closed. Ignored when reopening.'),
    comment: z
      .string()
      .optional()
      .describe('Optional comment posted before the state change, explaining why'),
  }),
  suspendSchema: z.object({
    message: z.string(),
    issueNumber: z.number(),
    action: z.string(),
  }),
  resumeSchema: z.object({
    confirm: z.boolean().describe('Set true to write this change to GitHub. False cancels.'),
  }),
  outputSchema: z.object({
    issueNumber: z.number(),
    title: z.string(),
    previousState: z.string(),
    newState: z.string(),
    commented: z.boolean(),
    graphUpdated: z.boolean(),
    confirmed: z.boolean(),
    message: z.string(),
    error: z.string().optional(),
  }),
  execute: async (input, ctx) => {
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const base = {
      issueNumber: input.issueNumber,
      title: '',
      previousState: '',
      newState: '',
      commented: false,
      graphUpdated: false,
      confirmed: false,
    };

    if (!owner || !repo) {
      return {
        ...base,
        message: 'Cannot update the issue: the repository is not configured.',
        error: 'GITHUB_OWNER and GITHUB_REPO are not set',
      };
    }

    const resumeData = ctx?.agent?.resumeData as { confirm?: boolean } | undefined;

    if (resumeData?.confirm === true) {
      try {
        console.log(`  [updateIssueState] confirmed, ${input.action} #${input.issueNumber}`);
        const r = await applyIssueUpdate({
          owner,
          repo,
          number: input.issueNumber,
          title: input.title,
          action: input.action,
          reason: input.reason,
          comment: input.comment,
        });
        return {
          issueNumber: r.number,
          title: r.title,
          previousState: r.previousState,
          newState: r.newState,
          commented: r.commented,
          graphUpdated: r.graphUpdated,
          confirmed: true,
          message:
            r.previousState === r.newState
              ? `#${r.number} was already ${r.newState.toLowerCase()}. Nothing changed on GitHub.`
              : `#${r.number} is now ${r.newState.toLowerCase()}${r.commented ? ', with your comment posted' : ''}. Graph updated.`,
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  [updateIssueState] error: ${msg}`);
        return { ...base, message: 'The update failed.', error: msg };
      }
    }

    if (resumeData) {
      console.log('  [updateIssueState] declined, nothing written');
      return { ...base, message: 'Cancelled. Nothing was written to GitHub.' };
    }

    // Read the live issue first: confirming against a stale state is how you
    // close the wrong thing, or ask about a change that is already done.
    let snapshot: Awaited<ReturnType<typeof getIssueSnapshot>>;
    try {
      snapshot = await getIssueSnapshot(owner, repo, input.issueNumber);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ...base, message: 'Could not read the issue.', error: msg };
    }

    if (!snapshot) {
      return {
        ...base,
        message: `Issue #${input.issueNumber} does not exist in ${owner}/${repo}.`,
        error: 'issue not found',
      };
    }

    if (!snapshot.viewerCanUpdate) {
      return {
        ...base,
        title: snapshot.title,
        previousState: snapshot.state,
        message: `The configured token cannot modify #${input.issueNumber}. It needs issues:write on ${owner}/${repo}.`,
        error: 'insufficient permission',
      };
    }

    const wantedTitle = input.title?.trim();
    const titleChanged = !!wantedTitle && wantedTitle !== snapshot.title;
    const stateChanged =
      !!input.action && snapshot.state !== (input.action === 'close' ? 'CLOSED' : 'OPEN');

    if (!titleChanged && !stateChanged && !input.comment) {
      return {
        ...base,
        title: snapshot.title,
        previousState: snapshot.state,
        newState: snapshot.state,
        message: `#${input.issueNumber} already matches what you asked for. Nothing to do.`,
      };
    }

    const changes: string[] = [];
    if (titleChanged) {
      changes.push(`  title: "${snapshot.title}"\n      -> "${wantedTitle}"`);
    }
    if (stateChanged) {
      const wanted = input.action === 'close' ? 'CLOSED' : 'OPEN';
      changes.push(
        `  state: ${snapshot.state} -> ${wanted}` +
          (input.action === 'close' ? ` (${input.reason})` : ''),
      );
    }
    if (input.comment) {
      changes.push(`  comment: ${input.comment}`);
    }

    console.log(`  [updateIssue] suspending for confirmation on #${input.issueNumber}`);

    await ctx.agent!.suspend({
      message:
        `About to change issue #${snapshot.number} in ${owner}/${repo}:\n\n` +
        // Always name the issue, even when only the state changes: confirming a
        // bare number is how you close the wrong thing.
        `  "${snapshot.title}"\n\n` +
        `${changes.join('\n')}\n\n` +
        'This writes to the real repository. Confirm to proceed.',
      issueNumber: snapshot.number,
      action: input.action ?? 'retitle',
    });

    return {
      ...base,
      title: snapshot.title,
      previousState: snapshot.state,
      message: 'Waiting for confirmation before writing to GitHub.',
    };
  },
});
