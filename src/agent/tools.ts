import type { Flow } from "../model/flow";
import type { AgentToolCall } from "./types";

/**
 * The sole bridge from an agent decision into the document. Agent code never
 * mutates a Loro container directly: it proposes a typed tool call and this
 * executor applies it through Flow's ordinary CRDT mutation path.
 */
export function applyAgentToolCall(
  flow: Flow,
  call: AgentToolCall,
): { argumentId: string } {
  switch (call.name) {
    case "add_argument": {
      if (!flow.has(call.arguments.under)) {
        throw new Error("the argument being answered no longer exists");
      }
      const id = flow.add(
        { under: call.arguments.under },
        { text: call.arguments.text, speech: call.arguments.speech },
      );
      return { argumentId: id };
    }
  }
}
