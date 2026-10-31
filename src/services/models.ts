/**
 * Model access through the Astropods AI gateway.
 *
 * The gateway is OpenAI-API-compatible, so the OpenAI SDK reaches Claude with
 * nothing but a different base URL and key. ASTRO_GATEWAY_URL and
 * ASTRO_GATEWAY_API_KEY are injected by `ast dev` and by the platform at
 * deploy time. Model IDs on this path are bare names, such as
 * claude-haiku-4-5, and the bare gateway host without /v1 returns 404.
 *
 * Every model choice in the project resolves here, so the cost profile of the
 * whole agent is readable in one place.
 */

import OpenAI from 'openai';
import type { ChatCompletion } from 'openai/resources/chat/completions';

type Tier = 'fast' | 'reasoning';

const DEFAULTS: Record<Tier, string> = {
  fast: 'claude-haiku-4-5',
  reasoning: 'claude-sonnet-4-6',
};

const TASKS = {
  /** Per-issue extraction and classification, once per ingested issue. */
  analysis: 'fast',
  /** Comment summarization, on demand from the agent. */
  summary: 'fast',
  /** Subcategory vocabulary derived across the whole corpus. */
  vocabulary: 'reasoning',
  /** The conversational agent, which plans over five tools. */
  agent: 'reasoning',
  /** LLM-as-judge scorers in the eval suite. */
  judge: 'fast',
} as const satisfies Record<string, Tier>;

export type Task = keyof typeof TASKS;

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface ModelCall {
  task: Task;
  system: string;
  prompt: string;
}

export interface StructuredCall extends ModelCall {
  /** Tool name carrying the schema. Shows up in gateway and trace logs. */
  name: string;
  schema: Record<string, unknown>;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set, so the AI gateway is unreachable`);
  return value;
}

/**
 * The model for a task. MODEL_FAST and MODEL_REASONING come from the
 * astropods.yml `models` entries, so a deploy can move a task to a different
 * model without a code change.
 */
export function modelFor(task: Task): string {
  const tier: Tier = TASKS[task];
  return process.env[`MODEL_${tier.toUpperCase()}`] || DEFAULTS[tier];
}

export function gatewayBaseUrl(): string {
  return `${requireEnv('ASTRO_GATEWAY_URL').replace(/\/+$/, '')}/v1`;
}

/**
 * How long a single model call may hang before it is treated as failed. The
 * SDK's own default is ten minutes, which outlives every caller here: a tool
 * call that hangs that long stalls the agent turn and the person waiting on
 * it. One minute is above the slowest call measured on the bench (9.5s at
 * p100) with room for a cold gateway, and short enough to surface as an error.
 */
function timeoutMs(): number {
  const raw = process.env.MODEL_TIMEOUT_MS;
  if (!raw) return 60_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`MODEL_TIMEOUT_MS must be a positive number of milliseconds, got "${raw}"`);
  }
  return parsed;
}

/**
 * Retries the SDK performs itself, on top of the one this module does for a
 * missing tool call. Two covers a dropped connection or a 5xx without turning
 * one slow call into a eight-minute wait.
 */
const MAX_RETRIES = 2;

/**
 * Cap on a free-text answer. Nothing this module asks for is longer than a
 * summary or a classification rationale, and an uncapped completion is a cost
 * ceiling nobody chose. Override per deployment rather than editing this.
 */
function maxTokens(): number {
  const raw = process.env.MODEL_MAX_TOKENS;
  if (!raw) return 1_024;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`MODEL_MAX_TOKENS must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

/**
 * One client for the process, keyed on the endpoint and key it was built from.
 *
 * Each `new OpenAI(...)` allocates its own connection pool, so building one per
 * call opened a fresh pool for every request and threw it away. Keying the memo
 * rather than caching unconditionally keeps a reloaded environment — a rotated
 * key, a different gateway in a test — from serving calls through the old one.
 */
let _client: OpenAI | null = null;
let _clientKey: string | null = null;

export function gatewayClient(): OpenAI {
  const baseURL = gatewayBaseUrl();
  const apiKey = requireEnv('ASTRO_GATEWAY_API_KEY');
  const key = `${baseURL}\u0000${apiKey}`;
  if (_client && _clientKey === key) return _client;

  _client = new OpenAI({
    apiKey,
    baseURL,
    timeout: timeoutMs(),
    maxRetries: MAX_RETRIES,
  });
  _clientKey = key;
  return _client;
}

/** Drops the memoised client. For tests that change the gateway environment. */
export function resetGatewayClient(): void {
  _client = null;
  _clientKey = null;
}

/** Mastra reads this shape as an OpenAI-compatible provider. */
export function gatewayModel(task: Task) {
  return {
    providerId: 'astro-gateway',
    modelId: modelFor(task),
    url: gatewayBaseUrl(),
    apiKey: requireEnv('ASTRO_GATEWAY_API_KEY'),
  };
}

function messagesFor(call: ModelCall) {
  return [
    { role: 'system' as const, content: call.system },
    { role: 'user' as const, content: call.prompt },
  ];
}

function usageOf(completion: ChatCompletion): TokenUsage {
  return {
    prompt_tokens: completion.usage?.prompt_tokens ?? 0,
    completion_tokens: completion.usage?.completion_tokens ?? 0,
    total_tokens: completion.usage?.total_tokens ?? 0,
  };
}

export async function textCompletion(call: ModelCall): Promise<string | null> {
  const completion = await gatewayClient().chat.completions.create({
    model: modelFor(call.task),
    messages: messagesFor(call),
    max_tokens: maxTokens(),
  });
  return completion.choices[0]?.message.content ?? null;
}

/**
 * Runs a call whose answer must match a JSON schema. Claude has no
 * response_format: json_schema, so the schema travels as a single tool the
 * model is required to call, which enforces the enums the same way.
 *
 * A tool-forced call still comes back empty now and then: the gateway answers
 * with prose, or with a tool call whose arguments are not valid JSON. One
 * retry covers that. It is deliberately bounded to one, because a model that
 * will not call the tool on the second ask will not call it on the fourth, and
 * every retry is a paid call on a path that ingests a whole corpus.
 */
export async function structuredCompletion<T>(
  call: StructuredCall,
): Promise<{ data: T; tokenUsage: TokenUsage }> {
  const request = {
    model: modelFor(call.task),
    messages: messagesFor(call),
    tools: [{ type: 'function' as const, function: { name: call.name, parameters: call.schema } }],
    tool_choice: { type: 'function' as const, function: { name: call.name } },
  };

  let completion = await gatewayClient().chat.completions.create(request);
  let toolCall = completion.choices[0]?.message.tool_calls?.[0];

  if (!toolCall) {
    console.warn(`  [structuredCompletion] ${call.name}: no tool call, retrying once`);
    completion = await gatewayClient().chat.completions.create(request);
    toolCall = completion.choices[0]?.message.tool_calls?.[0];
  }

  if (!toolCall) throw new Error(`${call.name}: the model returned no tool call`);

  return { data: JSON.parse(toolCall.function.arguments) as T, tokenUsage: usageOf(completion) };
}
