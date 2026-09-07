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
  debate: [],
  history: [{ id: "m", role: "user", content: "prioritize turns", createdAt: "now" }],
  context: [{ source: "politics.cmir", position: "Politics", key: "uniqueness", argument: "uniqueness", answers: ["ahead"] }],
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
      outputTokens: 321,
    });

    const tokens: string[] = [];
    for await (const token of provider.generate(request, new AbortController().signal)) {
      tokens.push(token);
    }
    expect(tokens).toEqual(["not ", "unique"]);
    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(String(call[1]?.body));
    const prompt = body.messages.map((message: { content: string }) => message.content).join("\n");
    expect(prompt).toContain("exactly three distinct");
    expect(prompt).toContain("45 words");
    expect(prompt).toContain("JSON array");
    expect(body.messages[0].content).toContain("persistent strategy assistant");
    expect(body.messages[1].content).toBe("prioritize turns");
    expect(body.messages[2].content).toContain("politics.cmir");
    expect(body.max_tokens).toBe(321);
  });
});
