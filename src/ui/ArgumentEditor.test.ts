import { describe, expect, it } from "vitest";
import { blocksFromPaste } from "./ArgumentEditor";

describe("blocksFromPaste", () => {
  it("turns clipboard lines into sibling argument text", () => {
    expect(blocksFromPaste("before after", 7, 7, "one\ntwo\nthree")).toEqual([
      "before one",
      "two",
      "threeafter",
    ]);
  });

  it("keeps internal blanks without making a block for a terminal newline", () => {
    expect(blocksFromPaste("", 0, 0, "one\n\ntwo\n")).toEqual(["one", "", "two"]);
  });
});
