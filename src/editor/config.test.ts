import { describe, expect, it } from "vitest";
import { readConfig } from "./config";

describe("agent config", () => {
  it("reads an agent independently of key overrides", () => {
    const config = readConfig(JSON.stringify({
      agent: {
        provider: "openai-compatible",
        endpoint: "http://localhost:11434/v1/chat/completions",
        model: "qwen3:8b",
      },
    }));

    expect(config.agent).toEqual({
      provider: "openai-compatible",
      endpoint: "http://localhost:11434/v1/chat/completions",
      model: "qwen3:8b",
    });
    expect(config.keys.g).toBe("generate");
    expect(config.problems).toEqual([]);
  });

  it("reports a malformed agent without breaking the keymap", () => {
    const config = readConfig('{"agent":{"endpoint":4}}');
    expect(config.agent).toBeNull();
    expect(config.keys.g).toBe("generate");
    expect(config.problems[0]).toContain("needs endpoint and model strings");
  });
});
