import { describe, expect, it } from "vitest";
import {
  MIN_AGENT_WIDTH,
  MIN_COLUMN,
  SIDEBAR_WIDTH,
  flowCollapsed,
  flowFloor,
  flowRoom,
  snapAgentWidth,
  widestBesideFlow,
  type Frame,
} from "./panels";

const frame = (over: Partial<Frame> = {}): Frame => ({
  window: 1440,
  zoom: 1,
  sidebar: true,
  columns: 7,
  ...over,
});

describe("the flow's floor", () => {
  it("is one readable column per speech drawn", () => {
    expect(flowFloor(frame())).toBe(7 * MIN_COLUMN);
  });

  it("is lower for formats with fewer columns", () => {
    expect(flowFloor(frame({ columns: 3 }))).toBeLessThan(flowFloor(frame()));
  });

  it("grows with the zoom, like the columns it is made of", () => {
    expect(flowFloor(frame({ zoom: 2 }))).toBe(2 * flowFloor(frame()));
  });

  it("gives the sheet list's width back when the list is hidden", () => {
    expect(flowRoom(frame({ sidebar: false }), 400)).toBe(
      flowRoom(frame(), 400) + SIDEBAR_WIDTH,
    );
  });
});

describe("dragging the agent panel", () => {
  it("leaves a width alone while the flow still has its floor", () => {
    expect(snapAgentWidth(frame(), 500)).toBe(500);
  });

  it("holds at the widest width that still leaves a flow", () => {
    const most = widestBesideFlow(frame());
    // A few pixels past the edge is a drag that overshot, not a request to
    // lose the flow.
    expect(snapAgentWidth(frame(), most + 20)).toBe(most);
    expect(flowRoom(frame(), snapAgentWidth(frame(), most + 20))).toBe(flowFloor(frame()));
  });

  it("goes to the full width once the pointer is past halfway", () => {
    const most = widestBesideFlow(frame());
    const filled = snapAgentWidth(frame(), most + flowFloor(frame()));
    expect(filled).toBe(frame().window - SIDEBAR_WIDTH);
    expect(flowCollapsed(frame(), filled, true)).toBe(true);
  });

  it("never goes below the panel's own minimum, or past the window", () => {
    expect(snapAgentWidth(frame(), 10)).toBe(MIN_AGENT_WIDTH);
    expect(snapAgentWidth(frame(), 9999)).toBe(frame().window - SIDEBAR_WIDTH);
  });

  it("just drags when the window is too narrow to hold both", () => {
    // Nothing to snap to: no width here leaves a flow worth drawing.
    const tight = frame({ window: 620 });
    expect(widestBesideFlow(tight)).toBeLessThan(MIN_AGENT_WIDTH);
    expect(snapAgentWidth(tight, 400)).toBe(400);
  });
});

describe("collapsing the flow", () => {
  it("holds on while the flow has its floor", () => {
    expect(flowCollapsed(frame(), widestBesideFlow(frame()), true)).toBe(false);
  });

  it("steps out when the panels have taken the room", () => {
    expect(flowCollapsed(frame(), widestBesideFlow(frame()) + 1, true)).toBe(true);
  });

  it("counts the sheet list, not only the agent", () => {
    // The same panel width, with the list showing and without it.
    const agent = widestBesideFlow(frame({ sidebar: false }));
    expect(flowCollapsed(frame({ sidebar: false }), agent, true)).toBe(false);
    expect(flowCollapsed(frame(), agent, true)).toBe(true);
  });

  it("never collapses with the agent closed — there is nothing to give it to", () => {
    expect(flowCollapsed(frame({ window: 300 }), 0, false)).toBe(false);
  });
});
