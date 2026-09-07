import React, { useEffect, useRef, useState } from "react";
import type { AgentControls } from "../agent/useAgent";

interface AgentPanelProps {
  open: boolean;
  agent: AgentControls;
  onToggle: () => void;
  onImportFolder: () => void;
  onImportFile: () => void;
}

/** Debate-wide strategy chat. Its conversation lives on Round; this component
 * is only the view, so closing it or changing sheets cannot lose direction. */
export function AgentPanel({
  open,
  agent,
  onToggle,
  onImportFolder,
  onImportFile,
}: AgentPanelProps): React.ReactElement {
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
    <aside className="agent-panel" aria-label="debate agent">
      <header className="agent-panel__head">
        <div>
          <strong>agent</strong>
          <span>directions guide future drafts</span>
        </div>
        <button className="agent-panel__close" type="button" onClick={onToggle} title="close debate agent">×</button>
      </header>

      <div className="agent-panel__context">
        <span>{agent.importedCount} CardMirror blocks available</span>
        <button type="button" onClick={onImportFolder}>folder</button>
        <button type="button" onClick={onImportFile}>file</button>
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

      <form className="agent-panel__composer" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.metaKey && event.key.toLowerCase() === "n") return;
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
    </aside>
  );
}
