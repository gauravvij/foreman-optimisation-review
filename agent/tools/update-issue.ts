import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { applyIssueUpdate, getIssueSnapshot } from '../../src/services/issue-write';

export const updateIssueTool = createTool({
  id: 'updateIssue',
  description:
    'Change a single GitHub issue: retitle it, close or reopen it, change its ' +
    'assignees, or leave a comment, in any combination. This writes to the real ' +
    'repository. It always shows what it is about to do and waits for the user ' +
    'to confirm before writing. Only call this when the user has asked, in ' +
    'their own words, to change the issue.\n\n' +
    'Rules:\n' +
    '- Use addAssignees and removeAssignees for a request to assign or unassign ' +
    'a user, not a comment that only names the person.\n' +
    '- Closing an issue is not implied by learning that the work is finished: ' +
    'say what you would close and let the user ask for it.\n' +
    '- An open issue whose pull request already merged is probably finished. Say ' +
    'which ones and let the user decide; do not close one yourself.\n' +
    '- A comment about whether the work is worth doing belongs on the issue, ' +
    'through this tool. A comment about the code under review belongs on the ' +
    'pull request, through commentOnPullRequest. Do not post the same note to ' +
    'both.',
  inputSchema: z.object({
    issueNumber: z.number().describe('The issue to update'),
    title: z.string().optional().describe('New title. Omit to leave it unchanged.'),
    action: z.enum(['close', 'reopen']).optional().describe('Omit to leave the state alone.'),
    reason: z
      .enum(['completed', 'not_planned', 'duplicate'])
      .default('completed')
      .describe('Why it is being closed. Ignored when reopening.'),
    comment: z
      .string()
      .optional()
      .describe('Optional comment posted before the state change, explaining why'),
    addAssignees: z
      .array(z.string())
      .optional()
      .describe(
        'GitHub logins to assign (no leading @). An already-assigned login is a ' +
          'no-op. An unknown login fails before any write.',
      ),
    removeAssignees: z
      .array(z.string())
      .optional()
      .describe('GitHub logins to unassign. A login not currently assigned is a no-op.'),
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
    assigneesBefore: z.array(z.string()).default([]),
    assigneesAfter: z.array(z.string()).default([]),
    assigneesChanged: z.boolean().default(false),
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
      assigneesBefore: [] as string[],
      assigneesAfter: [] as string[],
      assigneesChanged: false,
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
          addAssignees: input.addAssignees,
          removeAssignees: input.removeAssignees,
        });
        const stateChanged = r.previousState !== r.newState;
        const parts: string[] = [];
        if (stateChanged) parts.push(`now ${r.newState.toLowerCase()}`);
        if (r.titleChanged) parts.push('retitled');
        if (r.assigneesChanged) {
          parts.push(
            r.assigneesAfter.length === 0
              ? 'unassigned'
              : `assigned to ${r.assigneesAfter.map((l) => `@${l}`).join(', ')}`,
          );
        }
        if (r.commented) parts.push('comment posted');
        const summary = parts.length > 0 ? parts.join(', ') : 'no changes needed';
        return {
          issueNumber: r.number,
          title: r.title,
          previousState: r.previousState,
          newState: r.newState,
          commented: r.commented,
          assigneesBefore: r.assigneesBefore,
          assigneesAfter: r.assigneesAfter,
          assigneesChanged: r.assigneesChanged,
          graphUpdated: r.graphUpdated,
          confirmed: true,
          message: `#${r.number}: ${summary}.`,
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

    const currentLogins = snapshot.assignees.map((a) => a.login);
    const toAdd = (input.addAssignees ?? []).filter((l) => !currentLogins.includes(l));
    const toRemove = (input.removeAssignees ?? []).filter((l) => currentLogins.includes(l));
    const assigneesChanged = toAdd.length > 0 || toRemove.length > 0;

    if (!titleChanged && !stateChanged && !input.comment && !assigneesChanged) {
      return {
        ...base,
        title: snapshot.title,
        previousState: snapshot.state,
        newState: snapshot.state,
        assigneesBefore: currentLogins,
        assigneesAfter: currentLogins,
        message: `#${input.issueNumber} already matches what you asked for. Nothing to do.`,
      };
    }

    const changes: string[] = [];
    if (titleChanged) {
      changes.push(`  title: "${snapshot.title}"\n      -> "${wantedTitle}"`);
    }
    if (stateChanged) {
      const wanted = input.action === 'close' ? 'CLOSED' : 'OPEN';
      const closeNote = input.action === 'close' ? ` (${input.reason})` : '';
      changes.push(`  state: ${snapshot.state} -> ${wanted}${closeNote}`);
    }
    if (assigneesChanged) {
      const before =
        currentLogins.length > 0 ? currentLogins.map((l) => `@${l}`).join(', ') : '(none)';
      const after = [...currentLogins.filter((l) => !toRemove.includes(l)), ...toAdd];
      const afterStr = after.length > 0 ? after.map((l) => `@${l}`).join(', ') : '(none)';
      changes.push(`  assignees: ${before}\n      -> ${afterStr}`);
    }
    if (input.comment) {
      changes.push(`  comment: ${input.comment}`);
    }

    console.log(`  [updateIssue] suspending for confirmation on #${input.issueNumber}`);

    // The confirmation always names the issue title. Confirming a bare number is
    // how you close the wrong thing.
    const message = [
      `About to change issue #${snapshot.number} in ${owner}/${repo}:`,
      '',
      `  "${snapshot.title}"`,
      '',
      changes.join('\n'),
      '',
      'This writes to the real repository. Confirm to proceed.',
    ].join('\n');

    await ctx.agent!.suspend({
      message,
      issueNumber: snapshot.number,
      action: input.action ?? 'retitle',
    });

    return {
      ...base,
      title: snapshot.title,
      previousState: snapshot.state,
      assigneesBefore: currentLogins,
      assigneesAfter: currentLogins,
      message: 'Waiting for confirmation before writing to GitHub.',
    };
  },
});
