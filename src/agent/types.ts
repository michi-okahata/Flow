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
}

export interface AgentRequest {
  id: string;
  sheet: string;
  argumentId: string;
  argument: string;
  speech: number;
  flow: Argument[];
}

export interface AgentProvider {
  readonly name: string;
  generate(request: AgentRequest, signal: AbortSignal): AsyncIterable<string>;
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
  request: AgentRequest;
  response: string;
  outcome: "generated" | "accepted" | "dismissed" | "cancelled" | "error";
  toolCalls?: AgentToolCall[];
  toolResults?: { argumentId: string }[];
  error?: string;
}
