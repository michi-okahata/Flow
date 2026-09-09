import React, { useMemo, useState } from "react";
import type { Round, SheetInfo } from "../model/round";
import type { Speech } from "../model/types";
import { speechPositions, type ExportPosition } from "../export/speech";

export function SpeechExportDialog({
  round,
  sheets,
  speeches,
  initialSpeech,
  onCancel,
  onExport,
}: {
  round: Round;
  sheets: SheetInfo[];
  speeches: Speech[];
  initialSpeech: number;
  onCancel: () => void;
  onExport: (speech: number, positions: ExportPosition[]) => void;
}): React.ReactElement {
  const [speech, setSpeech] = useState(initialSpeech);
  const positions = useMemo(() => speechPositions(round, sheets, speech), [round, sheets, speech]);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(speechPositions(round, sheets, initialSpeech).filter((p) => p.lines).map((p) => p.id)),
  );
  const chosen = positions.filter((position) => selected.has(position.id) && position.lines > 0);
  const total = chosen.reduce((sum, position) => sum + position.lines, 0);
  const cards = chosen.reduce((sum, position) => sum + position.cards, 0);

  const changeSpeech = (next: number) => {
    setSpeech(next);
    setSelected(new Set(speechPositions(round, sheets, next).filter((p) => p.lines).map((p) => p.id)));
  };

  return (
    <div className="app__scrim" onMouseDown={onCancel}>
      <section
        className="speech-import"
        role="dialog"
        aria-modal="true"
        aria-labelledby="speech-export-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") onCancel();
          if (event.key === "Enter" && chosen.length) onExport(speech, chosen);
        }}
      >
        <header className="speech-import__head">
          <div>
            <span className="speech-import__eyebrow">export speech</span>
            <h1 id="speech-export-title">Which positions are in the speech?</h1>
          </div>
          <span className="speech-import__summary">
            {chosen.length} positions · {cards} cards · {total - cards} analytics
          </span>
        </header>
        <label className="speech-import__speech">
          speech
          <select autoFocus value={speech} onChange={(event) => changeSpeech(Number(event.target.value))}>
            {speeches.map((item, index) => <option value={index} key={item.label}>{item.label}</option>)}
          </select>
        </label>
        <div className="speech-import__list">
          {positions.map((position) => (
            <label className={`speech-import__position${position.lines ? "" : " is-empty"}`} key={position.id}>
              <input
                type="checkbox"
                disabled={!position.lines}
                checked={selected.has(position.id) && position.lines > 0}
                onChange={() => setSelected((before) => {
                  const next = new Set(before);
                  if (next.has(position.id)) next.delete(position.id); else next.add(position.id);
                  return next;
                })}
              />
              <span className="speech-import__name">{position.title}</span>
              <span className="speech-import__count">
                {position.lines ? `${position.lines} line${position.lines === 1 ? "" : "s"}` : "nothing in this speech"}
              </span>
            </label>
          ))}
        </div>
        <footer className="speech-import__actions">
          <button type="button" onClick={onCancel}>cancel</button>
          <button type="button" className="is-primary" disabled={!chosen.length} onClick={() => onExport(speech, chosen)}>
            export .cmir
          </button>
        </footer>
      </section>
    </div>
  );
}
