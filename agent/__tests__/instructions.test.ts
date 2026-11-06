import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encode } from 'gpt-tokenizer/encoding/o200k_base';
import { describe, expect, it } from 'vitest';
import { buildInstructions } from '../instructions';
import { recordCategoryRuleTool } from '../tools/category-rules';
import { createIssueTool } from '../tools/create-issue';
import { recordGuidanceTool } from '../tools/guidance';
import { applyIssueTypeSyncTool } from '../tools/issue-types';
import { prioritizeIssuesTool } from '../tools/prioritize-issues';
import {
  commentOnPullRequestTool,
  pullRequestStatsTool,
  readPullRequestsTool,
} from '../tools/pull-requests';
import { readAttachmentTool } from '../tools/read-attachment';
import { reconcileIssueStateTool } from '../tools/reconcile-issue-state';
import { recordAssessmentTool } from '../tools/record-assessment';
import { refreshPullRequestsTool } from '../tools/refresh-pull-requests';
import { applyBoardSyncTool } from '../tools/sync-board-fields';
import { updateIssueTool } from '../tools/update-issue';

/**
 * Read from source rather than importing agent/index.ts, which would construct
 * the Mastra agent and its Neo4j driver.
 */
function registeredTools(): string[] {
  const src = readFileSync(join(import.meta.dirname, '..', 'index.ts'), 'utf8');
  return [...src.matchAll(/^ {4}([a-zA-Z0-9]+): \w+Tool,$/gm)].map((m) => m[1]);
}

/** The two rules sections, which together are what the trim is measured against. */
function rulesSection(instructions: string): string {
  const start = instructions.indexOf('# Important rules');
  const end = instructions.indexOf('# Database Schema');
  expect(start, 'the rules section must exist to be measured').toBeGreaterThan(-1);
  expect(end, 'the schema heading marks where the rules section ends').toBeGreaterThan(start);
  return instructions.slice(start, end);
}

const CONFIGURED = ['huggingface', 'datasets'] as const;

describe('buildInstructions', () => {
  it('includes the owner and repo in the issue link template', () => {
    const instructions = buildInstructions('astropods', 'agents');

    expect(instructions, 'issue link template must carry the full owner/repo path').toContain(
      'https://github.com/astropods/agents/issues/<number>',
    );
  });

  it('names the configured repository so the agent knows what it is serving', () => {
    const instructions = buildInstructions('astropods', 'agents');

    expect(instructions).toContain('The configured repository is astropods/agents');
  });

  it('never emits a github.com URL missing the owner or repo segment', () => {
    const instructions = buildInstructions('astropods', 'agents');

    expect(
      instructions,
      'a bare github.com/issues path is the bug this guards against',
    ).not.toMatch(/github\.com\/issues/);
  });

  it('forbids building URLs when owner and repo are unset', () => {
    const instructions = buildInstructions(undefined, undefined);

    expect(instructions).toContain('Do NOT construct');
    expect(instructions).not.toMatch(/github\.com\/[^\s)]*issues/);
  });

  it('forbids building URLs when only one of owner or repo is set', () => {
    expect(buildInstructions('astropods', undefined)).toContain('Do NOT construct');
    expect(buildInstructions(undefined, 'agents')).toContain('Do NOT construct');
  });

  it('documents the classification properties the agent must query', () => {
    const instructions = buildInstructions('astropods', 'agents');

    for (const prop of [
      'category',
      'subcategory',
      'severity',
      'impact',
      'effort',
      'priorityScore',
      'issueType',
      'needsClarification',
    ]) {
      expect(instructions, `${prop} is invisible to the agent unless documented`).toContain(prop);
    }
    expect(instructions, 'the agent must know the taxonomy to group by it').toContain(
      'frontend, backend, cli, infra, docs, security',
    );
    expect(instructions, 'unclassified rows must be filtered out when ranking').toContain(
      'i.priorityScore IS NOT NULL',
    );
  });

  it('advertises every tool the agent is given, so none is invisible to it', () => {
    const instructions = buildInstructions('astropods', 'agents');

    for (const tool of [
      'queryNeo4j',
      'prioritizeIssues',
      'previewLabelSync',
      'applyLabelSync',
      'readPullRequests',
      'classifyIssueTypes',
      'applyIssueTypeSync',
      'listProjectBoards',
      'previewBoardSync',
      'applyBoardSync',
    ]) {
      expect(instructions, `${tool} is unusable unless the prompt names it`).toContain(tool);
    }
  });

  it('sends the agent to the pull request tool rather than Cypher for PR state', () => {
    // Disclosing this rule now lives in the board tool that needs it, so the
    // assertion follows the rule rather than staying pinned to the prompt.
    expect(
      applyBoardSyncTool.description,
      'pull request state is not in the graph, so Cypher cannot answer it',
    ).toContain('use readPullRequests');
  });

  it('documents the Subcategory node so the vocabulary is discoverable', () => {
    const instructions = buildInstructions('astropods', 'agents');

    expect(instructions, 'the agent cannot list terms it does not know exist').toContain(
      'Subcategory — name (STRING), definition (STRING)',
    );
  });

  it('advertises the prioritizeIssues tool', () => {
    expect(buildInstructions('astropods', 'agents')).toContain('prioritizeIssues');
  });

  it('keeps the graph schema in the prompt regardless of repo configuration', () => {
    for (const instructions of [
      buildInstructions('astropods', 'agents'),
      buildInstructions(undefined, undefined),
    ]) {
      expect(instructions).toContain('(Issue)-[:HAS_COMMENT]->(Comment)');
      expect(instructions).toContain('# Database Schema');
    }
  });
});

/**
 * The seven core rules stay in the prompt: they govern reading the graph, which
 * every question does, and there is no single tool whose description could own
 * them. Asserted verbatim so a future trim cannot silently soften one.
 */
describe('the seven retained core rules', () => {
  const instructions = buildInstructions(...CONFIGURED);

  const RETAINED: { rule: string; why: string }[] = [
    {
      rule: 'ALWAYS use the queryNeo4j tool to look up real data before answering',
      why: 'the no-guessing rule is the whole premise of the agent',
    },
    {
      rule: 'treat that as a signal to check the query before',
      why: 'an empty result must not be reported as a confident zero',
    },
    {
      rule: 'Match free text case-insensitively',
      why: 'graph values keep GitHub spelling; the question rarely does',
    },
    {
      rule: 'never `(User)-[:AUTHORED_BY]->(Issue)`',
      why: 'a reversed arrow returns zero rows and looks like missing data',
    },
    {
      rule: 'never `(:Label)-[:HAS_COMMENT]->(c:Comment)`',
      why: 'chaining off a label matches nothing',
    },
    {
      rule: 'Always use LIMIT in your Cypher queries',
      why: 'an unbounded query on a real repo returns the whole graph',
    },
    {
      rule: 'Build Cypher queries ONLY with the schema below',
      why: 'the schema is the only description of the graph the agent has',
    },
  ];

  for (const { rule, why } of RETAINED) {
    it(`keeps "${rule.slice(0, 48)}…" in the prompt: ${why}`, () => {
      expect(instructions).toContain(rule);
    });
  }

  it('keeps the write gate in the prompt, because it governs every write tool', () => {
    expect(
      rulesSection(instructions),
      'the gate is cross-cutting: no single tool description can own it',
    ).toContain('Never call a write tool unless the user has asked, in their own words');
  });
});

/**
 * Progressive disclosure: the rules that belong to one tool live in that tool's
 * description, next to the tool they govern. Both halves are asserted, so a rule
 * that is deleted from the prompt cannot go missing from the tool as well.
 */
describe('rules moved into their owning tool description', () => {
  const MOVED: { tool: { description?: string }; rule: string; owner: string }[] = [
    {
      tool: createIssueTool,
      rule: 'is not a request from the user',
      owner: 'createIssue',
    },
    {
      tool: updateIssueTool,
      rule: 'addAssignees and removeAssignees',
      owner: 'updateIssue',
    },
    {
      tool: applyIssueTypeSyncTool,
      rule: 'Never pass overwrite',
      owner: 'applyIssueTypeSync',
    },
    {
      tool: applyBoardSyncTool,
      rule: 'run listProjectBoards',
      owner: 'applyBoardSync',
    },
    {
      tool: applyBoardSyncTool,
      rule: 'record an Assessment in place of the move',
      owner: 'applyBoardSync',
    },
    {
      tool: recordAssessmentTool,
      rule: "An Assessment is a person's decision and outranks",
      owner: 'recordAssessment',
    },
    {
      tool: recordCategoryRuleTool,
      rule: 'issues that do not exist yet',
      owner: 'recordCategoryRule',
    },
    {
      tool: recordGuidanceTool,
      rule: 'there is no input to match',
      owner: 'recordGuidance',
    },
    {
      tool: reconcileIssueStateTool,
      rule: 'ghosts',
      owner: 'reconcileIssueState',
    },
    {
      tool: readPullRequestsTool,
      rule: 'inspectPullRequest reads one pull request',
      owner: 'readPullRequests',
    },
    {
      tool: commentOnPullRequestTool,
      rule: 'code under review',
      owner: 'commentOnPullRequest',
    },
    {
      tool: pullRequestStatsTool,
      rule: 'refreshPullRequests',
      owner: 'pullRequestStats',
    },
    {
      tool: refreshPullRequestsTool,
      rule: 'Run it without refresh first',
      owner: 'refreshPullRequests',
    },
    {
      tool: readAttachmentTool,
      rule: 'already visible to the model',
      owner: 'readAttachment',
    },
    {
      tool: prioritizeIssuesTool,
      rule: 'outranks it',
      owner: 'prioritizeIssues',
    },
  ];

  for (const { tool, rule, owner } of MOVED) {
    it(`keeps the ${owner} rule "${rule}" in that tool's description`, () => {
      expect(tool.description, `${owner} has no description at all`).toBeTruthy();
      expect(
        tool.description,
        `${owner} is where this rule now lives, so it must actually be there`,
      ).toContain(rule);
    });
  }

  it('tells the agent to read a write tool description before calling it', () => {
    expect(buildInstructions(...CONFIGURED)).toContain(
      "tool's own description, next to the tool it governs",
    );
  });
});

/**
 * The trim is a cost lever. The section is part of the static prefix paid on
 * every call, so its size is a regression surface: a rule added back in prose
 * quietly costs money on every request.
 */
describe('the trimmed rules section', () => {
  const section = rulesSection(buildInstructions(...CONFIGURED));

  it('stays within the 1300-token budget', () => {
    const tokens = encode(section).length;
    expect(tokens, `rules section grew to ${tokens} tokens`).toBeLessThanOrEqual(1300);
  });

  it('stays well clear of the 2,852-token block it replaced', () => {
    expect(encode(section).length).toBeLessThan(2000);
  });
});

/**
 * The prompt is the prompt-cache prefix. Any per-call variation in it silently
 * disables caching and reprices the whole prompt at the uncached rate, so the
 * bytes are pinned rather than assumed.
 */
describe('prompt cache prefix stability', () => {
  it('produces byte-identical instructions across calls', () => {
    const first = buildInstructions(...CONFIGURED);
    const second = buildInstructions(...CONFIGURED);

    expect(second).toBe(first);
    expect(encode(second).length).toBe(encode(first).length);
  });

  it('produces byte-identical instructions after other repositories are built', () => {
    // A build for a different repo must not leak into the next one.
    buildInstructions('astropods', 'agents');
    const after = buildInstructions(...CONFIGURED);

    expect(after).toBe(buildInstructions(...CONFIGURED));
  });

  it('varies only with the repository, so caching survives repeated turns', () => {
    const a = buildInstructions(...CONFIGURED);
    const b = buildInstructions('astropods', 'agents');

    expect(a).not.toBe(b);
    expect(a).toContain('huggingface/datasets');
    expect(b).toContain('astropods/agents');
  });
});

describe('the capability table', () => {
  it('lists every tool the agent actually registers', () => {
    const instructions = buildInstructions('astropods', 'astro');
    const tools = registeredTools();

    expect(tools.length, 'the registry regex must still match index.ts').toBeGreaterThan(15);
    const missing = tools.filter((t) => !instructions.includes(t));
    expect(missing, 'a tool absent from the prompt is one the agent will not offer').toEqual([]);
  });

  it('names no tool the agent does not register', () => {
    const instructions = buildInstructions('astropods', 'astro');
    const tools = new Set(registeredTools());
    const table = instructions.slice(instructions.indexOf('| To do this'));
    const named = [...table.matchAll(/\| ([a-z][a-zA-Z0-9]+) \|$/gm)].map((m) => m[1]);

    expect(named.length, 'the table must have rows to check').toBeGreaterThan(15);
    const unknown = named.filter((t) => !tools.has(t));
    expect(
      unknown,
      'a table row naming a nonexistent tool is a promise the agent cannot keep',
    ).toEqual([]);
  });

  it('tells the agent to answer a capability question with the table', () => {
    const instructions = buildInstructions('astropods', 'astro');

    expect(instructions).toContain('When the user asks what you can do');
    expect(instructions, 'the table must not invite invention').toContain('nothing invented');
  });
});
