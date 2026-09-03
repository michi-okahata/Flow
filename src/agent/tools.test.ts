import { describe, expect, it } from "vitest";
import { Flow } from "../model/flow";
import { applyAgentToolCall } from "./tools";

describe("agent CRDT tools", () => {
  it("adds a generated answer through the ordinary Flow mutation path", () => {
    const flow = new Flow();
    const source = flow.addRoot(null, "no solvency", 1);
    const result = applyAgentToolCall(flow, {
      name: "add_argument",
      arguments: { under: source, speech: 2, text: "solvency advocate answers" },
    });

    expect(flow.parentOf(result.argumentId)).toBe(source);
    expect(flow.speechOf(result.argumentId)).toBe(2);
    expect(flow.textOf(result.argumentId)).toBe("solvency advocate answers");
  });

  it("does not write when the source argument disappeared", () => {
    const flow = new Flow();
    expect(() =>
      applyAgentToolCall(flow, {
        name: "add_argument",
        arguments: { under: "missing", speech: 1, text: "answer" },
      }),
    ).toThrow("no longer exists");
    expect(flow.roots()).toEqual([]);
  });
});
