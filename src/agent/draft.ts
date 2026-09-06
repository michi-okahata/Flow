import type { Argument } from "../model/types";
import type { AgentDraft } from "./types";

/**
 * Project an in-flight response onto the sheet without touching its CRDT.
 * These IDs are stable for a request, so layout and cursor movement can treat
 * shadows exactly like cells until Tab turns them into real arguments.
 */
export function agentDraftRoots(roots: Argument[], drafts: AgentDraft[]): Argument[] {
  const shadowsBySource = new Map<string, Argument[]>();
  for (const draft of drafts) {
    const texts = draft.status === "ready" ? draft.answers : [""];
    const shadows = texts.map((text, index) => ({
      id: `agent-draft:${draft.requestId}:${index}`,
      speech: draft.speech,
      text,
      mark: "none" as const,
      support: "analytic" as const,
      children: [],
    }));
    shadowsBySource.set(draft.sourceId, [...(shadowsBySource.get(draft.sourceId) ?? []), ...shadows]);
  }
  const walk = (argument: Argument): Argument =>
    shadowsBySource.has(argument.id)
      ? { ...argument, children: [...argument.children.map(walk), ...shadowsBySource.get(argument.id)!] }
      : { ...argument, children: argument.children.map(walk) };
  return roots.map(walk);
}
