import { describe, expect, it } from "vitest";
import type { Argument, Mark, Support } from "../model/types";
import { layoutFlow, markIndices, markerOf, measureRows } from "./grid";

/**
 * The geometry, on its own. Everything here is a pure function over plain
 * arguments — no CRDT, no React — which is the whole reason the layout was
 * split out in the first place (see the note at the top of grid.ts).
 */

/** An argument, with only the parts a layout cares about spelled out. */
function arg(
  id: string,
  speech: number,
  options: { mark?: Mark; support?: Support; children?: Argument[] } = {},
): Argument {
  return {
    id,
    speech,
    text: id,
    mark: options.mark ?? "none",
    support: options.support ?? "card",
    children: options.children ?? [],
  };
}

/** `markIndices` keyed by id is awkward to assert against; this reads it in order. */
function indicesOf(siblings: Argument[]): (number | null)[] {
  const indices = markIndices(siblings);
  return siblings.map((sibling) => indices.get(sibling.id) ?? null);
}

describe("markIndices", () => {
  it("numbers a run and skips the unmarked without spending a place", () => {
    expect(
      indicesOf([
        arg("a", 0, { mark: "num" }),
        arg("b", 0, { mark: "none" }),
        arg("c", 0, { mark: "num" }),
      ]),
    ).toEqual([1, null, 2]);
  });

  it("gives a lone marked argument a place rather than nothing", () => {
    // The mark is itself the claim — "this is my first, more may follow" — so
    // it draws a 1 even with no second argument to be first of.
    expect(indicesOf([arg("only", 0, { mark: "num" })])).toEqual([1]);
  });

  it("carries a numbered run across a lettered digression", () => {
    // The first worked example in grid.ts: a digression does not end the
    // argument you were making, so `3` follows `2` rather than restarting.
    expect(
      indicesOf([
        arg("perm", 0, { mark: "num" }),
        arg("turn", 0, { mark: "num" }),
        arg("nonunique", 0, { mark: "alpha" }),
        arg("their-ev", 0, { mark: "alpha" }),
        arg("no-impact", 0, { mark: "num" }),
      ]),
    ).toEqual([1, 2, 1, 2, 3]);
  });

  it("starts the alphabet over after a numbered point breaks it", () => {
    // The second worked example: an aside is always local, so a fresh `num`
    // means a fresh alphabet rather than a `c`.
    expect(
      indicesOf([
        arg("perm", 0, { mark: "num" }),
        arg("nonunique", 0, { mark: "alpha" }),
        arg("no-link", 0, { mark: "alpha" }),
        arg("turn", 0, { mark: "num" }),
        arg("concedes", 0, { mark: "alpha" }),
      ]),
    ).toEqual([1, 1, 2, 2, 1]);
  });

  it("counts each speech column separately", () => {
    // Siblings arrive in document order with every column mixed together, so
    // an answer in the 2AC must not take its number from the 1NC beside it.
    expect(
      indicesOf([
        arg("first-1nc", 1, { mark: "num" }),
        arg("first-2ac", 2, { mark: "num" }),
        arg("second-1nc", 1, { mark: "num" }),
        arg("second-2ac", 2, { mark: "num" }),
      ]),
    ).toEqual([1, 1, 2, 2]);
  });
});

describe("markerOf", () => {
  it("writes nothing for an unmarked argument", () => {
    expect(markerOf(null, "num")).toBe("");
    expect(markerOf(1, "none")).toBe("");
  });

  it("writes numbers and letters", () => {
    expect(markerOf(3, "num")).toBe("3");
    expect(markerOf(1, "alpha")).toBe("a");
    expect(markerOf(26, "alpha")).toBe("z");
  });

  it("runs past z rather than running out", () => {
    // No flow will ever get here, but a sequence that ends is worse than one
    // that doesn't — see the note on `markerOf`.
    expect(markerOf(27, "alpha")).toBe("aa");
    expect(markerOf(28, "alpha")).toBe("ab");
    expect(markerOf(53, "alpha")).toBe("ba");
  });
});

describe("layoutFlow", () => {
  it("stacks unanswered roots one per row", () => {
    expect(layoutFlow([arg("one", 0), arg("two", 0)])).toEqual([
      { id: "one", col: 0, row: 0, span: 1, depth: 0, index: null },
      { id: "two", col: 0, row: 1, span: 1, depth: 0, index: null },
    ]);
  });

  it("puts a response beside its argument, one column right", () => {
    const placed = layoutFlow([
      arg("claim", 0, { children: [arg("answer", 1)] }),
    ]);
    expect(placed).toEqual([
      { id: "claim", col: 0, row: 0, span: 1, depth: 0, index: null },
      { id: "answer", col: 1, row: 0, span: 1, depth: 1, index: null },
    ]);
  });

  it("grows an argument's span to hold its answers", () => {
    // Three answers in one column need three rows, and the argument they
    // answer has to reach all of them.
    const placed = layoutFlow([
      arg("claim", 0, {
        children: [arg("a", 1), arg("b", 1), arg("c", 1)],
      }),
    ]);
    expect(placed.map((p) => [p.id, p.row, p.span])).toEqual([
      ["claim", 0, 3],
      ["a", 0, 1],
      ["b", 1, 1],
      ["c", 2, 1],
    ]);
  });

  it("takes the span from the tallest column, not the total", () => {
    // Two answers in the 1NC and one in the 2AC is two rows tall, not three:
    // the columns run alongside each other.
    const [claim] = layoutFlow([
      arg("claim", 0, {
        children: [arg("a", 1), arg("b", 1), arg("c", 2)],
      }),
    ]);
    expect(claim.span).toBe(2);
  });

  it("starts each root below everything the one above it reaches", () => {
    const placed = layoutFlow([
      arg("first", 0, { children: [arg("a", 1), arg("b", 1)] }),
      arg("second", 0),
    ]);
    expect(placed.find((p) => p.id === "second")?.row).toBe(2);
  });

  it("carries each argument's marker into its slot", () => {
    const placed = layoutFlow([
      arg("claim", 0, {
        children: [
          arg("a", 1, { mark: "num" }),
          arg("b", 1, { mark: "num" }),
        ],
      }),
    ]);
    expect(placed.map((p) => p.index)).toEqual([null, 1, 2]);
  });
});

describe("measureRows", () => {
  it("sizes a row from the tallest single-row argument in it", () => {
    const placed = layoutFlow([arg("one", 0), arg("two", 0)]);
    const heights = new Map([
      ["one", 20],
      ["two", 44],
    ]);
    expect(measureRows(placed, heights)).toEqual([20, 44]);
  });

  it("leaves a spanning argument's slack out of the rows it shares", () => {
    // The whole point (see the note on `measureRows`): a tall argument next to
    // short replies must not push those replies apart, so its leftover height
    // lands on its last row only.
    const placed = layoutFlow([
      arg("claim", 0, { children: [arg("a", 1), arg("b", 1)] }),
    ]);
    const heights = new Map([
      ["claim", 100],
      ["a", 20],
      ["b", 20],
    ]);
    expect(measureRows(placed, heights)).toEqual([20, 80]);
  });

  it("counts the gaps a spanning argument covers", () => {
    // An argument spanning two rows also covers the one gap between them, and
    // forgetting it leaves a few pixels of slack under every tall argument.
    const placed = layoutFlow([
      arg("claim", 0, { children: [arg("a", 1), arg("b", 1)] }),
    ]);
    const heights = new Map([
      ["claim", 100],
      ["a", 20],
      ["b", 20],
    ]);
    expect(measureRows(placed, heights, 8)).toEqual([20, 72]);
  });

  it("adds nothing when the rows already hold the argument", () => {
    const placed = layoutFlow([
      arg("claim", 0, { children: [arg("a", 1), arg("b", 1)] }),
    ]);
    const heights = new Map([
      ["claim", 30],
      ["a", 20],
      ["b", 20],
    ]);
    expect(measureRows(placed, heights)).toEqual([20, 20]);
  });
});
