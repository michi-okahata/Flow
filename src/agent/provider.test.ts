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

it("executes chat tools and returns their results to the model", async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: null, tool_calls: [{ id: "tool-1", type: "function", function: { name: "list_positions", arguments: "{}" } }] } }] }))
    .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "Found Politics." } }] }));
  vi.stubGlobal("fetch", fetchMock);
  const provider = new OpenAICompatibleProvider({ provider: "test", router: "http://agent.test", api: "openai-chat-completions", model: "test" });
  const execute = vi.fn().mockReturnValue([{ id: "position", title: "Politics" }]);
  const tokens = [];
  for await (const token of provider.chat({ ...request, message: "Explore the debate" }, new AbortController().signal, execute)) tokens.push(token);
  expect(tokens).toEqual(["Found Politics."]);
  expect(execute).toHaveBeenCalledWith("list_positions", {});
  const body = JSON.parse(fetchMock.mock.calls[1][1].body);
  expect(body.tools).toHaveLength(4);
  expect(body.messages.at(-1)).toEqual({ role: "tool", tool_call_id: "tool-1", content: JSON.stringify([{ id: "position", title: "Politics" }]) });
});

it("does not execute tools after cancellation", async () => {
  const controller = new AbortController();
  vi.stubGlobal("fetch", vi.fn().mockImplementation(() => {
    controller.abort();
    return Promise.resolve(Response.json({ choices: [{ message: { tool_calls: [{ id: "t", function: { name: "edit_argument", arguments: "{}" } }] } }] }));
  }));
  const provider = new OpenAICompatibleProvider({ provider: "test", router: "http://agent.test", api: "openai-chat-completions", model: "test" });
  const execute = vi.fn();
  await expect(async () => {
    for await (const _ of provider.chat({ ...request, message: "Edit" }, controller.signal, execute)) { /* consume */ }
  }).rejects.toThrow();
  expect(execute).not.toHaveBeenCalled();
});
