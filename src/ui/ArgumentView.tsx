import React, { useState } from "react";
import { ArgumentEditor } from "./ArgumentEditor";
import type { Dictionary } from "../editor/completion";
import type { Argument } from "../model/types";

/**
 * One argument on the sheet, in whichever of its two states it's in: the text
 * as written, or the editor open on it.
 *
 * The display abbreviates long arguments; opening the editor reveals the
 * complete text. The stored argument is never shortened.
 *
 * No cursor state here: the *cell* wears it, so that the number is inside the
 * highlight — see the stylesheet.
 */

const ARGUMENT_CLASS = "flow-argument";

interface ArgumentViewProps {
  argument: Argument;
  editing: boolean;
  dictionary: Dictionary;
  /** The keymap in force — the editor lets a couple of its chords through. */
  keys: Record<string, string>;
  /** As the user types, for the throttled write into the flow. */
  onChange: (text: string) => void;
  /** The editor is finished with: flush and leave edit mode. */
  onDone: () => void;
  /** Put the cursor here. */
  onSelect: () => void;
  /** Put the cursor here and open it. */
  onEdit: () => void;
}

export function ArgumentView({
  argument,
  editing,
  dictionary,
  keys,
  onChange,
  onDone,
  onSelect,
  onEdit,
}: ArgumentViewProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false);

  if (editing) {
    return (
      <ArgumentEditor
        className={ARGUMENT_CLASS}
        initialText={argument.text}
        dictionary={dictionary}
        keys={keys}
        onChange={onChange}
        onDone={onDone}
      />
    );
  }

  const text = argument.text.trim();
  const firstSentence = typeof Intl.Segmenter === "function"
    ? Array.from(new Intl.Segmenter("en", { granularity: "sentence" }).segment(text))[0]?.segment.trimEnd() ?? text
    : text.match(/^.*?[.!?](?:["'”’)]*)(?=\s|$)/s)?.[0] ?? text;
  const hasMore = firstSentence.length < text.length;
  const collapsed = hasMore && !expanded;
  const preview = collapsed ? firstSentence : argument.text;

  return (
    <div
      className={`${ARGUMENT_CLASS}${collapsed ? " is-collapsed" : ""}`}
      title={collapsed ? argument.text : undefined}
      // Through the same helper the keymap uses, so a click on a collapsed
      // rectangle two speeches away drops focus (and any selection) exactly
      // as `l l` would.
      onClick={onSelect}
      onDoubleClick={onEdit}
    >
      <span>{preview || <span className="flow-argument__placeholder">empty</span>}</span>
      {hasMore && <button
        type="button"
        className="flow-argument__disclosure"
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Expand full argument" : "Collapse to first sentence"}
        title={collapsed ? "Show full argument" : "Show first sentence"}
        onKeyDown={event => event.stopPropagation()}
        onDoubleClick={event => event.stopPropagation()}
        onClick={event => {
          event.stopPropagation();
          onSelect();
          setExpanded(value => !value);
        }}
      ><span aria-hidden="true">{collapsed ? "▸" : "▾"}</span></button>}
    </div>
  );
}
