import type { AgentConfig, AgentProvider, AgentRequest } from "./types";

type Json = Record<string, unknown>;

/**
 * Provider registry. The sheet depends only on AgentProvider; wire formats stay
 * here, so another backend is an adapter rather than a change to the editor.
 */
export function providerFor(config: AgentConfig): AgentProvider {
  switch (config.provider) {
    case "openai-compatible":
      return new OpenAICompatibleProvider(config);
    default:
      throw new Error(`unknown agent provider: ${config.provider}`);
  }
}

export class OpenAICompatibleProvider implements AgentProvider {
  readonly name = "openai-compatible";

  constructor(private readonly config: AgentConfig) {}

  async *generate(request: AgentRequest, signal: AbortSignal): AsyncIterable<string> {
    const response = await fetch(this.config.endpoint, {
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
            content:
              "You are flowing a debate. Answer the selected argument with one concise flow-ready argument. Return only the argument text; no label, markdown, or explanation.",
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
