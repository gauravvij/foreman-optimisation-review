import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSession, mockDriver, mockOpenAICreate } = vi.hoisted(() => {
  const mockSession = {
    run: vi.fn(),
    close: vi.fn(),
  };
  const mockDriver = {
    session: vi.fn(() => mockSession),
  };
  const mockOpenAICreate = vi.fn();
  return { mockSession, mockDriver, mockOpenAICreate };
});

vi.mock('../../../src/services/neo4j', () => ({
  getDriver: vi.fn(() => mockDriver),
}));

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: { completions: { create: mockOpenAICreate } },
  })),
}));

import { fitComments, summarizeCommentsTool } from '../summarize-comments';

type SummaryResult = {
  summary: string;
  commentCount: number;
  truncated?: boolean;
  error?: string;
};

const ctx = {} as Parameters<NonNullable<typeof summarizeCommentsTool.execute>>[1];

beforeEach(() => {
  // `clearAllMocks` only clears recorded calls; it leaves queued
  // `mockResolvedValueOnce` values in place, so a 500-record response from one
  // test would be handed to the next. Reset the two per-test mocks outright.
  mockSession.run.mockReset();
  mockOpenAICreate.mockReset();
  mockSession.close.mockClear();
  // Env stubs are process-wide and survive clearAllMocks, so a test that sets
  // SUMMARIZE_COMMENT_LIMIT would otherwise leak into every later test.
  vi.unstubAllEnvs();
  vi.stubEnv('ASTRO_GATEWAY_URL', 'https://aig.test');
  vi.stubEnv('ASTRO_GATEWAY_API_KEY', 'gw-key');
});

function fakeRecord(data: Record<string, unknown>) {
  const keys = Object.keys(data);
  return {
    keys,
    get: (key: string) => data[key],
  };
}

describe('summarizeCommentsTool', () => {
  it('returns "no comments" when issue has no comments', async () => {
    mockSession.run.mockResolvedValueOnce({ records: [] });

    const result = (await summarizeCommentsTool.execute!(
      { issueNumber: 999 },
      ctx,
    )) as SummaryResult;

    expect(result).toEqual({
      summary: 'No comments found for issue #999.',
      commentCount: 0,
    });
    expect(mockOpenAICreate).not.toHaveBeenCalled();
  });

  it('fetches comments and calls the model for a summary', async () => {
    mockSession.run.mockResolvedValueOnce({
      records: [
        fakeRecord({ text: 'This is broken', date: '2025-01-01', author: 'alice' }),
        fakeRecord({ text: 'Me too', date: '2025-01-02', author: 'bob' }),
      ],
    });
    mockOpenAICreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Users report a bug affecting multiple people.' } }],
    });

    const result = (await summarizeCommentsTool.execute!(
      { issueNumber: 42 },
      ctx,
    )) as SummaryResult;

    expect(result).toEqual({
      summary: 'Users report a bug affecting multiple people.',
      commentCount: 2,
    });
    expect(mockOpenAICreate).toHaveBeenCalledTimes(1);

    const callArgs = mockOpenAICreate.mock.calls[0][0];
    expect(callArgs.model, 'summaries run on the cheap tier').toBe('claude-haiku-4-5');
    expect(callArgs.messages[1].content).toContain('[alice — 2025-01-01]: This is broken');
    expect(callArgs.messages[1].content).toContain('[bob — 2025-01-02]: Me too');
  });

  it('passes userQuery to the summary prompt', async () => {
    mockSession.run.mockResolvedValueOnce({
      records: [
        fakeRecord({ text: 'We switched to competitor X', date: '2025-03-01', author: 'carol' }),
      ],
    });
    mockOpenAICreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'One user mentioned switching to competitor X.' } }],
    });

    const result = (await summarizeCommentsTool.execute!(
      { issueNumber: 7, userQuery: 'competitor mentions' },
      ctx,
    )) as SummaryResult;

    expect(result.summary).toBe('One user mentioned switching to competitor X.');
    const prompt = mockOpenAICreate.mock.calls[0][0].messages[1].content as string;
    expect(prompt).toContain('focusing on: competitor mentions');
  });

  it('handles null author gracefully', async () => {
    mockSession.run.mockResolvedValueOnce({
      records: [fakeRecord({ text: 'Anonymous feedback', date: '2025-02-01', author: null })],
    });
    mockOpenAICreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Summary of anonymous feedback.' } }],
    });

    const result = (await summarizeCommentsTool.execute!({ issueNumber: 5 }, ctx)) as SummaryResult;

    expect(result.commentCount).toBe(1);
    const prompt = mockOpenAICreate.mock.calls[0][0].messages[1].content as string;
    expect(prompt).toContain('[unknown — 2025-02-01]: Anonymous feedback');
  });

  // -------------------------------------------------------------------------
  // Regression: the summary must be anchored on the issue, not on whichever
  // comment sub-thread happens to be most quotable.
  //
  // dev-038 asked for a summary of #5111, whose title is "map and filter not
  // working properly in multiprocessing with the new release 2.6.0". One
  // comment carries a minimum-reproducible-example that loads
  // `copenlu/answerable_tydiqa`, and the pre-fix tool — which fetched only
  // comments and never the title or body — produced a summary about that
  // dataset instead of the reported bug. Same shape for dev-040 / #3504.
  // -------------------------------------------------------------------------

  it('fetches the issue title and body alongside the comments', async () => {
    mockSession.run.mockResolvedValueOnce({
      records: [
        fakeRecord({
          issueTitle: 'map and filter not working properly in multiprocessing',
          issueBody: 'When mapping is used on a dataset with more than one process...',
          text: 'Minimum reproducible example using copenlu/answerable_tydiqa',
          date: '2022-10-13',
          author: 'loubnabnl',
        }),
      ],
    });
    mockOpenAICreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'A multiprocessing bug in map/filter.' } }],
    });

    await summarizeCommentsTool.execute!({ issueNumber: 5111 }, ctx);

    const cypher = mockSession.run.mock.calls[0][0] as string;
    expect(cypher, 'the issue title must be selected').toContain('i.title AS issueTitle');
    expect(cypher, 'the issue body must be selected').toContain('i.bodyText AS issueBody');
    expect(cypher, 'the issue must be matched before its comments').toMatch(
      /MATCH \(i:Issue \{number: \$n\}\)/,
    );
  });

  it('anchors the summary prompt on the issue title and body', async () => {
    mockSession.run.mockResolvedValueOnce({
      records: [
        fakeRecord({
          issueTitle: 'map and filter not working properly in multiprocessing',
          issueBody: 'When mapping is used on a dataset with more than one process, filter misbehaves.',
          text: 'Minimum reproducible example using copenlu/answerable_tydiqa',
          date: '2022-10-13',
          author: 'loubnabnl',
        }),
      ],
    });
    mockOpenAICreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'A multiprocessing bug in map/filter.' } }],
    });

    await summarizeCommentsTool.execute!({ issueNumber: 5111 }, ctx);

    const prompt = mockOpenAICreate.mock.calls[0][0].messages[1].content as string;
    expect(prompt, 'the issue number must be named').toContain('#5111');
    expect(prompt, 'the issue title must anchor the summary').toContain(
      'map and filter not working properly in multiprocessing',
    );
    expect(prompt, 'the issue body must anchor the summary').toContain(
      'filter misbehaves',
    );
    expect(prompt, 'the model must be told the comments are detail, not the subject').toMatch(
      /not the subject of the issue/,
    );
    // The comments are still supplied — the anchor is added, not substituted.
    expect(prompt).toContain('copenlu/answerable_tydiqa');
  });

  it('still summarizes when the issue has a title but no body', async () => {
    mockSession.run.mockResolvedValueOnce({
      records: [
        fakeRecord({
          issueTitle: 'Unable to download PUBMED_title_abstracts_2019_baseline.jsonl.zst',
          issueBody: null,
          text: 'I was able to find a torrent with The Pile dataset',
          date: '2021-12-30',
          author: 'someone',
        }),
      ],
    });
    mockOpenAICreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'A broken download URL.' } }],
    });

    const result = (await summarizeCommentsTool.execute!(
      { issueNumber: 3504 },
      ctx,
    )) as SummaryResult;

    expect(result.commentCount).toBe(1);
    const prompt = mockOpenAICreate.mock.calls[0][0].messages[1].content as string;
    expect(prompt).toContain('PUBMED_title_abstracts_2019_baseline.jsonl.zst');
    expect(prompt).not.toContain('Its body states the problem as');
  });

  it('does not count the anchor row as a comment when the issue has none', async () => {
    // OPTIONAL MATCH yields one row with a null comment when there are no
    // comments; that row must not be reported as a comment.
    mockSession.run.mockResolvedValueOnce({
      records: [
        fakeRecord({
          issueTitle: 'An issue with no discussion',
          issueBody: 'Body text',
          text: null,
          date: null,
          author: null,
        }),
      ],
    });

    const result = (await summarizeCommentsTool.execute!(
      { issueNumber: 123 },
      ctx,
    )) as SummaryResult;

    expect(result).toEqual({
      summary: 'No comments found for issue #123.',
      commentCount: 0,
    });
    expect(mockOpenAICreate).not.toHaveBeenCalled();
  });

  it('always closes the session even when Neo4j fails', async () => {
    mockSession.run.mockRejectedValueOnce(new Error('connection lost'));

    await expect(summarizeCommentsTool.execute!({ issueNumber: 1 }, ctx)).rejects.toThrow(
      'connection lost',
    );

    expect(mockSession.close).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Bounding. The query used to have no LIMIT and the prompt no cap: every
  // comment body on the issue went into one completion. The bench corpus tops
  // out at 20 comments per issue so it never bit there, but a real 500-comment
  // issue would blow the context window and the budget in a single call.
  // -------------------------------------------------------------------------

  it('bounds the Cypher read with a LIMIT parameter', async () => {
    mockSession.run.mockResolvedValueOnce({ records: [] });

    await summarizeCommentsTool.execute!({ issueNumber: 1 }, ctx);

    const cypher = mockSession.run.mock.calls[0][0] as string;
    expect(cypher, 'the read must be bounded').toMatch(/LIMIT \$limit/);
    const params = mockSession.run.mock.calls[0][1] as { limit: { toNumber(): number } };
    expect(params.limit.toNumber(), 'default limit is 200').toBe(200);
  });

  it('honours SUMMARIZE_COMMENT_LIMIT', async () => {
    vi.stubEnv('SUMMARIZE_COMMENT_LIMIT', '7');
    mockSession.run.mockResolvedValueOnce({ records: [] });

    await summarizeCommentsTool.execute!({ issueNumber: 1 }, ctx);

    const params = mockSession.run.mock.calls[0][1] as { limit: { toNumber(): number } };
    expect(params.limit.toNumber()).toBe(7);
  });

  it('rejects a non-positive SUMMARIZE_COMMENT_LIMIT rather than silently unbounded', async () => {
    vi.stubEnv('SUMMARIZE_COMMENT_LIMIT', '0');
    mockSession.run.mockResolvedValueOnce({ records: [] });

    await expect(summarizeCommentsTool.execute!({ issueNumber: 1 }, ctx)).rejects.toThrow(
      /SUMMARIZE_COMMENT_LIMIT must be a positive integer/,
    );
  });

  it('keeps the prompt under the cap and reports truncated for a 500-comment thread', async () => {
    // 500 comments of ~200 chars each ≈ 100k chars of comment text, well past
    // the 40k default cap.
    const records = Array.from({ length: 500 }, (_, i) =>
      fakeRecord({
        issueTitle: 'A very long thread',
        issueBody: 'The reported problem.',
        text: `comment number ${i} ${'x'.repeat(180)}`,
        date: `2024-01-${String((i % 28) + 1).padStart(2, '0')}`,
        author: `user${i}`,
      }),
    );
    mockSession.run.mockResolvedValueOnce({ records });
    mockOpenAICreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'A long discussion.' } }],
    });

    const result = (await summarizeCommentsTool.execute!(
      { issueNumber: 1 },
      ctx,
    )) as SummaryResult;

    const prompt = mockOpenAICreate.mock.calls[0][0].messages[1].content as string;
    expect(prompt.length, 'prompt must stay within the 40k cap').toBeLessThanOrEqual(40_000);
    expect(result.truncated, 'truncation must be reported').toBe(true);
    expect(result.commentCount, 'the read count is still reported').toBe(500);
    // The anchor survives truncation.
    expect(prompt).toContain('A very long thread');
    expect(prompt).toContain('The reported problem.');
    // The newest comments are retained in full.
    expect(prompt).toContain('comment number 499');
    expect(prompt).toContain('comment number 498');
    // The earliest comments are kept for context.
    expect(prompt).toContain('comment number 0 ');
    // The model is told it is reading an excerpt.
    expect(prompt).toMatch(/comments omitted to stay within the prompt budget/);
  });

  it('does not report truncated for a short thread', async () => {
    mockSession.run.mockResolvedValueOnce({
      records: [
        fakeRecord({
          issueTitle: 'Short',
          issueBody: 'Body',
          text: 'one comment',
          date: '2024-01-01',
          author: 'a',
        }),
      ],
    });
    mockOpenAICreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Short summary.' } }],
    });

    const result = (await summarizeCommentsTool.execute!(
      { issueNumber: 1 },
      ctx,
    )) as SummaryResult;

    expect(result.truncated).toBeUndefined();
  });

  it('honours SUMMARIZE_PROMPT_CHAR_CAP', async () => {
    vi.stubEnv('SUMMARIZE_PROMPT_CHAR_CAP', '2000');
    const records = Array.from({ length: 100 }, (_, i) =>
      fakeRecord({
        issueTitle: 'Tight cap',
        issueBody: 'Body',
        text: `c${i} ${'y'.repeat(100)}`,
        date: '2024-01-01',
        author: `u${i}`,
      }),
    );
    mockSession.run.mockResolvedValueOnce({ records });
    mockOpenAICreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'ok' } }],
    });

    const result = (await summarizeCommentsTool.execute!(
      { issueNumber: 1 },
      ctx,
    )) as SummaryResult;

    const prompt = mockOpenAICreate.mock.calls[0][0].messages[1].content as string;
    expect(prompt.length).toBeLessThanOrEqual(2000);
    expect(result.truncated).toBe(true);
    expect(prompt).toContain('c99 ');
  });
});

describe('fitComments', () => {
  const mk = (n: number, len = 100) =>
    Array.from({ length: n }, (_, i) => ({
      author: `u${i}`,
      date: '2024-01-01',
      text: `m${i} ${'z'.repeat(len)}`,
    }));

  it('returns the thread untouched when it fits', () => {
    const { text, omitted } = fitComments(mk(3), 10_000);
    expect(omitted).toBe(0);
    expect(text).toContain('m0 ');
    expect(text).toContain('m2 ');
    expect(text).not.toContain('omitted');
  });

  it('keeps head and tail and marks the gap when it does not fit', () => {
    const { text, omitted } = fitComments(mk(100), 3_000);
    expect(omitted).toBeGreaterThan(0);
    expect(text).toContain('m0 ');
    expect(text).toContain('m99 ');
    expect(text).toMatch(/comments omitted/);
    expect(text.length).toBeLessThanOrEqual(3_000 + 200);
  });

  it('never drops the newest comment even when it alone exceeds the budget', () => {
    const comments = [
      { author: 'a', date: 'd', text: 'old' },
      { author: 'b', date: 'd', text: `newest ${'q'.repeat(500)}` },
    ];
    const { text } = fitComments(comments, 100);
    expect(text).toContain('newest');
  });
});
