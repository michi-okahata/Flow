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

  it("reads and validates context cost limits", () => {
    const config = readConfig(JSON.stringify({
      ai: {
        provider: "local",
        router: "http://localhost",
        api: "openai-chat-completions",
        model: "model",
        contextTokens: 16000,
        outputTokens: 900,
      },
    }));
    expect(config.ai?.contextTokens).toBe(16000);
    expect(config.ai?.outputTokens).toBe(900);
    expect(config.problems).toEqual([]);
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

  it("moves the old m shortcut from memorize to important", () => {
    const config = readConfig(JSON.stringify({ keys: { m: "memorize" } }));
    expect(config.keys.m).toBe("important");
    expect(config.problems).toEqual([]);
  });

  it("drops the retired focus shortcut from old configs", () => {
    const config = readConfig(JSON.stringify({ keys: { f: "focus" } }));
    expect(config.keys.f).toBeUndefined();
    expect(config.problems).toEqual([]);
  });
});

it("selects a named model and preserves independent API settings", () => {
  const local = { provider: "local", router: "http://localhost:11434/v1/chat/completions", api: "openai-chat-completions", model: "small" };
  const remote = { ...local, provider: "remote", router: "https://example.com/v1/chat/completions", model: "large", apiKey: "test-key", outputTokens: 1500 };
  const config = readConfig(JSON.stringify({ ai: { default: "remote", profiles: { local, remote } } }));
  expect(config.aiProfile).toBe("remote");
  expect(config.ai).toEqual(remote);
  expect(config.aiProfiles.local).toEqual(local);
  expect(config.problems).toEqual([]);
});

it("keeps valid profiles when another profile or the default is invalid", () => {
  const local = { provider: "local", router: "http://localhost", api: "openai-chat-completions", model: "small" };
  const config = readConfig(JSON.stringify({ ai: { default: "missing", profiles: { bad: {}, local } } }));
  expect(config.aiProfile).toBe("local");
  expect(config.ai).toEqual(local);
  expect(config.problems).toHaveLength(2);
  expect(config.keys.g).toBe("generate");
  expect(readConfig('{"ai":{"profiles":[]}}').ai).toBeNull();
  expect(readConfig('{"ai":{"profiles":{}}}').ai).toBeNull();
});
