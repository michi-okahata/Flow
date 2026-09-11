/**
 * How the window is shared out between the sheet list, the flow, and the agent.
 *
 * Pure arithmetic over plain numbers — no React, no DOM — for the same reason
 * as grid.ts: where a panel is allowed to come to rest is a rule, and a rule
 * belongs somewhere it can be stated once and tested.
 *
 * The rule itself: **a flow gets a minimum width or it does not get drawn.**
 * Every speech column is `minmax(0, 1fr)`, so a flow squeezed between a wide
 * agent panel and the sheet list does not stop at "cramped" — it goes on
 * shrinking until seven columns share a hundred pixels and not one of them
 * holds a word. That is worse than no flow at all, because it still looks like
 * the sheet and it still takes the space. So below the floor the flow steps
 * out and gives its width to the panel that wanted it.
 */

/** The sheet list's width, in the sheet's own units — see `--sidebar-width`,
    which App hands to the stylesheet so this number is only written once. */
export const SIDEBAR_WIDTH = 184;

/**
 * The narrowest a speech column can be and still be a column: about eight
 * characters at the sheet's own type size. Below this a column cannot hold the
 * shortest thing anyone flows — "perm do both" — on one line, and the sheet
 * stops being readable at a glance, which is the only thing it is for.
 */
export const MIN_COLUMN = 56;

/** The narrowest the agent panel goes. Its composer and thread strip stop
    working as anything below this. */
export const MIN_AGENT_WIDTH = 280;

export interface Frame {
  /** The window's inner width, in CSS pixels. */
  window: number;
  /** The sheet's zoom multiplier: every metric below is in sheet units. */
  zoom: number;
  /** Whether the sheet list is showing. */
  sidebar: boolean;
  /** Speech columns actually drawn — fewer under `f`, which is why a focused
      flow survives in a narrower space than a whole round does. */
  columns: number;
}

const sidebarWidth = (frame: Frame): number =>
  frame.sidebar ? SIDEBAR_WIDTH * frame.zoom : 0;

/** The width below which a flow is not worth drawing. */
export function flowFloor(frame: Frame): number {
  return Math.max(1, frame.columns) * MIN_COLUMN * frame.zoom;
}

/** What is left for the flow beside a sheet list and an agent panel. */
export function flowRoom(frame: Frame, agent: number): number {
  return frame.window - sidebarWidth(frame) - agent;
}

/** The widest the agent can be while the flow still has its floor. */
export function widestBesideFlow(frame: Frame): number {
  return frame.window - sidebarWidth(frame) - flowFloor(frame);
}

/**
 * Where a dragged agent panel comes to rest.
 *
 * There is a band of widths the panel may not stop in — the ones that would
 * leave the flow a sliver — so the drag snaps across it: it holds at the
 * widest width that still leaves a readable flow until the pointer is halfway
 * over, and then goes to the full width with the flow gone. Without the snap
 * that band would be dead travel in both directions, which reads as a broken
 * drag rather than as a rule.
 */
export function snapAgentWidth(frame: Frame, wanted: number): number {
  const fill = Math.max(MIN_AGENT_WIDTH, frame.window - sidebarWidth(frame));
  const want = Math.min(fill, Math.max(MIN_AGENT_WIDTH, wanted));
  const most = widestBesideFlow(frame);
  // A window this narrow has no width that leaves a flow worth drawing; there
  // is nothing to snap to, and the drag is only a drag.
  if (most < MIN_AGENT_WIDTH) return want;
  if (want <= most) return want;
  return want >= most + flowFloor(frame) / 2 ? fill : most;
}

/**
 * Whether the flow steps out.
 *
 * Only while the agent is showing: collapsing the flow is giving its width to
 * something, and with the agent closed there is nothing to give it to — a
 * window holding nothing but the sheet list is not an improvement on a cramped
 * flow, it is a window with no round in it.
 */
export function flowCollapsed(frame: Frame, agent: number, agentOpen: boolean): boolean {
  return agentOpen && flowRoom(frame, agent) < flowFloor(frame);
}
