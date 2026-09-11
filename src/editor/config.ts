import { commands, DEFAULT_KEYS } from "./commands";
import type { AiConfig } from "../agent/types";

/**
 * `~/.flow/config.json`, as the keymap sees it.
 *
 * What it is for: the keys are a preference and what the editor can do is not
 * (see `commands`). This is the file that binds one to the other — beside the
 * blocks in `~/.flow`, because it is the other half of what follows a person
 * from round to round, and hand-written JSON because it is a file you open in
 * an editor and read.
 *
 *     {
 *       "keys": {
 *         "g": "answer",
 *         "A": null
 *       }
 *     }
 *
 * A key on the left, the name of a command on the right — the same shape and
 * the same order as `DEFAULT_KEYS`, and read *over* it rather than in place of
 * it: a file that had to restate the whole keymap to move one key would be a
 * file nobody keeps up to date. `null` unbinds, which is the only way to say
 * "nothing" and the way to free a key up for something else.
 *
 * Nothing here throws. A config is edited by hand, in a text editor, between
 * rounds and sometimes during them — so every mistake it can contain has to
 * leave the keyboard working: what parses is applied, what doesn't is reported
 * (see `Config.problems`, which the status line shows), and the rest of the
 * keymap is whatever it always was.
 */

/** How a key is written in the file — the same string `keyOf` builds. */
const KEY_PATTERN = /^(C-)?(M-)?.+$/;
/** Number keys are fixed count syntax rather than configurable actions. */
const NUMBER_KEY = /^(?:C-)?(?:M-)?[0-9]$/;

export interface Config {
  /** The keymap to run: the defaults with the file read over them. */
  keys: Record<string, string>;
  /**
   * What was wrong with the file, in the order it was found, and empty when
   * there was nothing wrong or no file at all. Told rather than thrown: a
   * config with one bad line is a config with every other line still good.
   */
  problems: string[];
  /** The optional answer-generating backend. */
  ai: AiConfig | null;
  aiProfiles: Record<string, AiConfig>;
  aiProfile: string | null;
}

export const DEFAULT_CONFIG: Config = { keys: DEFAULT_KEYS, problems: [], ai: null, aiProfiles: {}, aiProfile: null };

/**
 * Read a config, or the defaults where there is no file.
 *
 * `text` is the file as it is on disk (see `store_config` in store.rs) — null
 * on every machine where nobody has written one, which is most of them.
 */
export function readConfig(text: string | null): Config {
  if (text === null || text.trim() === "") return DEFAULT_CONFIG;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    // The parser's own message names the line and column, which is the whole
    // of what is useful about a syntax error in a file you are editing.
    return { ...DEFAULT_CONFIG, keys: DEFAULT_KEYS, problems: [`config.json: ${(e as Error).message}`], ai: null };
  }

  if (!isObject(parsed)) {
    return { ...DEFAULT_CONFIG, keys: DEFAULT_KEYS, problems: ["config.json: expected an object"], ai: null };
  }

  const keys = { ...DEFAULT_KEYS };
  const problems: string[] = [];
  const bindings = parsed.keys;
  if (bindings !== undefined) {
    if (!isObject(bindings)) {
      problems.push(`config.json: "keys" is not an object`);
    } else {
      for (const [key, name] of Object.entries(bindings)) {
        // Old seeded configs listed digit0…digit9. Ignore those entries (and
        // any attempted numeric action) quietly: numbers always build counts.
        if (NUMBER_KEY.test(key)) continue;
        if (!KEY_PATTERN.test(key)) {
          problems.push(`config.json: "${key}" is not a key`);
          continue;
        }
        // Unbinding, which is what a key with nothing on it is for: `"x": null`
        // leaves `x` doing nothing rather than deleting an argument.
        if (name === null || name === "") {
          delete keys[key];
          continue;
        }
        if (typeof name !== "string" || !(name in commands)) {
          problems.push(`config.json: "${key}" is bound to no such command: ${String(name)}`);
          continue;
        }
        keys[key] = name;
      }
    }
  }

  const aiProfiles: Record<string, AiConfig> = Object.create(null);
  let aiProfile: string | null = null;
  if (isObject(parsed.ai) && parsed.ai.profiles !== undefined) {
    if (!isObject(parsed.ai.profiles)) {
      problems.push('config.json: "ai.profiles" must be an object of named profiles');
    } else {
      for (const [name, value] of Object.entries(parsed.ai.profiles)) {
        const issues: string[] = [];
        const profile = readAi(value, issues);
        problems.push(...issues.map(issue => `${name}: ${issue}`));
        if (profile && name.trim()) aiProfiles[name] = profile;
        else if (!issues.length) problems.push(`config.json: invalid AI profile "${name}"`);
      }
    }
    const preferred = parsed.ai.default;
    if (preferred !== undefined && (typeof preferred !== "string" || !Object.prototype.hasOwnProperty.call(aiProfiles, preferred))) {
      problems.push('config.json: "ai.default" must name a valid profile');
    }
    aiProfile = typeof preferred === "string" && Object.prototype.hasOwnProperty.call(aiProfiles, preferred) ? preferred : Object.keys(aiProfiles)[0] ?? null;
  } else {
    const ai = parsed.ai !== undefined ? readAi(parsed.ai, problems) : readLegacyAgent(parsed.agent, problems);
    if (ai) { aiProfiles.default = ai; aiProfile = "default"; }
  }
  return { keys, problems, aiProfiles, aiProfile, ai: aiProfile ? aiProfiles[aiProfile] : null };
}

function readAi(value: unknown, problems: string[]): AiConfig | null {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) {
    problems.push(`config.json: "ai" is not an object`);
    return null;
  }
  if (
    typeof value.provider !== "string" ||
    typeof value.router !== "string" ||
    typeof value.api !== "string" ||
    typeof value.model !== "string"
  ) {
    problems.push(`config.json: "ai" needs provider, router, api, and model strings`);
    return null;
  }
  if (value.apiKey !== undefined && typeof value.apiKey !== "string") {
    problems.push(`config.json: "ai.apiKey" is not a string`);
    return null;
  }
  for (const field of ["contextTokens", "outputTokens"] as const) {
    if (value[field] !== undefined && (typeof value[field] !== "number" || !Number.isFinite(value[field]) || value[field] <= 0)) {
      problems.push(`config.json: "ai.${field}" is not a positive number`);
    }
  }
  return {
    provider: value.provider,
    router: value.router,
    api: value.api,
    model: value.model,
    ...(typeof value.apiKey === "string" ? { apiKey: value.apiKey } : {}),
    ...(typeof value.contextTokens === "number" && value.contextTokens > 0
      ? { contextTokens: Math.floor(value.contextTokens) }
      : {}),
    ...(typeof value.outputTokens === "number" && value.outputTokens > 0
      ? { outputTokens: Math.floor(value.outputTokens) }
      : {}),
  };
}

/** Read the first implementation's `agent`/`endpoint` shape without requiring migration. */
function readLegacyAgent(value: unknown, problems: string[]): AiConfig | null {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) {
    problems.push(`config.json: "agent" is not an object`);
    return null;
  }
  if (typeof value.endpoint !== "string" || typeof value.model !== "string") {
    problems.push(`config.json: "agent" needs endpoint and model strings`);
    return null;
  }
  return {
    provider: typeof value.provider === "string" ? value.provider : "configured",
    router: value.endpoint,
    api: "openai-chat-completions",
    model: value.model,
    ...(typeof value.apiKey === "string" ? { apiKey: value.apiKey } : {}),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The defaults, as a config file says them — what `:config` writes.
 *
 * Here rather than anywhere else because this is the file that knows the
 * format, and a seed written by a second understanding of it is a seed that
 * can be wrong about the thing it is demonstrating.
 *
 * What it writes is a *snapshot*, and the reason `:config` is a command you
 * type rather than something that happens at first launch: a file naming every
 * key stops tracking the defaults the moment one of them moves, and doing that
 * to everybody automatically would make the layering above pointless for
 * everybody. Asked for, it is a starting point; written silently, it is a copy
 * of an old keymap nobody remembers agreeing to.
 */
export function defaultConfigText(): string {
  return `${JSON.stringify({
    keys: DEFAULT_KEYS,
    ai: {
      provider: "ollama",
      router: "http://localhost:11434/v1/chat/completions",
      api: "openai-chat-completions",
      model: "qwen3:8b",
      contextTokens: 12000,
      outputTokens: 700,
    },
  }, null, 2)}\n`;
}

/**
 * Every key `name` is on, in the order the keymap lists them — for the help
 * sheet, which has to show the keys somebody actually has rather than the ones
 * this app shipped with (see Keymap.tsx).
 */
export function keysFor(name: string, keys: Record<string, string>): string[] {
  return Object.keys(keys).filter((key) => keys[key] === name);
}

/** The chord prefixes, as they are drawn rather than as they are stored. */
const GLYPHS: [prefix: string, glyph: string][] = [
  ["C-", "⌃"],
  ["M-", "⌘"],
];

/**
 * A key as it should be read: `M-p` is ⌘P and `M-Z` is ⇧⌘Z.
 *
 * The shift is inferred from the letter rather than stored, because that is
 * where the keyboard puts it — an event for ⇧⌘Z arrives as a capital `Z` and
 * no other flag — and a reader who has to work out that `M-Z` is the shifted
 * one is a reader the sheet has failed.
 */
export function keyLabel(key: string): string {
  let rest = key;
  let prefix = "";
  for (const [mark, glyph] of GLYPHS) {
    if (rest.startsWith(mark)) {
      prefix += glyph;
      rest = rest.slice(mark.length);
    }
  }
  // Only where a chord is involved: a bare `A` is `A`, which is how the writing
  // keys have always been written down and reads as the shifted key it is.
  if (prefix && rest.length === 1 && rest !== rest.toLowerCase()) prefix = `⇧${prefix}`;
  return prefix ? `${prefix}${rest.toUpperCase()}` : rest;
}
