import { describe, expect, it } from "vitest";
import { buildDictionary, completionAt, wordAt } from "./completion";

/**
 * Word completion, which is pure and needs no sheet: a dictionary, a string,
 * and where the caret is in it.
 */

const dict = buildDictionary(["circumvention is the 1NC's best argument"]);

describe("wordAt", () => {
  it("is the word being typed when the caret is at the end of the text", () => {
    expect(wordAt("solv", 4)).toEqual({ start: 0, word: "solv" });
    expect(wordAt("no link — circumv", 17)).toEqual({ start: 10, word: "circumv" });
  });

  it("is nothing below the minimum prefix", () => {
    expect(wordAt("a", 1)).toBeNull();
  });

  it("is nothing when the caret is inside a word", () => {
    expect(wordAt("solvency", 4)).toBeNull();
  });

  it("is nothing when anything follows the caret", () => {
    // The ghost draws the suggestion at the caret while the textarea above it
    // draws the real text there, so a suggestion offered here is painted on
    // top of words the user can see — which is what "it predicts several
    // words at once" turned out to be.
    expect(wordAt("solv deficit", 4)).toBeNull();
    expect(wordAt("solv\nand extend", 4)).toBeNull();
  });

  it("allows trailing whitespace, which nothing is drawn over", () => {
    expect(wordAt("solv   ", 4)).toEqual({ start: 0, word: "solv" });
    expect(wordAt("solv\n", 4)).toEqual({ start: 0, word: "solv" });
  });
});

describe("completionAt", () => {
  it("finishes the word at the caret and offers only the rest of it", () => {
    expect(completionAt("circumv", 7, dict)).toBe("ention");
  });

  it("prefers the words this flow has actually used", () => {
    // Both are in the standing vocabulary; only one is on the sheet.
    expect(completionAt("circ", 4, dict)).toBe("umvention");
  });

  it("offers nothing over text the caret is standing in front of", () => {
    expect(completionAt("circumv", 7, dict)).toBe("ention");
    expect(completionAt("circumv — no ev", 7, dict)).toBeNull();
  });
});
