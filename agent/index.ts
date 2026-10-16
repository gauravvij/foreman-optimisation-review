/**
 * Foreman — Agent
 *
 * Researches GitHub issues in the knowledge graph and answers questions
 * using Cypher queries and comment summarization.
 *
 * Environment variables (auto-injected by ast dev):
 *   GRPC_SERVER_ADDR  — Messaging service address (default: localhost:9090)
 *   ASTRO_GATEWAY_URL — AI gateway host, injected by the platform
 *   ASTRO_GATEWAY_API_KEY — AI gateway key, injected by the platform
 *   MODEL_REASONING   — Model for the agent (default: claude-sonnet-4-6)
 *   MODEL_FAST        — Model for classification and summaries (default: claude-haiku-4-5)
 *   GITHUB_OWNER      — Repo owner, used to build issue links
 *   GITHUB_REPO       — Repo name, used to build issue links
 *   NEO4J_HOST        — Neo4j host (default: localhost)
 *   NEO4J_URI         — Neo4j bolt URI (default: bolt://{NEO4J_HOST}:7687)
 *   NEO4J_AUTH        — Set to enable auth (default: disabled)
 */

import { serve } from '@astropods/adapter-mastra';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { LibSQLStore } from '@mastra/libsql';
import { Memory } from '@mastra/memory';
import { gatewayModel } from '../src/services/models';
import { buildInstructions } from './instructions';
import { applyLabelSyncTool } from './tools/apply-label-sync';
import { listCategoryRulesTool, recordCategoryRuleTool } from './tools/category-rules';
import { createIssueTool } from './tools/create-issue';
import { listGuidanceTool, recordGuidanceTool } from './tools/guidance';
import { ingestMissingIssuesTool } from './tools/ingest-missing-issues';
import { applyIssueTypeSyncTool, classifyIssueTypesTool } from './tools/issue-types';
import { previewLabelSyncTool } from './tools/preview-label-sync';
import { prioritizeIssuesTool } from './tools/prioritize-issues';
import {
  commentOnPullRequestTool,
  inspectPullRequestTool,
  pullRequestStatsTool,
  readPullRequestsTool,
} from './tools/pull-requests';
import { queryNeo4jTool } from './tools/query-neo4j';
import { readAttachmentTool } from './tools/read-attachment';
import { reconcileIssueStateTool } from './tools/reconcile-issue-state';
import { listAssessmentsTool, recordAssessmentTool } from './tools/record-assessment';
import { refreshIssuesTool } from './tools/refresh-issues';
import { refreshPullRequestsTool } from './tools/refresh-pull-requests';
import { setBoardColumnTool } from './tools/set-board-column';
import { summarizeCommentsTool } from './tools/summarize-comments';
import {
  applyBoardSyncTool,
  listProjectBoardsTool,
  previewBoardSyncTool,
} from './tools/sync-board-fields';
import { updateIssueTool } from './tools/update-issue';

const owner = process.env.GITHUB_OWNER;
const repo = process.env.GITHUB_REPO;

if (!owner || !repo) {
  console.warn('agent: GITHUB_OWNER/GITHUB_REPO not set, issue links disabled');
}

const INSTRUCTIONS = buildInstructions(owner, repo);

// Suspend/resume needs a durable snapshot of the paused run. The agent's own
// Memory store only holds conversation history, and an agent not registered on
// a Mastra instance falls back to an ephemeral one, so a confirmed elicitation
// resumes against a run that was never persisted. /data is the volume the
// platform mounts, so the snapshot survives a restart mid-confirmation.
const RUN_STORE_URL = process.env.RUN_STORE_URL ?? 'file:/data/agent-runs.db';

// Persistent so a bun --watch restart, or a rebuild, does not wipe the
// conversation the user is having right now. /data is the same platform
// volume RUN_STORE_URL sits on.
//
// lastMessages defaults to 10 in @mastra/memory (see memoryDefaultOptions in
// @mastra/core), which is too tight for a triage session that ranges over
// dozens of turns and refers back to earlier ones. workingMemory keeps a
// small structured notes block the model updates and receives every turn,
// which is what carries a fact past that window without needing semantic
// recall's vector store.
const memory = new Memory({
  storage: new LibSQLStore({
    id: 'memory',
    url: process.env.MEMORY_STORE_URL ?? 'file:/data/agent-memory.db',
  }),
  options: {
    lastMessages: Number(process.env.MEMORY_LAST_MESSAGES ?? '80'),
    workingMemory: { enabled: true },
  },
});

const agent = new Agent({
  id: 'foreman',
  name: 'foreman',
  instructions: INSTRUCTIONS,
  model: gatewayModel('agent'),
  tools: {
    queryNeo4j: queryNeo4jTool,
    summarizeComments: summarizeCommentsTool,
    prioritizeIssues: prioritizeIssuesTool,
    previewLabelSync: previewLabelSyncTool,
    applyLabelSync: applyLabelSyncTool,
    readPullRequests: readPullRequestsTool,
    inspectPullRequest: inspectPullRequestTool,
    commentOnPullRequest: commentOnPullRequestTool,
    pullRequestStats: pullRequestStatsTool,
    refreshPullRequests: refreshPullRequestsTool,
    classifyIssueTypes: classifyIssueTypesTool,
    applyIssueTypeSync: applyIssueTypeSyncTool,
    listProjectBoards: listProjectBoardsTool,
    previewBoardSync: previewBoardSyncTool,
    applyBoardSync: applyBoardSyncTool,
    setBoardColumn: setBoardColumnTool,
    createIssue: createIssueTool,
    readAttachment: readAttachmentTool,
    reconcileIssueState: reconcileIssueStateTool,
    ingestMissingIssues: ingestMissingIssuesTool,
    refreshIssues: refreshIssuesTool,
    updateIssue: updateIssueTool,
    recordAssessment: recordAssessmentTool,
    listAssessments: listAssessmentsTool,
    recordCategoryRule: recordCategoryRuleTool,
    listCategoryRules: listCategoryRulesTool,
    recordGuidance: recordGuidanceTool,
    listGuidance: listGuidanceTool,
  },
  memory,
});

// Registering the agent here is what gives resumeStream a place to find the
// suspended run; without it, confirming an elicitation fails with
// "could not find a suspended run".
export const mastra = new Mastra({
  agents: { foreman: agent },
  storage: new LibSQLStore({ id: 'runs', url: RUN_STORE_URL }),
});

// Enable file uploads: the sidecar advertises the capability when this flag is
// set, so the paperclip lights up in the chat.
serve(agent, { supportsFiles: true });
