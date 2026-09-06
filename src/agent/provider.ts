import type { AiConfig, AgentProvider, AgentRequest } from "./types";

type Json = Record<string, unknown>;

const FLOW_SYSTEM_PROMPT = [
  "You are writing arguments for a live debate flow.",
  "Reply with exactly three distinct, direct responses to the selected argument; each is at most two short sentences and 45 words.",
  "Prefer the decisive warrant or impact over background, caveats, summaries, and transitions.",
  "Return only a JSON array of three strings—no label, markdown, preamble, or explanation.",
].join(" ");

/**
 * Provider registry. The sheet depends only on AgentProvider; wire formats stay
 * here, so another backend is an adapter rather than a change to the editor.
 */
export function providerFor(config: AiConfig): AgentProvider {
  switch (config.api) {
    case "openai-chat-completions":
      return new OpenAICompatibleProvider(config);
    default:
      throw new Error(`unknown AI API: ${config.api}`);
  }
}

export class OpenAICompatibleProvider implements AgentProvider {
  readonly name: string;

  constructor(private readonly config: AiConfig) {
    this.name = config.provider;
  }

  async *generate(request: AgentRequest, signal: AbortSignal): AsyncIterable<string> {
    const response = await fetch(this.config.router, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        ...(this.config.apiKey
          ? { authorization: `Bearer ${this.config.apiKey}` }
          : {}),
      },
      body: JSON.stringify({
        model: this.config.model,
        stream: true,
        messages: [
          {
            role: "system",
            content: FLOW_SYSTEM_PROMPT,
          },
          {
            role: "user",
            content: JSON.stringify({
              selected_argument: request.argument,
              destination_speech: request.speech,
              sheet: request.sheet,
              flow: request.flow,
            }),
          },
        ],
      }),
    });

    if (!response.ok) {
      const detail = (await response.text()).trim();
      throw new Error(`${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!response.body || contentType.includes("application/json")) {
      const json = (await response.json()) as Json;
      const text = completionText(json);
      if (text) yield text;
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split(/\r?\n/);
      pending = done ? "" : (lines.pop() ?? "");
      for (const line of lines) {
        const data = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
        if (!data || data === "[DONE]") continue;
        try {
          const text = deltaText(JSON.parse(data) as Json);
          if (text) yield text;
        } catch {
          // SSE comments and provider keep-alives are not generation tokens.
        }
      }
      if (done) break;
    }
  }
}

function deltaText(json: Json): string {
  const choices = json.choices;
  if (!Array.isArray(choices)) return "";
  const first = choices[0] as Json | undefined;
  const delta = first?.delta as Json | undefined;
  return typeof delta?.content === "string" ? delta.content : "";
}

function completionText(json: Json): string {
  const choices = json.choices;
  if (!Array.isArray(choices)) return "";
  const first = choices[0] as Json | undefined;
  const message = first?.message as Json | undefined;
  return typeof message?.content === "string" ? message.content : "";
}
