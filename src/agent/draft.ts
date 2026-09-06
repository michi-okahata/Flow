import type { Argument } from "../model/types";
import type { AgentDraft } from "./types";

/**
 * Project an in-flight response onto the sheet without touching its CRDT.
 * These IDs are stable for a request, so layout and cursor movement can treat
 * shadows exactly like cells until Tab turns them into real arguments.
 */
export function agentDraftRoots(roots: Argument[], draft: AgentDraft): Argument[] {
  const texts = draft.status === "ready" ? draft.answers : [""];
  const shadows: Argument[] = texts.map((text, index) => ({
    id: `agent-draft:${draft.requestId}:${index}`,
    speech: draft.speech,
    text,
    mark: "none",
    support: "analytic",
    children: [],
  }));
  const walk = (argument: Argument): Argument =>
    argument.id === draft.sourceId
      ? { ...argument, children: [...argument.children, ...shadows] }
      : { ...argument, children: argument.children.map(walk) };
  return roots.map(walk);
}
