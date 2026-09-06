import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { keyOf, repeatsWhileHeld, run, runsWhileEditing } from "../editor/commands";
import { selectionRange } from "../layout/navigate";
import type { CommandContext, EditorState } from "../editor/state";
import type { AgentDraft } from "../agent/types";

interface AgentKeys {
  drafts: AgentDraft[];
  generate: (argumentIds: string[]) => void;
  accept: (requestId?: string) => string | null;
  dismiss: (requestId?: string) => void;
}

/**
 * How a held motion key repeats: the wait before it starts, and the gap
 * between steps once it has.
 *
 * Ours rather than the operating system's. A flow is crossed by holding `j`,
 * and the system's repeat is tuned for holding a letter down in a word
 * processor — a quarter to half a second of nothing, then whatever rate the
 * Keyboard pane was left on. Both numbers are the feel of moving around a
 * sheet, so the app names them.
 *
 * The delay is short enough not to read as a stall and long enough that a
 * deliberate single `j` never becomes two. The rate is about thirty a second:
 * a full column in well under a second, and still slow enough to stop on the
 * argument you meant.
 */
const REPEAT_DELAY = 150;
const REPEAT_RATE = 30;

/**
 * Wire the keymap (see commands.ts) to the window.
 *
 * The whole of the DOM's involvement in vim-style control: everything about
 * what a key *does* is a pure state transition one layer down. This decides
 * only when the keyboard belongs to the editor at all — and, for the motions,
 * how fast a held key goes on meaning it.
 */
export function useKeymap(
  /**
   * The context, except that the flow may be missing — a round with no sheets
   * yet, which is what a peer sees for the moment between joining a room and
   * the snapshot arriving. There is nothing to act on then, so the keyboard
   * does nothing rather than every command having to ask.
   */
  ctx: Omit<CommandContext, "flow"> & { flow: CommandContext["flow"] | null },
  setEditor: Dispatch<SetStateAction<EditorState>>,
  /**
   * Write buffered keystrokes into the flow now. Called before running a key
   * that came from inside an open argument: typing is written through on a
   * timer (see useTextBuffer), and a command that reads the argument's text —
   * ⌘P does — must not read it as it stood a tick ago.
   */
  flushText: () => void,
  /** Which key does what, the user's config read over the defaults. */
  keys: Record<string, string>,
  agent?: AgentKeys,
): void {
  const { state, flow, round, placed, speeches, sheets, memory } = ctx;

  // What a repeat runs against, kept current by the render rather than
  // captured when the key went down: a hold that crosses into a wider column
  // should be moving through the layout as it is now. The cursor is the one
  // thing not read from here — see `step`.
  const latest = useRef({ round, placed, speeches, sheets, memory, flow, keys, agent });
  latest.current = { round, placed, speeches, sheets, memory, flow, keys, agent };

  // The key being held and its two timers. A ref because a key being down is
  // not something to render — the state each step produces already is.
  const held = useRef<{ key: string; delay?: number; tick?: number } | null>(null);

  const stop = useRef(() => {
    if (!held.current) return;
    window.clearTimeout(held.current.delay);
    window.clearInterval(held.current.tick);
    held.current = null;
  }).current;

  // One step of a held key. The state comes from the updater rather than from
  // `latest`, so a step is applied to what the *last* step produced even if
  // React hasn't finished rendering it — otherwise a slow frame makes a hold
  // repeat the same move from the same cursor and the sheet stalls under your
  // finger. Safe to run inside an updater, unlike the general case below, for
  // the reason `REPEATS` is the motions only: they are pure.
  const step = (key: string) => {
    const { keys: bound, flow: on, ...rest } = latest.current;
    if (!on) return stop();
    setEditor((prev) => run(key, { ...rest, flow: on, state: prev }, bound) ?? prev);
  };

  // Timers outlive the listener effect below, which re-subscribes on every
  // state change — a repeat that stopped there would stop on its own first
  // step. Unmounting is the one thing that really does end a hold.
  useEffect(() => stop, [stop]);

  useEffect(() => {
    if (!flow) return;

    const onKey = (e: KeyboardEvent) => {
      const key = keyOf(e);
      const tag = (e.target as HTMLElement).tagName;

      // A shadow answer owns only its two explicit decisions. Other keys keep
      // navigating the sheet without silently accepting or throwing it away.
      const shadow = agent?.drafts.find((draft) =>
        state.cursorId?.startsWith(`agent-draft:${draft.requestId}:`),
      );
      if (agent && agent.drafts.length && key === "Tab") {
        const id = agent.accept(shadow?.requestId);
        e.preventDefault();
        if (id) setEditor((s) => ({ ...s, cursorId: id, editingId: null, column: null }));
        return;
      }
      if (agent && agent.drafts.length && key === "Escape") {
        agent.dismiss(shadow?.requestId);
        e.preventDefault();
        return;
      }
      // Shadows take part in spatial movement, but are not arguments yet:
      // editing or marking one would address an ID the CRDT deliberately does
      // not know. Tab/Esc above are their only mutations.
      const onDraft = shadow !== undefined;
      if (onDraft && !["left", "right", "up", "down"].includes(keys[key])) {
        e.preventDefault();
        return;
      }
      // The textarea owns the keyboard while an argument is open, and the
      // command line owns it while that is — except for the chords that are
      // meant to work mid-sentence, and then only from inside an argument.
      if (state.editingId || tag === "INPUT" || tag === "TEXTAREA") {
        if (!state.editingId || !runsWhileEditing(key, keys)) return;
        flushText();
      }

      // The system's own repeat, which this stands in for: swallowed, so a
      // held motion doesn't arrive twice over at two different rates. Only
      // when the key is ours — everything else still belongs to the window.
      if (e.repeat) {
        if (keys[key]) e.preventDefault();
        return;
      }

      // Any other key ends a hold, including the one starting a new one: two
      // fingers on `j` and `l` must not leave a timer running behind the
      // second.
      stop();

      if (keys[key] === "generate") {
        const selected = state.selectAnchor
          ? selectionRange(placed, state.selectAnchor, state.cursorId).map((p) => p.id)
          : state.cursorId ? [state.cursorId] : [];
        if (selected.length) {
          agent?.generate(selected);
          setEditor((s) => ({ ...s, editingId: null, count: null }));
        }
        e.preventDefault();
        return;
      }

      // Run the command here, not inside the setState updater: commands mutate
      // the flow, and StrictMode double-invokes updaters in development.
      const next = run(
        key,
        { state, flow, round, placed, speeches, sheets, memory },
        keys,
      );
      if (!next) return;
      e.preventDefault();
      setEditor(next);

      if (!repeatsWhileHeld(key, keys)) return;
      const entry: { key: string; delay?: number; tick?: number } = { key };
      entry.delay = window.setTimeout(() => {
        entry.tick = window.setInterval(() => step(key), REPEAT_RATE);
      }, REPEAT_DELAY);
      held.current = entry;
    };

    // Letting go — and the two ways a key can be held while the window stops
    // hearing about it: another window takes focus, or the OS does (a ⌘Tab
    // swallows the keyup). Either would leave the cursor walking on its own.
    const onKeyUp = (e: KeyboardEvent) => {
      if (held.current?.key === keyOf(e)) stop();
    };

    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", stop);
    };
  }, [state, flow, round, placed, speeches, sheets, memory, setEditor, flushText, keys, agent]);
}
