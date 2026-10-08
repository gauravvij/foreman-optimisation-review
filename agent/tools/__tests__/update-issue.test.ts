import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getIssueSnapshot, applyIssueUpdate } = vi.hoisted(() => ({
  getIssueSnapshot: vi.fn(),
  applyIssueUpdate: vi.fn(),
}));

vi.mock('../../../src/services/issue-write', () => ({ getIssueSnapshot, applyIssueUpdate }));

import { updateIssueTool } from '../update-issue';

type Result = {
  previousState: string;
  newState: string;
  confirmed: boolean;
  message: string;
  error?: string;
};

const suspend = vi.fn();

function ctxWith(resumeData?: { confirm: boolean }) {
  return { agent: { suspend, resumeData } } as unknown as Parameters<
    NonNullable<typeof updateIssueTool.execute>
  >[1];
}

const OPEN = {
  id: 'I_1',
  number: 798,
  title: 'A real issue',
  state: 'OPEN',
  viewerCanUpdate: true,
  assignees: [] as { id: string; login: string }[],
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GITHUB_OWNER = 'acme';
  process.env.GITHUB_REPO = 'widgets';
  getIssueSnapshot.mockResolvedValue(OPEN);
});

describe('updateIssueTool', () => {
  it('suspends for confirmation and writes nothing on the first call', async () => {
    const r = (await updateIssueTool.execute!(
      { issueNumber: 798, action: 'close', reason: 'completed' },
      ctxWith(),
    )) as Result;

    expect(suspend, 'a GitHub write must be confirmed first').toHaveBeenCalledTimes(1);
    expect(applyIssueUpdate).not.toHaveBeenCalled();
    expect(r.confirmed).toBe(false);
  });

  it('shows the issue title and the transition in the confirmation', async () => {
    await updateIssueTool.execute!(
      { issueNumber: 798, action: 'close', reason: 'completed' },
      ctxWith(),
    );

    const msg = suspend.mock.calls[0][0].message;
    expect(msg, 'the user must see which issue, not just a number').toContain('A real issue');
    expect(msg).toContain('#798');
    expect(msg).toContain('OPEN -> CLOSED');
    expect(msg).toContain('acme/widgets');
  });

  it('writes nothing when the user declines', async () => {
    const r = (await updateIssueTool.execute!(
      { issueNumber: 798, action: 'close', reason: 'completed' },
      ctxWith({ confirm: false }),
    )) as Result;

    expect(applyIssueUpdate).not.toHaveBeenCalled();
    expect(suspend, 'a decline must not re-prompt').not.toHaveBeenCalled();
    expect(r.message).toContain('Cancelled');
  });

  it('writes only after an explicit confirm', async () => {
    applyIssueUpdate.mockResolvedValue({
      number: 798,
      title: 'A real issue',
      previousState: 'OPEN',
      newState: 'CLOSED',
      commented: false,
      graphUpdated: true,
    });

    const r = (await updateIssueTool.execute!(
      { issueNumber: 798, action: 'close', reason: 'completed' },
      ctxWith({ confirm: true }),
    )) as Result;

    expect(applyIssueUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'acme', repo: 'widgets', number: 798, action: 'close' }),
    );
    expect(r.confirmed).toBe(true);
    expect(r.newState).toBe('CLOSED');
  });

  it('refuses when the token cannot modify the issue', async () => {
    getIssueSnapshot.mockResolvedValue({ ...OPEN, viewerCanUpdate: false });

    const r = (await updateIssueTool.execute!(
      { issueNumber: 798, action: 'close', reason: 'completed' },
      ctxWith(),
    )) as Result;

    expect(
      suspend,
      'do not ask the user to confirm something that cannot work',
    ).not.toHaveBeenCalled();
    expect(applyIssueUpdate).not.toHaveBeenCalled();
    expect(r.error).toBe('insufficient permission');
  });

  it('retitles without touching the state when no action is given', async () => {
    applyIssueUpdate.mockResolvedValue({
      number: 798,
      title: 'New title',
      previousTitle: 'A real issue',
      titleChanged: true,
      previousState: 'OPEN',
      newState: 'OPEN',
      commented: false,
      graphUpdated: true,
    });

    await updateIssueTool.execute!(
      { issueNumber: 798, title: 'New title', reason: 'completed' },
      ctxWith({ confirm: true }),
    );

    expect(applyIssueUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'New title', action: undefined }),
    );
  });

  it('shows the old and new title in the confirmation', async () => {
    await updateIssueTool.execute!(
      { issueNumber: 798, title: 'New title', reason: 'completed' },
      ctxWith(),
    );

    const msg = suspend.mock.calls[0][0].message;
    expect(msg, 'the user must see what the title becomes').toContain('New title');
    expect(msg).toContain('A real issue');
  });

  it('does not prompt when the issue is already in the requested state', async () => {
    getIssueSnapshot.mockResolvedValue({ ...OPEN, state: 'CLOSED' });

    const r = (await updateIssueTool.execute!(
      { issueNumber: 798, action: 'close', reason: 'completed' },
      ctxWith(),
    )) as Result;

    expect(suspend).not.toHaveBeenCalled();
    expect(applyIssueUpdate).not.toHaveBeenCalled();
    expect(r.message).toContain('already matches what you asked for');
  });

  it('reports a missing issue instead of prompting to close it', async () => {
    getIssueSnapshot.mockResolvedValue(null);

    const r = (await updateIssueTool.execute!(
      { issueNumber: 99999, action: 'close', reason: 'completed' },
      ctxWith(),
    )) as Result;

    expect(suspend).not.toHaveBeenCalled();
    expect(r.error).toBe('issue not found');
  });

  it('surfaces the comment in the confirmation when one is supplied', async () => {
    await updateIssueTool.execute!(
      { issueNumber: 798, action: 'close', reason: 'completed', comment: 'Shipped in #123.' },
      ctxWith(),
    );

    expect(suspend.mock.calls[0][0].message).toContain('Shipped in #123.');
  });

  it('shows the assignee change in the confirmation preview', async () => {
    getIssueSnapshot.mockResolvedValue({
      ...OPEN,
      assignees: [{ id: 'U_jane', login: 'jane' }],
    });

    await updateIssueTool.execute!(
      { issueNumber: 798, reason: 'completed', addAssignees: ['chris'], removeAssignees: ['jane'] },
      ctxWith(),
    );

    const msg = suspend.mock.calls[0][0].message;
    expect(msg, 'the before set is visible').toContain('@jane');
    expect(msg, 'the after set is visible').toContain('@chris');
  });

  it('passes addAssignees and removeAssignees through to the service', async () => {
    applyIssueUpdate.mockResolvedValue({
      number: 798,
      title: 'A real issue',
      previousTitle: 'A real issue',
      titleChanged: false,
      previousState: 'OPEN',
      newState: 'OPEN',
      commented: false,
      assigneesBefore: [],
      assigneesAfter: ['chris'],
      assigneesChanged: true,
      graphUpdated: true,
    });

    const r = (await updateIssueTool.execute!(
      { issueNumber: 798, reason: 'completed', addAssignees: ['chris'] },
      ctxWith({ confirm: true }),
    )) as Result & { assigneesAfter: string[]; assigneesChanged: boolean };

    expect(applyIssueUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ addAssignees: ['chris'] }),
    );
    expect(r.assigneesAfter).toEqual(['chris']);
    expect(r.message).toContain('@chris');
  });

  it('does not prompt when the only requested assignee is already there', async () => {
    getIssueSnapshot.mockResolvedValue({
      ...OPEN,
      assignees: [{ id: 'U_chris', login: 'chris' }],
    });

    const r = (await updateIssueTool.execute!(
      { issueNumber: 798, reason: 'completed', addAssignees: ['chris'] },
      ctxWith(),
    )) as Result;

    expect(suspend, 'a no-op must not ask for confirmation').not.toHaveBeenCalled();
    expect(applyIssueUpdate).not.toHaveBeenCalled();
    expect(r.message).toContain('already matches');
  });

  it('reports a missing repo instead of guessing one', async () => {
    process.env.GITHUB_OWNER = '';
    process.env.GITHUB_REPO = '';

    const r = (await updateIssueTool.execute!(
      { issueNumber: 798, action: 'close', reason: 'completed' },
      ctxWith(),
    )) as Result;

    expect(getIssueSnapshot).not.toHaveBeenCalled();
    expect(r.error).toContain('GITHUB_OWNER');
  });
});
