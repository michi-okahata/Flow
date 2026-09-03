import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, defaultConfigText, readConfig } from "./config";

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

describe("key config", () => {
  it("does not expose numbers as configurable actions", () => {
    expect(DEFAULT_CONFIG.keys["1"]).toBeUndefined();
    expect(defaultConfigText()).not.toContain('"digit1"');
  });

  it("ignores numeric mappings from old or hand-written configs", () => {
    const config = readConfig(JSON.stringify({
      keys: { "1": "delete", "M-2": "copy", q: "down" },
    }));
    expect(config.keys["1"]).toBeUndefined();
    expect(config.keys["M-2"]).toBeUndefined();
    expect(config.keys.q).toBe("down");
    expect(config.problems).toEqual([]);
  });
});
