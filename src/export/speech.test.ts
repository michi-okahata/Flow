import { describe, expect, it } from "vitest";
import { Round } from "../model/round";
import { speechPositions } from "./speech";

describe("speech export plan", () => {
  it("groups a speech under AT blocks while retaining evidence support", () => {
    const round = new Round();
    const id = round.addSheet("Politics DA");
    const flow = round.flow(id);
    const parent = flow.addRoot(null, "Uniqueness", 1);
    const card = flow.addResponse(parent, "No link", 2);
    flow.setSupports([card], "card");
    const analytic = flow.addResponse(parent, "Their model double counts", 2);
    flow.setSupports([analytic], "analytic");

    const [position] = speechPositions(round, round.sheets(), 2);
    expect(position.blocks).toEqual([{
      parent: "AT: Uniqueness",
      key: "uniqueness",
      lines: [
        { text: "No link", support: "card" },
        { text: "Their model double counts", support: "analytic" },
      ],
    }]);
    expect(position.cards).toBe(1);
    expect(position.lines).toBe(2);
  });
});
