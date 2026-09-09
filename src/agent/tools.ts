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

import type { Round } from "../model/round";

const stringField = (args: Record<string, unknown>, key: string): string => {
  if (typeof args[key] !== "string") throw new Error(`Missing or invalid ${key}`);
  return args[key] as string;
};

/** Read one level at a time so large positions do not flood the prompt. */
export function executeChatTool(round: Round, name: string, args: Record<string, unknown>): unknown {
  if (name === "list_positions") return round.sheets();
  if (!["read_position", "read_argument", "edit_argument"].includes(name)) throw new Error(`Unknown tool: ${name}`);
  const sheet = stringField(args, "position_id");
  if (!round.sheets().some(s => s.id === sheet)) throw new Error("Position no longer exists");
  const flow = round.flow(sheet);
  if (name === "read_position") {
    const offset = args.offset ?? 0;
    if (!Number.isInteger(offset) || Number(offset) < 0) throw new Error("Invalid offset");
    const roots = flow.roots();
    return { arguments: roots.slice(Number(offset), Number(offset) + 30).map(node => ({ id: node.id, speech: node.speech, preview: node.text.slice(0, 200), responses: node.children.length })), next_offset: Number(offset) + 30 < roots.length ? Number(offset) + 30 : null };
  }
  const id = stringField(args, "argument_id");
  if (!flow.has(id)) throw new Error("Argument no longer exists in this position");
  if (name === "edit_argument") {
    const before = stringField(args, "expected_text");
    const text = stringField(args, "text");
    if (!text.trim() || text.length > 32000) throw new Error("Argument text must contain 1–32000 characters");
    if (flow.textOf(id) !== before) throw new Error("Argument changed since it was read. Read it again before editing.");
    flow.setText(id, text);
    return { argumentId: id, saved: true };
  }
  const stack = [...flow.roots()];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.id === id) return { id, text: node.text, speech: node.speech, parent_id: flow.parentOf(id), children: node.children.map(child => ({ id: child.id, speech: child.speech, preview: child.text.slice(0, 200) })) };
    stack.push(...node.children);
  }
  throw new Error("Argument no longer exists");
}

const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[]) => ({ type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } });
const str = { type: "string" };
export const CHAT_TOOLS = [
  tool("list_positions", "List all positions with their IDs.", {}, []),
  tool("read_position", "Read root arguments in a position. Use next_offset for more roots.", { position_id: str, offset: { type: "integer", minimum: 0 } }, ["position_id"]),
  tool("read_argument", "Read full argument text, parent ID, and response IDs. Follow parent and children to traverse the tree.", { position_id: str, argument_id: str }, ["position_id", "argument_id"]),
  tool("edit_argument", "Edit an argument when requested by the user. First read it and supply its exact expected_text to avoid overwriting concurrent changes.", { position_id: str, argument_id: str, expected_text: str, text: str }, ["position_id", "argument_id", "expected_text", "text"]),
];
