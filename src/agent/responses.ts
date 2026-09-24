import type { AiConfig } from "./types";
import { CHAT_TOOLS } from "./tools";
import { postToRouter } from "./http";
type Item = Record<string, unknown>;

/** Replay output items, including encrypted reasoning, with matching call outputs. */
export async function* responsesComplete(config: AiConfig, messages: Item[], signal: AbortSignal, execute?: (name: string, args: Item) => unknown): AsyncIterable<string> {
  const input = [...messages];
  while (true) {
    signal.throwIfAborted();
    const response = await postToRouter(config, {
      model: config.model, input, store: false, stream: true,
      include: ["reasoning.encrypted_content"],
      ...(config.outputTokens ? { max_output_tokens: config.outputTokens } : {}),
      ...(execute ? { tools: CHAT_TOOLS.map(tool => ({ type: "function", ...tool.function, strict: false })) } : {}),
    }, signal);
    let completed: Item | undefined;
    let streamed = false;
    if (response.headers.get("content-type")?.includes("application/json")) {
      completed = await response.json() as Item;
    } else {
      for await (const event of events(response, signal)) {
        if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
          streamed = true;
          yield event.delta;
        }
        if (event.type === "error" || event.type === "response.failed" || event.type === "response.incomplete") {
          throw new Error(`Responses API failed: ${JSON.stringify(event.response ?? event)}`);
        }
        if (event.type === "response.completed") completed = event.response as Item;
      }
    }
    signal.throwIfAborted();
    if (!completed || completed.status !== "completed") throw new Error(`Responses API did not complete: ${JSON.stringify(completed ?? {})}`);
    const output = Array.isArray(completed.output) ? completed.output as Item[] : [];
    if (!streamed) {
      for (const item of output) {
        if (item.type === "message" && Array.isArray(item.content)) {
          for (const part of item.content as Item[]) {
            if (part.type === "output_text" && typeof part.text === "string") yield part.text;
            if (part.type === "refusal") throw new Error(String(part.refusal ?? "Request declined"));
          }
        }
      }
    }
    const calls = output.filter(item => item.type === "function_call");
    if (!calls.length) return;
    if (!execute) throw new Error("Unexpected function call in draft response");
    input.push(...output);
    for (const call of calls) {
      signal.throwIfAborted();
      if (typeof call.call_id !== "string" || typeof call.name !== "string") throw new Error("Invalid Responses function call");
      let result: unknown;
      try {
        const args = JSON.parse(String(call.arguments));
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid tool arguments");
        result = execute(call.name, args);
      } catch (error) {
        result = { error: error instanceof Error ? error.message : String(error) };
      }
      input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result ?? null) });
    }
  }
}

async function* events(response: Response, signal: AbortSignal): AsyncIterable<Item> {
  if (!response.body) throw new Error("Responses API returned no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let data: string[] = [];
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split(/\r?\n/);
      pending = done ? "" : lines.pop() ?? "";
      if (done) lines.push("");
      for (const line of lines) {
        if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        else if (!line && data.length) {
          const payload = data.join("\n");
          data = [];
          if (payload !== "[DONE]") yield JSON.parse(payload) as Item;
        }
      }
      if (done) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
