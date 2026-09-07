import { describe, expect, it } from "vitest";
import { compactHistory, estimateTokens, selectContext } from "./context";
import type { AgentContextBlock, AgentMessage } from "./types";

const blocks: AgentContextBlock[] = [
  { source: "/cards/cap.cmir", position: "Cap K", key: "framework", argument: "framework", answers: ["fairness first"] },
  {
    source: "/cards/politics.cmir",
    position: "Politics DA",
    key: "uniqueness",
    argument: "uniqueness",
    answers: ["democrats are ahead"],
    context: ["Smith 24 Democrats lead the generic ballot before the plan"],
  },
];

describe("agent context manager", () => {
  it("ranks matching CardMirror evidence and position ahead of unrelated blocks", () => {
    const selected = selectContext(blocks, "what is the Democrats uniqueness evidence?", "Politics DA", 500);
    expect(selected[0].source).toContain("politics.cmir");
    expect(selected).not.toContain(blocks[0]);
  });

  it("keeps recent turns and compacts old user directions instead of old assistant prose", () => {
    const messages: AgentMessage[] = Array.from({ length: 12 }, (_, index) => ({
      id: String(index),
      role: index % 2 ? "assistant" : "user",
      content: `${index % 2 ? "long explanation" : "strategy direction"} ${"x".repeat(120)}`,
      createdAt: String(index),
    }));
    const compact = compactHistory(messages, 180);
    expect(compact[0].content).toContain("Earlier debate directions");
    expect(compact[compact.length - 1]?.id).toBe("11");
    expect(compact.length).toBeLessThan(messages.length);
  });

  it("uses a conservative four-characters-per-token estimate", () => {
    expect(estimateTokens("12345678")).toBe(2);
  });

  it("truncates a large card body to the retrieval budget", () => {
    const huge = [{ ...blocks[1], context: ["evidence ".repeat(10_000)] }];
    const selected = selectContext(huge, "Democrats evidence", "Politics DA", 180);
    expect(selected).toHaveLength(1);
    expect(estimateTokens(JSON.stringify(selected[0]))).toBeLessThanOrEqual(180);
  });
});
