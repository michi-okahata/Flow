import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { layoutFlow, measureRows } from "../layout/grid";
import { selectionRange, threadOf } from "../layout/navigate";
import { type Argument, type Placed, type Speech } from "../model/types";
import type { Peer } from "../sync/presence";
import type { AgentDraft } from "../agent/types";
import { agentDraftRoots } from "../agent/draft";

/** A little separation between arguments without opening up the dense flow. */
const ROW_GAP = 2;

const scaled = (px: number, zoom: number) => px * zoom;

interface FlowSheetProps {
  roots: Argument[];
  /** The columns, in order: what each speech is called and how wide it gets. */
  speeches: Speech[];
  renderArgument?: (arg: Argument) => React.ReactNode;
  /**
   * The layout for `roots`. Optional — pass it when the caller already needs
   * the layout (for cursor navigation, say) so it isn't computed twice.
   */
  placed?: Placed[];
  /** The argument to keep on screen. The sheet scrolls to follow it. */
  cursorId?: string | null;
  /**
   * The speech the cursor is standing in when it is on no argument — a speech
   * nobody has written in yet (see `EditorState.column`). Drawn as an empty
   * cursor cell at the top of that column: there is no argument to highlight,
   * and the one thing the sheet has to say is where the next one would go.
   */
  column?: number | null;
  /**
   * Where a visual selection began, or null/undefined when there isn't one.
   * The selected arguments are derived from this and `cursorId` (see
   * `selectionRange`) rather than passed as a list — same reasoning as the
   * editor state that owns it (see `EditorState.selectAnchor`).
   */
  selectAnchor?: string | null;
  /**
   * How large to draw the sheet, as a multiple of its authored size. The type
   * itself is scaled in CSS; this is here for the metrics that can't be.
   */
  zoom?: number;
  /**
   * Everyone else in the room. Drawn where their cursors are — the sheet is
   * the only place that answer means anything, and a list of names in a corner
   * would make you look away from the flow to read it.
   */
  peers?: Peer[];
  /** Generated responses that have not entered the CRDT yet. */
  drafts?: AgentDraft[];
}

export function FlowSheet({
  roots,
  speeches,
  renderArgument,
  placed: placedProp,
  cursorId,
  column = null,
  selectAnchor = null,
  zoom = 1,
  peers = [],
  drafts = [],
}: FlowSheetProps): React.ReactElement {
  const draftIndex = new Map<string, { draft: AgentDraft; index: number }>();
  for (const draft of drafts) {
    for (const [index] of (draft.status === "ready" ? draft.answers : [""]).entries()) {
      draftIndex.set(`agent-draft:${draft.requestId}:${index}`, { draft, index });
    }
  }
  const visualRoots = useMemo(
    () => (drafts.length ? agentDraftRoots(roots, drafts) : roots),
    [roots, drafts],
  );
  const ownPlaced = useMemo(
    () => (placedProp && drafts.length === 0 ? [] : layoutFlow(visualRoots)),
    [visualRoots, placedProp, drafts.length],
  );
  const placed = placedProp && drafts.length === 0 ? placedProp : ownPlaced;

  // The selected arguments, if any — everything between the anchor and the
  // cursor, top to bottom (`selectionRange` walks the column in that order
  // regardless of which end the anchor is on). Drawn as one band spanning the
  // first to the last, below, rather than a wash per cell: a selection is one
  // idea, and a gap of bare sheet between two selected cells read as "these
  // are two separate things," not "here is what's selected."
  const selection = useMemo(
    () => selectionRange(placed, selectAnchor, cursorId ?? null),
    [placed, selectAnchor, cursorId],
  );

  // What the cursor's argument answers, and what answers it — drawn as a
  // tinted rule on each, so the exchange the cursor is in can be read off the
  // sheet without moving it. See `threadOf`.
  const thread = useMemo(() => threadOf(visualRoots, cursorId ?? null), [visualRoots, cursorId]);

  // Which speech the cursor is in, so its header can say so. The headers are
  // sticky and therefore the one part of a column that is always on screen —
  // which makes them the cheapest possible answer to "where am I", and the only
  // one that survives scrolling to the bottom of a long flow.
  const cursorCol = useMemo(
    () => placed.find((p) => p.id === cursorId)?.col ?? column,
    [placed, cursorId, column],
  );

  const byId = useMemo(() => {
    const m = new Map<string, Argument>();
    const walk = (n: Argument) => {
      m.set(n.id, n);
      n.children.forEach(walk);
    };
    visualRoots.forEach(walk);
    return m;
  }, [visualRoots]);

  // Where everyone else is, keyed by the argument they're on — grouped,
  // because two peers can be on one argument and the cell has to be told
  // about that rather than styled twice.
  //
  // Peers on an argument this sheet hasn't got yet are dropped: a cursor
  // arrives in a presence message, which can beat the argument it points at
  // through the relay by a tick.
  const peersByArgument = useMemo(() => {
    const placedIds = new Set(placed.map((p) => p.id));
    const groups = new Map<string, Peer[]>();
    for (const peer of peers) {
      if (!peer.cursorId || !placedIds.has(peer.cursorId)) continue;
      const group = groups.get(peer.cursorId);
      if (group) group.push(peer);
      else groups.set(peer.cursorId, [peer]);
    }
    return groups;
  }, [peers, placed]);

  // Cells are `align-self: start`, so each cell's box is its argument's
  // natural height — measuring it can't feed back into the track sizes we set.
  const cellRefs = useRef(new Map<string, HTMLDivElement>());

  // One ref callback per argument, kept. Written inline it would be a new
  // function on every render, and React detaches and re-attaches a ref whose
  // identity changed — every cell on the sheet, thirty times a second while a
  // motion key is held down (see useKeymap), to end up with the same map it
  // started with. Each one drops itself when its cell goes.
  const cellRefFns = useRef(new Map<string, (el: HTMLDivElement | null) => void>());
  const cellRef = (id: string) => {
    let fn = cellRefFns.current.get(id);
    if (!fn) {
      fn = (el: HTMLDivElement | null) => {
        if (el) cellRefs.current.set(id, el);
        else {
          cellRefs.current.delete(id);
          cellRefFns.current.delete(id);
        }
      };
      cellRefFns.current.set(id, fn);
    }
    return fn;
  };
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [rowHeights, setRowHeights] = useState<number[]>([]);
  const rowGap = scaled(ROW_GAP, zoom);

  const visibleCols = useMemo(() => speeches.map((_, i) => i), [speeches]);
  const colPos = useMemo(() => {
    const m = new Map<number, number>();
    visibleCols.forEach((col, i) => m.set(col, i + 1));
    return m;
  }, [visibleCols]);

  useLayoutEffect(() => {
    const remeasure = () => {
      const heights = new Map<string, number>();
      for (const p of placed) {
        const el = cellRefs.current.get(p.id);
        if (!el) continue;
        const height = el.getBoundingClientRect().height;
        heights.set(p.id, height);
      }
      const next = measureRows(placed, heights, rowGap);
      setRowHeights((prev) =>
        prev.length === next.length && prev.every((h, i) => Math.abs(h - next[i]) < 0.5)
          ? prev
          : next,
      );
    };

    remeasure();
    // Observe cells too: editor changes can resize content without resizing
    // the grid, whose tracks retain measured minima.
    const ro = new ResizeObserver(remeasure);
    if (gridRef.current) ro.observe(gridRef.current);
    for (const el of cellRefs.current.values()) ro.observe(el);
    return () => ro.disconnect();
    // Zoom also changes cell metrics even when the viewport stays the same.
  }, [placed, rowGap]);

  // Keep the cursor on screen. `nearest` means this only scrolls when the
  // argument has actually gone off the edge — moving around inside the
  // visible sheet doesn't drag the page around. Re-runs on `rowHeights` too,
  // since an argument that grows while being typed in can push itself out of
  // frame.
  useEffect(() => {
    if (!cursorId) return;
    cellRefs.current
      .get(cursorId)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [cursorId, rowHeights]);

  const headerOffset = 1;
  // A `1fr` track after the last argument, holding no arguments and existing
  // only to take up whatever height is left: it is what lets the side bands
  // run to the bottom of the window on a flow that doesn't fill it. Without it
  // the grid is exactly as tall as its arguments, and the bands stop in
  // mid-air at the last row — which reads as the sheet ending rather than the
  // speech being empty.
  //
  // `rowHeights.length` stands in for "the first measurement has landed", so
  // the template stays `undefined` (and the bands sit on the header alone —
  // see .flow-band) until it has. That signal never fires on a genuinely
  // empty flow: there is nothing to measure, so the *correct* measurement is
  // itself a zero-length array, indistinguishable from "not measured yet".
  // `placed.length === 0` is decidable up front, without waiting on an
  // effect, so it skips the wait rather than hanging in it forever.
  // Row tracks are `minmax(measured, auto)` rather than fixed pixels: typing
  // grows the editing cell locally, and `remeasure` above only runs when
  // `placed` (or the grid's width) changes — a keystroke that soft-wraps the
  // text hits *between* measures. With a fixed track the taller cell
  // overflows its row and paints over the argument below until the throttled
  // write lands and the rows catch up; with `auto` as the max the track
  // itself grows in the same paint, so the arguments below are pushed down
  // instead of painted over. The measured height stays as the minimum, and
  // the next measure adopts the new height as the baseline.
  const gridTemplateRows =
    placed.length === 0
      ? "auto 1fr"
      : rowHeights.length
        ? ["auto", ...rowHeights.map((h) => `minmax(${h}px, auto)`), "1fr"].join(" ")
        : undefined;

  return (
    // Columns keep a stable authored width. The flow pane scrolls horizontally
    // when the round is wider than the available workspace.
    <div
      ref={gridRef}
      className="flow-grid"
      style={{
        // Each speech at least its zoomed width, and sharing out whatever the
        // pane has beyond that, so a zoomed-out flow fills the screen rather
        // than stopping short of it.
        gridTemplateColumns: visibleCols.map(() => `minmax(${150 * zoom}px, 1fr)`).join(" "),
        gridTemplateRows,
        rowGap: `${rowGap}px`,
      }}
    >
      {/* The side bands, first so everything else paints over them. Each one
          runs the full height of its column, filler track included: the empty
          parts of a speech are as much a part of reading it as the arguments
          are.

          `1 / -1` needs an explicit grid to reach the end of, and there isn't
          one on the first paint — before the arguments are measured there are
          no row tracks, so the band spans the header row alone until the
          measure lands a tick later. */}
      {visibleCols.map((i) => (
        <div
          key={`b-${i}`}
          className={`flow-band is-${speeches[i].side}`}
          style={{
            gridColumn: colPos.get(i),
            gridRow: gridTemplateRows ? "1 / -1" : "1 / span 1",
          }}
        />
      ))}

      {visibleCols.map((i) => (
        <div
          key={`h-${i}`}
          className={`flow-header is-${speeches[i].side}${
            i === cursorCol ? " is-current" : ""
          }`}
          // Cancel the grid gap immediately below the headers. Argument rows
          // still keep the gap between one another.
          style={{ gridColumn: colPos.get(i), marginBottom: `${-rowGap}px` }}
        >
          {speeches[i].label}
        </div>
      ))}

      {/* The selection, one band from the first selected argument to the last
          — a `gridRow` range rather than `span`, so it covers the row gaps
          between them too, the same way a spanning argument's own box does.
          Behind the cells (it comes first here), so the cursor's own,
          stronger highlight still shows through on top of it. */}
      {selection.length > 0 && (
        <div
          className="flow-selection"
          style={{
            gridColumn: colPos.get(selection[0].col),
            gridRow: `${selection[0].row + 1 + headerOffset} / ${
              selection[selection.length - 1].row +
              selection[selection.length - 1].span +
              1 +
              headerOffset
            }`,
          }}
        />
      )}

      {placed.map((p) => {
          const arg = byId.get(p.id)!;
          // Somebody else's cursor, if one is here. Their cursor is drawn the
          // way yours is — the rule, the wash, the hairline — in their colour
          // instead of the accent, so "where is my partner" is answered by
          // the same shape you already read your own position from, and
          // nothing is added to the sheet that has to be looked at
          // separately. Who they are is on the status line; the sheet only
          // says where.
          //
          // The first of them when several share an argument: the colour has
          // one slot, and the list of names is downstairs.
          const peer = peersByArgument.get(p.id)?.[0];
          return (
            <div
              key={p.id}
              ref={cellRef(p.id)}
              // The cursor is worn by the cell rather than by the argument,
              // so that the number is inside the highlight — see the
              // stylesheet. Selection itself isn't a per-cell class any more
              // — see `.flow-selection`, above.
              className={`flow-cell is-${speeches[p.col].side}${p.id === cursorId ? " is-cursor" : ""}${
                thread.has(p.id) ? " is-thread" : ""
              }${arg.support === "analytic" ? " is-analytic" : ""}${
                arg.important ? " is-important" : ""
              }${
                peer ? " is-peer" : ""
              }${peer?.editing ? " is-peer-editing" : ""}`}
              title={
                peer ? `${peer.name}${peer.editing ? " is writing here" : " is here"}` : undefined
              }
              // Placement comes from `layoutFlow` — inherently per-node, so it
              // cannot live in a stylesheet.
              style={{
                gridColumn: colPos.get(p.col),
                gridRow: `${p.row + 1 + headerOffset} / span ${p.span}`,
                // The peer's own colour, handed to the stylesheet — it is per
                // peer, so it cannot be authored there. See peers.css.
                ...(peer && ({ "--peer": peer.color } as CSSProperties)),
              }}
            >
              {/* Only when there is one to draw. The mark is text now — it
                  takes the room its characters need and no more — so an
                  unmarked argument simply starts with its first word. */}
              {draftIndex.has(p.id) ? (
                <div className="flow-argument flow-argument--agent" aria-live="polite">
                  {arg.text || (draftIndex.get(p.id)?.draft.status === "error" ? draftIndex.get(p.id)?.draft.error : "thinking…")}
                  {draftIndex.get(p.id)?.draft.status === "ready" && draftIndex.get(p.id)?.index === 0 && (
                    <span className="flow-agent-hint">Tab ×{draftIndex.get(p.id)?.draft.answers.length}</span>
                  )}
                </div>
              ) : renderArgument ? renderArgument(arg) : <DefaultArgument text={arg.text} />}
            </div>
          );
        })}


    </div>
  );
}

function DefaultArgument({ text }: { text: string }): React.ReactElement {
  return <div className="flow-argument">{text}</div>;
}
