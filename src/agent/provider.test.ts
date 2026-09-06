import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider } from "./provider";
import type { AgentRequest } from "./types";

const request: AgentRequest = {
  id: "run",
  sheet: "Politics",
  argumentId: "argument",
  argument: "nonunique",
  speech: 2,
  flow: [],
};

afterEach(() => vi.unstubAllGlobals());

describe("OpenAI-compatible provider", () => {
  it("routes streamed delta tokens", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"choices":[{"delta":{"content":"not "}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"unique"}}]}\n\n' +
          "data: [DONE]\n\n",
        ));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })));
    const provider = new OpenAICompatibleProvider({
      provider: "test-provider",
      router: "http://agent.test/v1/chat/completions",
      api: "openai-chat-completions",
      model: "test",
    });

    const tokens: string[] = [];
    for await (const token of provider.generate(request, new AbortController().signal)) {
      tokens.push(token);
    }
    expect(tokens).toEqual(["not ", "unique"]);
    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(String(call[1]?.body));
    expect(body.messages[0].content).toContain("exactly three distinct");
    expect(body.messages[0].content).toContain("45 words");
    expect(body.messages[0].content).toContain("JSON array of three strings");
  });
});
