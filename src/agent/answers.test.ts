import { describe, expect, it } from "vitest";
import { parseAnswers } from "./useAgent";

describe("agent answer parsing", () => {
  it("accepts a bare answer array", () => {
    expect(parseAnswers('["one", "two"]')).toEqual(["one", "two"]);
  });

  it("extracts JSON from fences and explanatory text", () => {
    expect(parseAnswers('Here are the answers:\n```json\n["one", "two"]\n```'))
      .toEqual(["one", "two"]);
  });

  it("accepts compatible providers that wrap answers in an object", () => {
    expect(parseAnswers('{"answers":["one"]}')).toEqual(["one"]);
  });

  it("does not turn truncated JSON into a flow argument", () => {
    expect(parseAnswers('["one", "two')).toEqual([]);
  });

  it("keeps an ordinary prose response useful", () => {
    expect(parseAnswers("No link because the plan is too small."))
      .toEqual(["No link because the plan is too small."]);
  });
});
