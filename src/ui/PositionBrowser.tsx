import { useState } from "react";
import type { Argument, Speech } from "../model/types";

interface Props {
  roots: Argument[];
  speeches: Speech[];
  selected: string | null;
  onSelect: (id: string) => void;
  onSave: (id: string, before: string, text: string) => string | null;
}

export function PositionBrowser(props: Props) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [edit, setEdit] = useState<{ id: string; before: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const matches = (node: Argument): boolean => node.text.toLowerCase().includes(query.toLowerCase()) || node.children.some(matches);
  const render = (nodes: Argument[]) => <ul className="position-browser__tree">
    {nodes.filter(matches).map(node => <li key={node.id}>
      <div className={`position-browser__row ${props.selected === node.id ? "is-selected" : ""}`}>
        <button type="button" disabled={!node.children.length} aria-label={`${collapsed.has(node.id) ? "Expand" : "Collapse"} responses`} aria-expanded={node.children.length ? !collapsed.has(node.id) || !!query : undefined}
          onClick={() => setCollapsed(current => { const next = new Set(current); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next; })}>{node.children.length ? collapsed.has(node.id) && !query ? "▸" : "▾" : "·"}</button>
        <button type="button" className="position-browser__argument" aria-current={props.selected === node.id ? "true" : undefined} onClick={() => props.onSelect(node.id)}>
          <small>{props.speeches[node.speech]?.label ?? `Speech ${node.speech + 1}`}</small>
          <span>{node.text || "Untitled argument"}</span>
        </button>
        <button type="button" aria-label={`Edit ${node.text || "argument"}`} disabled={edit !== null && edit.id !== node.id} onClick={() => { props.onSelect(node.id); setEdit({ id: node.id, before: node.text, text: node.text }); setError(null); }}>edit</button>
      </div>
      {(!collapsed.has(node.id) || !!query) && node.children.length > 0 && render(node.children)}
    </li>)}
  </ul>;
  return <section className="position-browser" aria-label="Position tree">
    <input type="search" aria-label="Find arguments" placeholder="Find an argument…" value={query} disabled={!!edit} onChange={event => setQuery(event.target.value)} />
    {!props.roots.length ? <p className="agent-panel__empty">This position has no arguments yet. Add one on the sheet to get started.</p> : !props.roots.some(matches) ? <p>No matching arguments.</p> : render(props.roots)}
      {edit && <form className="position-browser__edit" onSubmit={event => {
        event.preventDefault(); const problem = props.onSave(edit.id, edit.before, edit.text);
        setError(problem); if (!problem) setEdit(null);
      }}>
        <textarea autoFocus aria-label="Argument text" value={edit.text} onChange={event => setEdit({ ...edit, text: event.target.value })} rows={5} />
        {error && <p role="alert">{error}</p>}
        <div><button type="button" onClick={() => { setEdit(null); setError(null); }}>Cancel</button><button type="submit" disabled={!edit.text.trim()}>Save argument</button></div>
      </form>}
  </section>;
}
