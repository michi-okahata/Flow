import React, { useMemo, useState } from "react";
import type { SpeechDocument } from "../import/speech";

export function SpeechImportDialog({
  document,
  onCancel,
  onCreate,
}: {
  document: SpeechDocument;
  onCancel: () => void;
  onCreate: (selected: ReadonlySet<number>) => void;
}): React.ReactElement {
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(document.positions.map((_, index) => index)),
  );
  const totals = useMemo(
    () =>
      document.positions.reduce(
        (sum, position, index) => {
          if (!selected.has(index)) return sum;
          for (const line of position.lines) sum[line.support]++;
          return sum;
        },
        { card: 0, analytic: 0 },
      ),
    [document, selected],
  );

  const toggle = (index: number) => {
    setSelected((before) => {
      const next = new Set(before);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  return (
    <div
      className="app__scrim"
      onMouseDown={onCancel}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        } else if (event.key === "Enter" && selected.size > 0) {
          event.preventDefault();
          onCreate(selected);
        }
      }}
    >
      <section
        className="speech-import"
        role="dialog"
        aria-modal="true"
        aria-labelledby="speech-import-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="speech-import__head">
          <div>
            <span className="speech-import__eyebrow">import {document.speechLabel}</span>
            <h1 id="speech-import-title">Create these positions?</h1>
          </div>
          <span className="speech-import__summary">
            {selected.size} sheets · {totals.card} cards · {totals.analytic} analytics
          </span>
        </header>

        <div className="speech-import__list">
          {document.positions.map((position, index) => {
            const cards = position.lines.filter((line) => line.support === "card").length;
            const analytics = position.lines.length - cards;
            return (
              <label className="speech-import__position" key={`${position.title}-${index}`}>
                <input
                  type="checkbox"
                  autoFocus={index === 0}
                  checked={selected.has(index)}
                  onChange={() => toggle(index)}
                />
                <span className="speech-import__name">{position.title}</span>
                <span className="speech-import__count">
                  {cards} card{cards === 1 ? "" : "s"}
                  {analytics ? ` · ${analytics} analytic${analytics === 1 ? "" : "s"}` : ""}
                </span>
              </label>
            );
          })}
        </div>

        <footer className="speech-import__actions">
          <button type="button" onClick={onCancel}>cancel</button>
          <button
            type="button"
            className="is-primary"
            disabled={selected.size === 0}
            onClick={() => onCreate(selected)}
          >
            create {selected.size} sheet{selected.size === 1 ? "" : "s"}
          </button>
        </footer>
      </section>
    </div>
  );
}
