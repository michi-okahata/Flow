import type { Argument } from "../model/types";

/** Configuration for one interchangeable agent backend. */
export interface AgentConfig {
  provider: string;
  endpoint: string;
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
  text: string;
  status: "generating" | "ready" | "error";
  error?: string;
}

export interface Transcript {
  id: string;
  startedAt: string;
  finishedAt: string;
  provider: string;
  model: string;
  request: AgentRequest;
  response: string;
  outcome: "generated" | "accepted" | "dismissed" | "cancelled" | "error";
  toolCall?: AgentToolCall;
  toolResult?: { argumentId: string };
  error?: string;
}
