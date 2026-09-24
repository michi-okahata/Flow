import type { Flow } from "../model/flow";
import type { Round, SheetInfo } from "../model/round";
import { type Copied, type Placed, type Speech } from "../model/types";
import { selectionRange } from "../layout/navigate";

/**
 * What the editor knows, and the rules that keep it coherent.
 *
 * Split from the keymap (see commands.ts) because far more code needs to
 * *read* this state than to change it — the status line, the sheet, the
 * argument renderer — and none of them should have to pull in every command to
 * do it.
 *
 * `releaseSelection` below is the coherence rule for things
 * that must hold after any cursor movement, whatever caused it. They live here
 * rather than inside the motions so that *every* way of moving the cursor
 * obeys them — a keystroke, a jump to a far speech, an argument created two
 * speeches over, a click.
 */

export interface EditorState {
  /** The argument the cursor sits on, or null when nothing is selected. */
  cursorId: string | null;
  /** The argument being text-edited, or null. Suspends the keymap while set. */
  editingId: string | null;
  /**
   * The speech the cursor is standing in when it is standing on no argument —
   * which is the only way to be somewhere on a sheet without being on one, and
   * it exists for the one place that has nothing to offer: a speech nobody has
   * written in yet. Until this, an empty column could not be reached at all —
   * `l` scans past it to the next column that has arguments, and a named jump
   * had nowhere to land — so the first argument of a speech could only be
   * started by knowing to count one out (`5n`).
   *
   * `:2nr` on an empty 2NR sets it, and so does `l` at the right-hand end of
   * what has been written; `n` spends it; anything that lands the cursor on a
   * real argument clears it (see `run`). Null whenever `cursorId` is set: the
   * two are one cursor, and an argument already knows its own speech.
   */
  column: number | null;
  /**
   * Digits typed but not yet spent. They name a speech to the commands that
   * create an argument (`4a` answers in the 4th speech, not the next one) and
   * a repeat count to the motions (`3j`). Null when nothing is pending.
   */
  count: number | null;
  /**
   * The command line's contents while it's open, or null when it isn't. Empty
   * string means open but nothing typed yet — which is why this can't just be
   * a string.
   */
  command: string | null;
  /**
   * Where a visual selection began, or null when there isn't one. The
   * selection itself is never stored as a list — it's derived, whenever a
   * command needs it, from this and `cursorId` (see `selectedIds` in
   * commands.ts and `selectionRange` in navigate.ts). An anchor and a moving
   * cursor is everything a range needs, and it can't go stale the way a
   * captured list of ids could as the flow changes underneath it.
   */
  selectAnchor: string | null;
  /**
   * What `y` took off the sheet, for `p` to put back, or null before anything
   * has been copied. Several arguments when a selection was yanked, each with
   * everything responding to it.
   *
   * Editor state rather than the document's, because a copy is yours: your
   * partner flowing the same round has their own, and neither should find the
   * other's under `p`. It outlives the sheet, though, where `openSheet` drops
   * everything else — carrying an argument from one position to another is most
   * of what this is for, and a copy that expired at the sheet boundary could
   * never do it.
   */
  yanked: Copied[] | null;
  /**
   * How many times the argument under an open editor has been rewritten by
   * something other than typing — which today is `recall` finishing it against
   * the block it found.
   *
   * A count rather than a flag because it is read as a *change*: the editor
   * seeds itself from the document once, on mount, so the only way to show it
   * text it did not type is to mount it again, and App keys the editor on this
   * to do exactly that (see App.tsx). A flag would have to be cleared by
   * somebody, and the somebody would be a render.
   *
   * Bumped only when the text really moved. A remount costs the caret its
   * place, which is a fair price for text appearing and no price at all worth
   * paying for a recall that completed nothing.
   */
  rewrites: number;
  /** Whether the list of sheets is showing. */
  sidebar: boolean;
  /**
   * Whether the sheet area is showing what you have memorized (`M`) instead of
   * the round.
   *
   * A flag rather than two apps, because what it swaps is only the *substrate*:
   * both are a round of sheets, so the layout, the keymap and the cursor carry
   * over whole and nothing downstream has to know which one it is looking at.
   * See useMemoryRound.ts.
   */
  memory: boolean;
  /**
   * Whether the keymap is up on screen (`:?`).
   *
   * Editor state rather than something App holds, because it is the same kind
   * of fact as `sidebar` — a way of looking at the sheet — and because the
   * keymap has to know: while it is showing it owns the keyboard, so that a
   * key pressed at a help screen can't land in a flow you can't see. See `run`.
   */
  help: boolean;
  /**
   * Where the cursor was on each sheet you've left, so coming back puts you
   * where you were rather than at the top.
   *
   * Kept here rather than with the sheets themselves because it is not a fact
   * about the round — your partner's cursor on the politics DA has nothing to
   * do with yours. Written only when a sheet is left (see `openSheet`), so a
   * cursor moving doesn't touch it thirty times a minute.
   */
  cursors: Record<string, string | null>;
  /**
   * How large the sheet is drawn, as a multiple of its authored size. 1 is the
   * 10px type the flow is designed at.
   *
   * A scale rather than a font size because everything about an argument is
   * bound to its type — the number gutter, the row gap, the width a collapsed
   * speech keeps — and they all have to move together or the sheet stops
   * lining up.
   */
  zoom: number;
}

export const initialEditorState: EditorState = {
  cursorId: null,
  editingId: null,
  column: null,
  count: null,
  command: null,
  selectAnchor: null,
  yanked: null,
  rewrites: 0,
  sidebar: true,
  memory: false,
  help: false,
  cursors: {},
  zoom: 1,
};

/**
 * The round, as the keymap is allowed to touch it: which sheets there are,
 * which one is open, and the two things a keystroke does to that list.
 *
 * Handed in rather than reached for, because opening a sheet is not a state
 * transition — it changes which document the whole app is looking at, and that
 * lives in the session (see FlowSession.setActiveSheet). The commands here
 * return the editor state that should go with it.
 */
export interface SheetControls {
  list: SheetInfo[];
  active: string | null;
  open: (sheetId: string) => void;
  move: (sheetId: string, by: number) => void;
}

/**
 * What the user has to hand, as the keymap is allowed to touch it: what answers
 * an argument.
 *
 * Narrower than `Memory`: a command only looks up one argument. Reading a
 * folder in is `:import`, which App runs.
 */
export interface MemoryControls {
  /**
   * The block answering an argument. Structural rather than a `Block`, and
   * exactly the three fields the keymap uses: the answers it inserts, and the
   * key and argument `completes` weighs to finish what you typed.
   */
  recall: (
    argument: string,
    position: string,
  ) => { block: { answers: string[]; key: string; argument: string } | null };
}

/**
 * Leaving one sheet for another: remember where the cursor was on the sheet
 * being left, and put it back where it was on the one being opened.
 *
 * Everything else is dropped: a selection, a count, a pinned speech and an open
 * editor are all about the sheet you were reading. Except what was yanked,
 * which is plain text rather than a pointer into a flow (see `Copied`) —
 * crossing to another position is what a debater copies an argument *for*.
 */
export function openSheet(
  state: EditorState,
  from: string | null,
  to: string,
): EditorState {
  const cursors = from ? { ...state.cursors, [from]: state.cursorId } : state.cursors;
  return {
    ...state,
    cursors,
    cursorId: cursors[to] ?? null,
    column: null,
    editingId: null,
    count: null,
    selectAnchor: null,
  };
}

export interface CommandContext {
  state: EditorState;
  flow: Flow;
  /**
   * The document the sheet belongs to. Only history reaches for it — undo is
   * the round's, not the sheet's, so undoing can carry you to another one.
   */
  round: Round;
  /** The round this sheet belongs to, as a list to move around in. */
  sheets: SheetControls;
  /** Saved and imported answers available to recall with ⌘P. */
  memory: MemoryControls;
  /**
   * The current layout. Only the motions need it — where an argument *sits* is
   * spatial. Anything that asks which speech an argument is in goes to the
   * flow, which owns that answer.
   */
  placed: Placed[];
  /** The speeches, in order. Their names are what the command line resolves. */
  speeches: Speech[];
}

export type Command = (ctx: CommandContext) => EditorState;

/**
 * Whether `state`'s selection still makes sense, and drop it if not — the
 * A click, a jump to a
 * named speech, or `h`/`l` leaving the column can each strand an anchor
 * somewhere the cursor no longer ranges over. `selectionRange` already treats
 * "no shared column" and "the anchor's argument is gone" as the same
 * not-a-range case, so emptiness is the one check this needs.
 */
export function releaseSelection(state: EditorState, placed: Placed[]): EditorState {
  if (state.selectAnchor === null) return state;
  const stillRanges = selectionRange(placed, state.selectAnchor, state.cursorId).length > 0;
  return stillRanges ? state : { ...state, selectAnchor: null };
}

/** Put the cursor on an argument from outside the keymap — a click — same rules. */
export function moveCursorTo(
  state: EditorState,
  id: string,
  placed: Placed[],
): EditorState {
  return releaseSelection({ ...state, cursorId: id, column: null }, placed);
}
