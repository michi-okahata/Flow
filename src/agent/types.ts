import type { Argument } from "../model/types";

/**
 * Configuration for one interchangeable AI backend. Provider identity,
 * routing, and wire protocol are deliberately independent.
 */
export interface AiConfig {
  provider: string;
  router: string;
  api: string;
  model: string;
  apiKey?: string;
  /** Total prompt budget. Context is compacted before it reaches the provider. */
  contextTokens?: number;
  /** Maximum tokens the provider may generate for one chat turn. */
  outputTokens?: number;
}

export interface AgentMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  /** What the agent did to the document on this turn, in the order it did it.
      Kept on the message rather than only in the transcript file: a tool call
      changed the flow, and the thread is where you look to find out why. */
  steps?: AgentStep[];
  /** Set when the turn failed or was stopped. The content is whatever had
      streamed by then, which is worth keeping — the steps above it already
      happened. */
  error?: string;
}

/** One tool call, as the panel watches it run. */
export interface AgentStep {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  status: "running" | "done" | "error";
  /** One line of what came back, or what went wrong. */
  detail?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface AgentContextBlock {
  source: string;
  position: string;
  key: string;
  argument: string;
  answers: string[];
  /** Card tags plus citations/bodies, aligned with answers when available. */
  context?: string[];
}

export interface DebateSheet {
  title: string;
  arguments: Argument[];
}

export interface AgentContextSource {
  source: string;
  blockCount: number;
}

export interface AgentRequest {
  id: string;
  sheet: string;
  argumentId: string;
  argument: string;
  speech: number;
  flow: Argument[];
  debate: DebateSheet[];
  history: AgentMessage[];
  context: AgentContextBlock[];
  /** Small manifest captured when this request starts. Bodies stay bounded. */
  contextSources: AgentContextSource[];
}

export interface AgentChatRequest {
  id: string;
  message: string;
  selectedArgument?: string;
  sheet: string;
  debate: DebateSheet[];
  history: AgentMessage[];
  context: AgentContextBlock[];
  /** Imported workspace files available to this turn's context tools. */
  contextSources: AgentContextSource[];
}

export interface AgentProvider {
  readonly name: string;
  generate(request: AgentRequest, signal: AbortSignal): AsyncIterable<string>;
  chat(request: AgentChatRequest, signal: AbortSignal, execute?: (name: string, args: Record<string, unknown>) => unknown): AsyncIterable<string>;
}

export type AddArgumentToolCall = {
  name: "add_argument";
  arguments: {
    under: string;
    speech: number;
    text: string;
  };
};

export type AgentToolCall = AddArgumentToolCall;

export interface AgentDraft {
  requestId: string;
  sourceId: string;
  speech: number;
  /** Raw streamed provider output, retained for the transcript. */
  text: string;
  /** Separate arguments parsed from the provider's completed response. */
  answers: string[];
  status: "generating" | "ready" | "error";
  error?: string;
}

export interface Transcript {
  id: string;
  startedAt: string;
  finishedAt: string;
  provider: string;
  router: string;
  api: string;
  model: string;
  request: AgentRequest | AgentChatRequest;
  response: string;
  outcome: "generated" | "accepted" | "dismissed" | "cancelled" | "error";
  chatTools?: { name: string; arguments: Record<string, unknown>; result: unknown }[];
  toolCalls?: AgentToolCall[];
  toolResults?: { argumentId: string }[];
  error?: string;
}
