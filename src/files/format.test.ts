import { describe, expect, it } from "vitest";
import {
  FORMAT,
  decodeSheet,
  encodeSheet,
  fileNameFor,
  roundFrom,
  sortSheets,
  type SheetJson,
} from "./format";
import type { Argument } from "../model/types";

/**
 * What a sheet survives on its way to disk and back.
 *
 * The stakes here are higher than anywhere else in the app: this is the only
 * code whose bugs outlive the session. A layout mistake is visible and a
 * keymap mistake is undoable, but a sheet written wrong is a round you can't
 * read next week.
 */

function arg(text: string, speech: number, rest: Partial<Argument> = {}): Argument {
  return {
    id: text,
    speech,
    text,
    mark: "none",
    support: "card",
    children: [],
    ...rest,
  };
}

/** A sheet as it comes back off disk, with every field spelled out. */
function sheetJson(over: Partial<SheetJson> = {}): SheetJson {
  return { flow: FORMAT, title: "untitled", order: 0, arguments: [], ...over };
}

describe("encodeSheet", () => {
  it("writes indented JSON, newline-terminated", () => {
    // These files are meant to be read and diffed — a flow on one line is
    // neither.
    const text = encodeSheet({ title: "Case", order: 0, roots: [] });
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('\n  "title": "Case"');
  });

  it("leaves out what is already the default", () => {
    // A round nobody pressed `c` on should not gain a line per argument saying
    // so, and an argument nothing answers should not carry an empty list.
    const text = encodeSheet({
      title: "Case",
      order: 0,
      roots: [arg("plan tanks the economy", 0)],
    });
    expect(text).not.toContain("support");
    expect(text).not.toContain("children");
  });

  it("writes the support only when it isn't a card", () => {
    const text = encodeSheet({
      title: "Case",
      order: 0,
      roots: [arg("no internal link", 1, { support: "analytic" })],
    });
    expect(JSON.parse(text).arguments[0].support).toBe("analytic");
  });
});

describe("decodeSheet", () => {
  it("brings a written sheet back unchanged", () => {
    const roots = [
      arg("plan tanks the economy", 0, {
        mark: "num",
        children: [
          arg("no internal link", 1, { mark: "num", support: "analytic" }),
          arg("econ decline → war", 1, { mark: "alpha" }),
        ],
      }),
    ];
    const back = decodeSheet(encodeSheet({ title: "Case", order: 2, roots }));
    expect(back).toEqual(
      sheetJson({
        title: "Case",
        order: 2,
        arguments: [
          {
            text: "plan tanks the economy",
            speech: 0,
            mark: "num",
            support: "card",
            children: [
              { text: "no internal link", speech: 1, mark: "num", support: "analytic", children: [] },
              { text: "econ decline → war", speech: 1, mark: "alpha", support: "card", children: [] },
            ],
          },
        ],
      }),
    );
  });

  it("is nothing for a file that isn't JSON", () => {
    expect(decodeSheet("not a sheet")).toBeNull();
    expect(decodeSheet("")).toBeNull();
  });

  it("is nothing for JSON that never claimed to be a flow", () => {
    // The directory is the user's. Somebody else's JSON must not be read as a
    // sheet and then written back over.
    expect(decodeSheet('{"title": "Case", "arguments": []}')).toBeNull();
    expect(decodeSheet("[1, 2, 3]")).toBeNull();
  });

  it("refuses a sheet from a later version rather than half-reading it", () => {
    expect(decodeSheet(JSON.stringify({ flow: FORMAT + 1, arguments: [] }))).toBeNull();
  });

  it("loses a bad field rather than the whole sheet", () => {
    // A hand-edited file with a typo in it should still open.
    const back = decodeSheet(
      JSON.stringify({
        flow: FORMAT,
        title: 7,
        order: "second",
        arguments: [{ text: "we meet", speech: -3, mark: "roman" }],
      }),
    );
    expect(back).toEqual(
      sheetJson({
        title: "untitled",
        order: 0,
        // The column is floored at 0: an argument that can't be drawn is worse
        // than one drawn in the 1AC.
        arguments: [{ text: "we meet", speech: 0, mark: "num", support: "card", children: [] }],
      }),
    );
  });

  it("reads a sheet written before support existed as carded", () => {
    // "absent" and "card" already meant the same thing, which is why this
    // needed no version bump.
    const back = decodeSheet(
      JSON.stringify({
        flow: FORMAT,
        title: "Case",
        order: 0,
        arguments: [{ text: "we meet", speech: 0, mark: "num" }],
      }),
    );
    expect(back?.arguments[0].support).toBe("card");
  });

  it("reads an unmarked argument as numbered, not as unmarked", () => {
    // Numbering used to be unconditional, so a sheet from back then was drawn
    // numbered all the way down — see LEGACY_MARK.
    const back = decodeSheet(
      JSON.stringify({ flow: FORMAT, arguments: [{ text: "we meet", speech: 0 }] }),
    );
    expect(back?.arguments[0].mark).toBe("num");
  });
});

describe("sortSheets", () => {
  const named = (name: string, order: number) => ({ name, sheet: sheetJson({ order }) });

  it("puts the sheets in the order the files claim", () => {
    const files = [named("t.json", 2), named("case.json", 0), named("da.json", 1)];
    expect(sortSheets(files).map((f) => f.name)).toEqual(["case.json", "da.json", "t.json"]);
  });

  it("settles a tie by file name, so a folder opens the same way twice", () => {
    const files = [named("politics.json", 0), named("case.json", 0)];
    expect(sortSheets(files).map((f) => f.name)).toEqual(["case.json", "politics.json"]);
  });

  it("leaves the caller's array alone", () => {
    const files = [named("t.json", 2), named("case.json", 0)];
    sortSheets(files);
    expect(files.map((f) => f.name)).toEqual(["t.json", "case.json"]);
  });
});

describe("fileNameFor", () => {
  it("lowercases and hyphenates the title", () => {
    expect(fileNameFor("Politics DA", new Set())).toBe("politics-da.json");
  });

  it("drops punctuation rather than putting it in a file name", () => {
    expect(fileNameFor("T — Substantial!", new Set())).toBe("t-substantial.json");
  });

  it("falls back for a title with nothing nameable in it", () => {
    expect(fileNameFor("—", new Set())).toBe("sheet.json");
    expect(fileNameFor("", new Set())).toBe("sheet.json");
  });

  it("numbers around a name already claimed", () => {
    // Two sheets can share a title mid-round. They cannot share a file.
    const taken = new Set(["untitled.json"]);
    expect(fileNameFor("untitled", taken)).toBe("untitled-2.json");
    taken.add("untitled-2.json");
    expect(fileNameFor("untitled", taken)).toBe("untitled-3.json");
  });
});

describe("roundFrom", () => {
  it("builds a round whose sheets read back as they were written", () => {
    const sheets = [
      sheetJson({
        title: "Case",
        arguments: [
          {
            text: "plan tanks the economy",
            speech: 0,
            mark: "num",
            support: "card",
            children: [
              { text: "no internal link", speech: 1, mark: "num", support: "analytic", children: [] },
            ],
          },
        ],
      }),
      sheetJson({ title: "T-Substantial", order: 1 }),
    ];

    const round = roundFrom(sheets);
    expect(round.sheets().map((sheet) => sheet.title)).toEqual(["Case", "T-Substantial"]);

    const roots = round.flow(round.sheets()[0].id).roots();
    expect(roots).toHaveLength(1);
    expect(roots[0].text).toBe("plan tanks the economy");
    expect(roots[0].mark).toBe("num");
    expect(roots[0].children.map((child) => [child.text, child.speech, child.support])).toEqual([
      ["no internal link", 1, "analytic"],
    ]);
  });

  it("survives a full trip through a directory", () => {
    // The round trip that matters: a round written out, read back, and written
    // again should produce the same files.
    const contents = [
      { title: "Case", order: 0, roots: [arg("plan tanks the economy", 0, { mark: "num" })] },
      { title: "T-Substantial", order: 1, roots: [arg("we meet — plan is 4%", 2)] },
    ];
    const written = contents.map(encodeSheet);
    const round = roundFrom(written.map((text) => decodeSheet(text)!));
    const again = round
      .sheets()
      .map((sheet, order) =>
        encodeSheet({ title: sheet.title, order, roots: round.flow(sheet.id).roots() }),
      );
    expect(again).toEqual(written);
  });
});
