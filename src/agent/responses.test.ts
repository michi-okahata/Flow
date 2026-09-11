import { afterEach, expect, it, vi } from "vitest";
import { responsesComplete } from "./responses";
import { providerFor } from "./provider";
const config = { provider: "test", router: "https://example.test/v1/responses", api: "openai-responses", model: "test", outputTokens: 900 };
afterEach(() => vi.unstubAllGlobals());
async function collect(execute?: (name: string, args: Record<string, unknown>) => unknown) {
  const tokens = [];
  for await (const token of responsesComplete(config, [{ role: "user", content: "hello" }], new AbortController().signal, execute)) tokens.push(token);
  return tokens;
}
it("streams fragmented Responses events and uses Responses request fields", async () => {
  const wire = 'data: {"type":"response.output_text.delta","delta":"hello"}\r\n\r\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}\r\n\r\n';
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({ start(c) {
    for (let i = 0; i < wire.length; i += 7) c.enqueue(new TextEncoder().encode(wire.slice(i, i + 7)));
    c.close();
  } }), { headers: { "content-type": "text/event-stream" } })));
  expect(await collect()).toEqual(["hello"]);
  const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
  expect(body.max_output_tokens).toBe(900);
  expect(body.messages).toBeUndefined();
  expect(body.store).toBe(false);
  expect(providerFor(config).name).toBe("test");
});
it("replays reasoning and supplies call_id tool outputs", async () => {
  const output = [{ type: "reasoning", id: "r", summary: [], encrypted_content: "encrypted" }, { type: "function_call", id: "f", call_id: "call", name: "list_positions", arguments: "{}" }];
  const mock = vi.fn().mockResolvedValueOnce(Response.json({ status: "completed", output }))
    .mockResolvedValueOnce(Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Done" }] }] }));
  vi.stubGlobal("fetch", mock);
  const execute = vi.fn().mockReturnValue([]);
  expect(await collect(execute)).toEqual(["Done"]);
  expect(execute).toHaveBeenCalledWith("list_positions", {});
  const body = JSON.parse(mock.mock.calls[1][1].body);
  expect(body.input).toContainEqual(output[0]);
  expect(body.input.at(-1)).toEqual({ type: "function_call_output", call_id: "call", output: "[]" });
  expect(body.tools[0].type).toBe("function");
  expect(body.tools[0].strict).toBe(false);
  expect(body.tools[0].function).toBeUndefined();
});
it("rejects incomplete responses before executing tools", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ status: "incomplete", output: [{ type: "function_call", call_id: "c", name: "delete_argument", arguments: "{}" }] })));
  const execute = vi.fn();
  await expect(collect(execute)).rejects.toThrow("did not complete");
  expect(execute).not.toHaveBeenCalled();
});
it("surfaces stream errors", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('data: {"type":"error","message":"failed"}\n\n', { headers: { "content-type": "text/event-stream" } })));
  await expect(collect()).rejects.toThrow("failed");
});
