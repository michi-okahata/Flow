import React, { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { invoke } from "@tauri-apps/api/core";
import type { AgentControls } from "../agent/useAgent";
import type { AgentMessage, AgentStep } from "../agent/types";

interface AgentPanelProps {
  open: boolean;
  profiles: { name: string; provider: string; model: string; subscription: boolean }[];
  profile: string | null;
  onProfileChange: (name: string) => void;
  agent: AgentControls;
  /** Panel width in pixels, and the drag that changes it. */
  width: number;
  onWidthChange: (width: number) => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onToggle: () => void;
  onImportFolder: () => void;
  onImportFile: () => void;
}

const MIN_WIDTH = 280;

/**
 * The agent's half of the app: several threads of work against one round, and
 * a record of what each turn actually did.
 *
 * It is written as a harness rather than as a chat window, which is a claim
 * about what the agent is. The agent edits the flow — it creates positions,
 * moves arguments, rewrites text — and a transcript that shows only prose is
 * hiding the part that changed the document. So every tool call is drawn where
 * it happened, in the turn that made it, with its arguments and what came back.
 * A reply you can read but not audit is worse than no reply during a round.
 *
 * The conversation lives on Round, so closing the panel or changing sheets
 * cannot lose direction; this component is only the view.
 */
export function AgentPanel({
  open, profiles, profile, onProfileChange,
  agent,
  width, onWidthChange,
  expanded, onExpandedChange,
  onToggle,
  onImportFolder,
  onImportFile,
}: AgentPanelProps): React.ReactElement {
  const [text, setText] = useState("");
  const [usage, setUsage] = useState<string | null>(null);
  const end = useRef<HTMLDivElement | null>(null);
  const composer = useRef<HTMLTextAreaElement | null>(null);
  const thread = agent.thread;
  const selectedProfile = profiles.find(item => item.name === profile);

  useEffect(() => {
    if (!open || !selectedProfile?.subscription || selectedProfile.provider !== "codex") {
      setUsage(null);
      return;
    }
    let live = true;
    invoke<unknown>("agent_codex_rate_limits").then(
      result => { if (live) setUsage(formatUsage(result)); },
      () => { if (live) setUsage(null); },
    );
    return () => { live = false; };
  }, [open, selectedProfile?.provider, selectedProfile?.subscription, agent.running]);

  useEffect(() => {
    if (open) end.current?.scrollIntoView({ block: "nearest" });
  }, [open, thread?.messages, thread?.draft, thread?.steps]);

  useEffect(() => {
    if (open) requestAnimationFrame(() => composer.current?.focus());
  }, [open]);

  useEffect(() => {
    const openFile = (event: KeyboardEvent) => {
      if (
        !open ||
        !event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== "o"
      ) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.repeat) onImportFile();
    };
    window.addEventListener("keydown", openFile, true);
    return () => window.removeEventListener("keydown", openFile, true);
  }, [open, onImportFile]);

  const submit = () => {
    if (!text.trim() || thread?.running) return;
    agent.send(text);
    setText("");
  };

  // Dragging the left edge. Tracked on the window rather than the handle so the
  // pointer can outrun the element it started on, which at a fast drag it will.
  //
  // The drag starts from the width on screen rather than from the width in
  // state: when the flow has stepped out the panel is filling the space it
  // left, and those two are not the same number. Measuring keeps the edge
  // under the pointer across that boundary. Where the panel may come to rest
  // is not decided here — that is the layout's rule, and the caller applies it
  // (see layout/panels.ts).
  const panel = useRef<HTMLElement | null>(null);
  const startResize = (event: React.PointerEvent) => {
    event.preventDefault();
    const from = event.clientX;
    const start = panel.current?.getBoundingClientRect().width ?? width;
    const move = (moved: PointerEvent) => {
      const next = Math.max(MIN_WIDTH, Math.min(window.innerWidth, start + (from - moved.clientX)));
      onWidthChange(next);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  return (
    <aside
      ref={panel}
      className={`agent-panel${expanded ? " is-expanded" : ""}`}
      style={expanded ? undefined : { width: `${width}px` }}
      aria-label="debate agent"
      onKeyDown={event => {
        if (!(event.metaKey && event.key.toLowerCase() === "j")) event.stopPropagation();
      }}
    >
      <div
        className="agent-panel__resize"
        onPointerDown={startResize}
        onDoubleClick={() => onExpandedChange(!expanded)}
        role="separator"
        aria-orientation="vertical"
        aria-label="resize the agent panel"
        title="drag to resize — double-click to expand"
      />

      <header className="agent-panel__head">
        <strong>Agent{agent.running ? " · working" : ""}</strong>
        <div className="agent-panel__head-actions">
          <button
            type="button"
            onClick={() => onExpandedChange(!expanded)}
            title={expanded ? "shrink the agent panel (⇧⌘J)" : "expand the agent panel (⇧⌘J)"}
            aria-pressed={expanded}
          >{expanded ? "⇥" : "⇤"}</button>
          <button className="agent-panel__close" type="button" onClick={onToggle} title="close the agent (⌘J)">×</button>
        </div>
      </header>

      <div className="agent-panel__context">
        <span>{agent.importedCount} workspace blocks</span>
        {usage && <span className="agent-panel__usage" title="Codex subscription usage">{usage}</span>}
        <button
          type="button"
          className="agent-panel__import"
          onClick={onImportFile}
          title="Add a .cmir or .docx file (⌘O)"
          aria-label="add evidence file"
        ><FileIcon /></button>
        <button className="agent-panel__import" type="button" onClick={onImportFolder} title="Add every .cmir and .docx file in a folder" aria-label="add evidence folder"><FolderIcon /></button>
      </div>

      <div className="agent-panel__messages" aria-live="polite">
        {thread?.messages.map((message) => <Turn key={message.id} message={message} />)}
        {thread?.running && (
          <article className="agent-panel__message is-assistant is-streaming">
            <span className="agent-panel__who">agent</span>
            <ContextBlocks steps={thread.steps} />
            <Steps steps={thread.steps} />
            {thread.draft
              ? <div className="agent-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml>{thread.draft}</Markdown></div>
              : <p className="agent-panel__thinking">{thread.steps.length ? "working…" : "thinking…"}</p>}
          </article>
        )}
        <div ref={end} />
      </div>

      {agent.error && <p className="agent-panel__error" role="alert">{agent.error}</p>}
      <form className="agent-panel__composer" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <textarea
          ref={composer}
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
          placeholder={thread ? "reply, or send more direction" : "Message the agent…"}
          aria-label="message the debate agent"
          rows={3}
          maxLength={8000}
        />
        <div className="agent-panel__actions">
          {/* Named where it is chosen: the model is a property of the message
              you are about to send, not of the panel, so it sits with send
              rather than in the header. The label is the profile's own name —
              a "Model" caption beside a picker that says "deepseek" is a word
              spent saying what the next word already says. */}
          {profiles.length > 0 && (
            <label className="agent-panel__model">
              <select
                aria-label="Agent model profile"
                value={profile ?? ""}
                title="which model answers this thread"
                onChange={event => onProfileChange(event.target.value)}
              >
                {profiles.map(item => (
                  <option key={item.name} value={item.name}>
                    {item.name} · {item.subscription ? "subscription" : item.provider} · {item.model}
                  </option>
                ))}
              </select>
            </label>
          )}
          {thread && thread.messages.length > 0 && (
            <button type="button" onClick={() => agent.clearThread(thread.id)}>clear</button>
          )}
          {thread?.running
            ? <button type="button" className="agent-panel__stop" onClick={() => agent.stop(thread.id)}>stop</button>
            : <button type="submit" disabled={!text.trim()}>send</button>}
        </div>
      </form>
    </aside>
  );
}

/** A finished turn, tool calls and all. */
function Turn({ message }: { message: AgentMessage }): React.ReactElement {
  return (
    <article className={`agent-panel__message is-${message.role}${message.error ? " is-failed" : ""}`}>
      <span className="agent-panel__who">
        {message.role === "user" ? "›" : "agent"}
        {message.error && <em className="agent-panel__badge">{message.error}</em>}
      </span>
      {message.role === "assistant" && message.steps ? <ContextBlocks steps={message.steps} /> : null}
      {message.steps?.length ? <Steps steps={message.steps} /> : null}
      {message.content && (
        <div className="agent-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml>{message.content}</Markdown></div>
      )}
    </article>
  );
}

function ContextBlocks({ steps }: { steps: AgentStep[] }): React.ReactElement | null {
  const blocks = steps
    .filter(step => step.name === "read_context" && step.status === "done" && step.detail)
    .map(step => ({ id: String(step.arguments.context_id ?? step.id), label: step.detail! }));
  const unique = blocks.filter((block, index) => blocks.findIndex(other => other.id === block.id) === index);
  if (!unique.length) return null;
  return (
    <div className="agent-context-used" aria-label="workspace blocks used">
      <span>context</span>
      {unique.map(block => <span key={block.id} title={block.label}>{block.label}</span>)}
    </div>
  );
}

function FileIcon(): React.ReactElement {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 1.5h5l3 3v10h-8zM9.5 1.5v3h3" /></svg>;
}

function FolderIcon(): React.ReactElement {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4h5l1.5 2h6.5v7.5h-13zM1.5 4V2.5h4L7 4" /></svg>;
}

function formatUsage(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const result = value as Record<string, unknown>;
  const byId = result.rateLimitsByLimitId;
  const limits = byId && typeof byId === "object"
    ? Object.values(byId as Record<string, unknown>)[0]
    : result.rateLimits;
  if (!limits || typeof limits !== "object") return null;
  const item = limits as Record<string, unknown>;
  const windows = [item.primary, item.secondary].filter(window => window && typeof window === "object") as Record<string, unknown>[];
  const labels = windows.map(window => {
    const used = typeof window.usedPercent === "number" ? window.usedPercent : null;
    const mins = typeof window.windowDurationMins === "number" ? window.windowDurationMins : null;
    if (used === null) return null;
    const period = mins === null ? "usage" : mins >= 7 * 24 * 60 ? "week" : mins >= 60 ? `${Math.round(mins / 60)}h` : `${mins}m`;
    return `${period} ${Math.max(0, Math.round(100 - used))}% left`;
  }).filter(Boolean);
  return labels.length ? labels.join(" · ") : null;
}

/** The tool calls of one turn. Collapsed to a line each: the name, the target,
    and how it went — open one to see exactly what was sent and returned. */
function Steps({ steps }: { steps: AgentStep[] }): React.ReactElement | null {
  if (steps.length === 0) return null;
  return (
    <ol className="agent-steps">
      {steps.map((step) => (
        <li key={step.id} className={`agent-steps__step is-${step.status}`}>
          <details>
            <summary>
              <span className="agent-steps__name">{step.name}</span>
              <span className="agent-steps__args">{headline(step)}</span>
            </summary>
            <pre>{JSON.stringify(step.arguments, null, 2)}</pre>
            {/* The headline is already the error on a failed step; repeating it
                underneath its own arguments says nothing twice. */}
            {step.detail && step.detail !== headline(step) && (
              <pre className="agent-steps__detail">{step.detail}</pre>
            )}
          </details>
        </li>
      ))}
    </ol>
  );
}

/** The one thing worth reading on a collapsed step: what it was aimed at while
    it runs, what came back once it is done, and the error when it failed. */
function headline(step: AgentStep): string {
  if (step.status === "error") return step.detail ?? "failed";
  if (step.status === "running") return target(step.arguments);
  return step.detail || target(step.arguments);
}

function target(args: Record<string, unknown>): string {
  for (const key of ["title", "text", "argument_id", "position_id"]) {
    const value = args[key];
    if (typeof value === "string" && value) {
      return value.length > 60 ? `${value.slice(0, 59)}…` : value;
    }
  }
  return "";
}
