import { describe, expect, it } from "vitest";
import { readConfig } from "./config";

describe("agent config", () => {
  it("reads AI routing independently of key overrides", () => {
    const config = readConfig(JSON.stringify({
      ai: {
        provider: "ollama",
        router: "http://localhost:11434/v1/chat/completions",
        api: "openai-chat-completions",
        model: "qwen3:8b",
      },
    }));

    expect(config.ai).toEqual({
      provider: "ollama",
      router: "http://localhost:11434/v1/chat/completions",
      api: "openai-chat-completions",
      model: "qwen3:8b",
    });
    expect(config.keys.g).toBe("generate");
    expect(config.problems).toEqual([]);
  });

  it("reports a malformed agent without breaking the keymap", () => {
    const config = readConfig('{"agent":{"endpoint":4}}');
    expect(config.ai).toBeNull();
    expect(config.keys.g).toBe("generate");
    expect(config.problems[0]).toContain("needs endpoint and model strings");
  });

  it("keeps reading the original agent shape", () => {
    const config = readConfig(JSON.stringify({
      agent: {
        provider: "openai-compatible",
        endpoint: "http://localhost:11434/v1/chat/completions",
        model: "old-model",
      },
    }));
    expect(config.ai).toEqual({
      provider: "openai-compatible",
      router: "http://localhost:11434/v1/chat/completions",
      api: "openai-chat-completions",
      model: "old-model",
    });
  });
});
