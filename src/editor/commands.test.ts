import { describe, expect, it } from "vitest";
import { POLICY_SPEECHES } from "../model/format";
import { parseSessionCommand, resolveSheet, resolveSpeech } from "./commands";

/**
 * What the command line understands. Only the pure half is here — the parse and
 * the two resolvers — because everything else `submitCommand` reaches needs a
 * live round and a session behind it.
 */

describe("parseSessionCommand", () => {
  it("reads the commands that take no argument", () => {
    expect(parseSessionCommand("host")).toEqual({ kind: "host" });
    expect(parseSessionCommand("delete")).toEqual({ kind: "delete" });
    expect(parseSessionCommand("save")).toEqual({ kind: "save" });
    expect(parseSessionCommand("import")).toEqual({ kind: "import" });
    expect(parseSessionCommand("read")).toEqual({ kind: "read" });
    expect(parseSessionCommand("forget")).toEqual({ kind: "forget" });
  });

  it("ignores case and surrounding space", () => {
    expect(parseSessionCommand("  HOST  ")).toEqual({ kind: "host" });
  });

  it("is nothing when the word isn't a command", () => {
    // Which is how a speech name reaches `submitCommand` — anything this
    // doesn't claim is somewhere to jump to.
    expect(parseSessionCommand("2ac")).toBeNull();
    expect(parseSessionCommand("")).toBeNull();
  });

  it("takes the whole invitation as one argument", () => {
    expect(parseSessionCommand("join 192.168.1.42/k7fmqp")).toEqual({
      kind: "join",
      invitation: "192.168.1.42/k7fmqp",
    });
  });

  it("refuses the commands whose argument is the whole point", () => {
    expect(parseSessionCommand("join")).toBeNull();
    expect(parseSessionCommand("rename")).toBeNull();
    expect(parseSessionCommand("sheet")).toBeNull();
    expect(parseSessionCommand("name")).toBeNull();
  });

  it("keeps a title with spaces in it whole", () => {
    expect(parseSessionCommand("new politics DA")).toEqual({
      kind: "new",
      title: "politics DA",
    });
    expect(parseSessionCommand("rename  T —  substantial ")).toEqual({
      kind: "rename",
      title: "T — substantial",
    });
  });

  it("allows a bare :new, which is the untitled sheet", () => {
    expect(parseSessionCommand("new")).toEqual({ kind: "new", title: "" });
  });

  it("allows a bare :relay, which is the way back to the default", () => {
    expect(parseSessionCommand("relay")).toEqual({ kind: "relay", host: "" });
  });

  it("treats :solo as :leave", () => {
    expect(parseSessionCommand("solo")).toEqual({ kind: "leave" });
    expect(parseSessionCommand("leave")).toEqual({ kind: "leave" });
  });
});

describe("resolveSheet", () => {
  const sheets = [
    { id: "1", title: "Case" },
    { id: "2", title: "Politics DA — Midterms" },
    { id: "3", title: "T-Substantial" },
  ];

  it("finds a sheet by its exact title, ignoring case", () => {
    expect(resolveSheet("case", sheets)).toBe("1");
  });

  it("finds a sheet by a prefix", () => {
    expect(resolveSheet("pol", sheets)).toBe("2");
  });

  it("falls back to anything containing the text", () => {
    // A sheet called "Politics DA — Midterms" should answer to "midterms".
    expect(resolveSheet("midterms", sheets)).toBe("2");
  });

  it("prefers an exact title over a prefix of another", () => {
    const ambiguous = [
      { id: "long", title: "Case Neg" },
      { id: "short", title: "Case" },
    ];
    expect(resolveSheet("case", ambiguous)).toBe("short");
  });

  it("is nothing when nothing matches, and nothing on empty text", () => {
    expect(resolveSheet("kritik", sheets)).toBeNull();
    expect(resolveSheet("   ", sheets)).toBeNull();
  });
});

describe("resolveSpeech", () => {
  // The real format rather than a fixture: these labels are what the command
  // line is actually typed against, and "does :2 find the 2AC" is only a
  // question about them.
  const speeches = POLICY_SPEECHES;

  it("finds a speech by name, ignoring case", () => {
    expect(resolveSpeech("block", speeches)).toBe(3);
  });

  it("finds a speech by a prefix", () => {
    expect(resolveSpeech("blo", speeches)).toBe(3);
  });

  it("gives the first match in speech order, so :2 is the 2AC", () => {
    expect(resolveSpeech("2", speeches)).toBe(2);
  });

  it("is nothing when nothing matches", () => {
    expect(resolveSpeech("1nr", speeches)).toBeNull();
    expect(resolveSpeech("", speeches)).toBeNull();
  });
});
