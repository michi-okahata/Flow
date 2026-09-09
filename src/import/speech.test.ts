import { describe, expect, it } from "vitest";
import { Round } from "../model/round";
import { createSpeechFlows, type SpeechDocument } from "./speech";

const document: SpeechDocument = {
  path: "/round/1NC.cmir",
  speech: 1,
  speechLabel: "1NC",
  positions: [
    {
      title: "Politics",
      lines: [
        { text: "Election close now", support: "card" },
        { text: "Their evidence predates the link", support: "analytic" },
      ],
    },
    { title: "States CP", lines: [{ text: "States solve", support: "card" }] },
  ],
};

describe("createSpeechFlows", () => {
  it("creates only confirmed positions in the document's speech column", () => {
    const round = new Round();
    round.addSheet("untitled");

    const created = createSpeechFlows(round, document, new Set([0]));

    expect(round.sheets().map((sheet) => sheet.title)).toEqual(["Politics"]);
    const roots = round.flow(created[0]!).roots();
    expect(roots.map((root) => root.text)).toEqual([
      "Election close now",
      "Their evidence predates the link",
    ]);
    expect(roots.map((root) => root.speech)).toEqual([1, 1]);
    expect(roots.map((root) => root.support)).toEqual(["card", "analytic"]);
  });

  it("keeps a non-empty existing round alongside imported positions", () => {
    const round = new Round();
    const existing = round.addSheet("Case");
    round.flow(existing).add({ root: null }, { text: "plan", speech: 0 });

    createSpeechFlows(round, document, new Set([1]));

    expect(round.sheets().map((sheet) => sheet.title)).toEqual(["Case", "States CP"]);
  });
});
