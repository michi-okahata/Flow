import React, { useEffect, useRef, useState } from "react";
import { PositionBrowser } from "./PositionBrowser";
import type { Argument, Speech } from "../model/types";
import type { AgentControls } from "../agent/useAgent";

interface AgentPanelProps {
  open: boolean;
  roots: Argument[];
  speeches: Speech[];
  sheets: { id: string; title: string }[];
  activeSheet: string | null;
  selected: string | null;
  onOpenSheet: (id: string) => void;
  onSelect: (id: string) => void;
  onSave: (id: string, before: string, text: string) => string | null;
  agent: AgentControls;
  onToggle: () => void;
  onImportFolder: () => void;
  onImportFile: () => void;
}

/** Debate-wide strategy chat. Its conversation lives on Round; this component
 * is only the view, so closing it or changing sheets cannot lose direction. */
export function AgentPanel({
  open, roots, speeches, sheets, activeSheet, selected, onOpenSheet, onSelect, onSave,
  agent,
  onToggle,
  onImportFolder,
  onImportFile,
}: AgentPanelProps): React.ReactElement {
  const [tab, setTab] = useState<"chat" | "positions">("chat");
  const [text, setText] = useState("");
  const end = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) end.current?.scrollIntoView({ block: "nearest" });
  }, [open, agent.messages, agent.chatDraft]);

  const submit = () => {
    if (!text.trim() || agent.chatting) return;
    agent.send(text);
    setText("");
  };

  return (
    <aside className="agent-panel" aria-label="debate agent" onKeyDown={event => {
      if (!(event.metaKey && event.key.toLowerCase() === "j")) event.stopPropagation();
    }}>
      <header className="agent-panel__head">
        <div>
          <strong>Debate agent</strong>
          <span>directions guide future drafts</span>
        </div>
        <button className="agent-panel__close" type="button" onClick={onToggle} title="close debate agent">×</button>
      </header>

      <nav className="agent-panel__tabs" aria-label="Agent views">
        <button type="button" aria-pressed={tab === "chat"} onClick={() => setTab("chat")}>Strategy</button>
        <button type="button" aria-pressed={tab === "positions"} onClick={() => setTab("positions")}>Position tree</button>
      </nav>
      {tab === "positions" ? <>
        <label className="agent-panel__position">Position
          <select aria-label="Position" value={activeSheet ?? ""} onChange={event => onOpenSheet(event.target.value)}>
            {sheets.map(sheet => <option key={sheet.id} value={sheet.id}>{sheet.title}</option>)}
          </select>
        </label>
        <PositionBrowser key={activeSheet} roots={roots} speeches={speeches} selected={selected} onSelect={onSelect} onSave={onSave} />
      </> : <>
      <div className="agent-panel__context">
        <span>{agent.importedCount} evidence blocks available</span>
        <button type="button" onClick={onImportFolder} title="import .cmir and .docx files recursively">folder</button>
        <button type="button" onClick={onImportFile} title="import a .cmir or .docx file">file</button>
      </div>

      <div className="agent-panel__messages" aria-live="polite">
        {agent.messages.length === 0 && !agent.chatDraft && (
          <p className="agent-panel__empty">
            Set strategy, ask about the flow, or tell the agent how to develop later arguments.
          </p>
        )}
        {agent.messages.map((message) => (
          <article key={message.id} className={`agent-panel__message is-${message.role}`}>
            <span>{message.role === "user" ? "you" : "agent"}</span>
            <p>{message.content}</p>
          </article>
        ))}
        {agent.chatDraft && (
          <article className="agent-panel__message is-assistant is-streaming">
            <span>agent</span>
            <p>{agent.chatDraft}</p>
          </article>
        )}
        {agent.chatting && !agent.chatDraft && <p className="agent-panel__thinking">thinking…</p>}
        <div ref={end} />
      </div>

      {agent.error && <p className="agent-panel__error" role="alert">{agent.error}</p>}
      <form className="agent-panel__composer" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.metaKey && event.key.toLowerCase() === "j") return;
            event.stopPropagation();
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder="direct strategy or ask about the debate"
          aria-label="message the debate agent"
          rows={3}
          maxLength={8000}
        />
        <div>
          {agent.messages.length > 0 && (
            <button type="button" onClick={agent.clearChat}>clear</button>
          )}
          <button type="submit" disabled={!text.trim() || agent.chatting}>send</button>
        </div>
      </form>
      </>}
    </aside>
  );
}
