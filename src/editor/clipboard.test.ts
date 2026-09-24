import { expect, it } from "vitest";
import { copiedText } from "./clipboard";

it("copies a block tree as one argument per line", () => {
  expect(copiedText([{
    text: "top",
    mark: "none",
    support: "analytic",
    speech: 0,
    children: [{
      text: "answer",
      mark: "none",
      support: "card",
      speech: 1,
      children: [],
    }],
  }])).toBe("top\nanswer");
});
