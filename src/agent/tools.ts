import { POLICY_SPEECHES } from "../model/format";
import type { Flow } from "../model/flow";
import type { AgentContextBlock, AgentContextSource, AgentToolCall } from "./types";

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
  if (name === "create_position") {
    const title = stringField(args, "title").trim();
    if (!title || title.length > 500) throw new Error("Invalid position title");
    return { position_id: round.addSheet(title) };
  }
  if (!["read_position", "read_argument", "edit_argument", "create_argument", "move_argument", "delete_argument", "rename_position", "set_argument_speech"].includes(name)) throw new Error(`Unknown tool: ${name}`);
  const sheet = stringField(args, "position_id");
  if (!round.sheets().some(s => s.id === sheet)) throw new Error("Position no longer exists");
  const flow = round.flow(sheet);
  if (name === "rename_position") {
    const title = stringField(args, "title").trim();
    if (!title || title.length > 500) throw new Error("Invalid position title");
    round.renameSheet(sheet, title);
    return { position_id: sheet, title };
  }
  const speechIndex = () => {
    const speech = args.speech;
    if (typeof speech !== "number" || !Number.isInteger(speech) || speech < 0 || speech >= POLICY_SPEECHES.length) throw new Error("Invalid speech index");
    return speech;
  };
  if (name === "create_argument") {
    const text = stringField(args, "text");
    if (!text.trim() || text.length > 32000) throw new Error("Invalid argument text");
    const speech = speechIndex();
    const parent = args.parent_id;
    if (parent !== null && (typeof parent !== "string" || !flow.has(parent))) throw new Error("Parent argument no longer exists");
    return { argumentId: flow.add(parent === null ? { root: null } : { under: parent as string }, { text, speech }) };
  }
  if (name === "read_position") {
    const offset = args.offset ?? 0;
    if (!Number.isInteger(offset) || Number(offset) < 0) throw new Error("Invalid offset");
    const roots = flow.roots();
    return { arguments: roots.slice(Number(offset), Number(offset) + 30).map(node => ({ id: node.id, speech: node.speech, preview: node.text.slice(0, 200), responses: node.children.length })), next_offset: Number(offset) + 30 < roots.length ? Number(offset) + 30 : null };
  }
  const id = stringField(args, "argument_id");
  if (!flow.has(id)) throw new Error("Argument no longer exists in this position");
  if (name === "move_argument") {
    const parent = args.parent_id;
    if (parent !== null && (typeof parent !== "string" || !flow.has(parent))) throw new Error("Parent argument no longer exists");
    if (args.expected_parent_id !== flow.parentOf(id)) throw new Error("Argument moved since it was read");
    const index = args.index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0) throw new Error("Invalid sibling index");
    flow.move(id, parent === null ? undefined : parent as string, index);
    return { argumentId: id, parent_id: flow.parentOf(id) };
  }
  if (name === "set_argument_speech") {
    const speech = speechIndex();
    if (args.expected_speech !== flow.speechOf(id)) throw new Error("Speech changed since it was read");
    flow.setSpeech(id, speech);
    return { argumentId: id, speech };
  }
  if (name === "delete_argument") {
    const stack = [...flow.roots()];
    while (stack.length) {
      const node = stack.pop()!;
      if (node.id === id) {
        if (stringField(args, "expected_subtree") !== JSON.stringify(node)) throw new Error("Branch changed since it was read. Read the argument again.");
        flow.remove(id);
        return { argumentId: id, deleted: true };
      }
      stack.push(...node.children);
    }
  }
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
    if (node.id === id) return { id, subtree_snapshot: JSON.stringify(node), text: node.text, speech: node.speech, parent_id: flow.parentOf(id), children: node.children.map(child => ({ id: child.id, speech: child.speech, preview: child.text.slice(0, 200) })) };
    stack.push(...node.children);
  }
  throw new Error("Argument no longer exists");
}

/** Search imported workspace material without placing its bodies in every
 * prompt. IDs are scoped to the captured import list for this turn. */
export function executeContextTool(
  blocks: AgentContextBlock[],
  name: string,
  args: Record<string, unknown>,
): unknown {
  if (name === "list_context_sources") {
    return contextSourcesOf(blocks).map(({ source, blockCount }) => ({ source, block_count: blockCount }));
  }
  if (name === "search_context") {
    const query = stringField(args, "query").trim().toLowerCase();
    if (!query) throw new Error("Search query is empty");
    const position = typeof args.position === "string" ? args.position.trim().toLowerCase() : "";
    const limit = Math.max(1, Math.min(20, Number.isInteger(args.limit) ? Number(args.limit) : 8));
    const words = new Set(query.match(/[a-z0-9]{3,}/g) ?? []);
    return blocks.map((block, index) => {
      const metadata = `${block.position} ${block.key} ${block.argument} ${block.answers.join(" ")}`.toLowerCase();
      const body = (block.context ?? []).join("\n").toLowerCase();
      let score = position && block.position.toLowerCase() === position ? 8 : 0;
      if (metadata.includes(query)) score += 12;
      if (body.includes(query)) score += 8;
      for (const word of words) {
        if (metadata.includes(word)) score += 3;
        else if (body.includes(word)) score += 1;
      }
      return { block, index, score };
    }).filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, limit)
      .map(({ block, index }) => ({
        context_id: `context:${index}`,
        source: block.source,
        position: block.position,
        key: block.key,
        argument: block.argument.slice(0, 500),
        answer_previews: block.answers.slice(0, 5).map(answer => answer.slice(0, 240)),
      }));
  }
  if (name === "read_context") {
    const match = /^context:(\d+)$/.exec(stringField(args, "context_id"));
    if (!match) throw new Error("Invalid context ID");
    const block = blocks[Number(match[1])];
    if (!block) throw new Error("Context block no longer exists");
    const offset = Number.isInteger(args.offset) ? Math.max(0, Number(args.offset)) : 0;
    const material = JSON.stringify({
      argument: block.argument,
      answers: block.answers,
      evidence: block.context ?? [],
    });
    const chunkSize = 6000;
    const content = material.slice(offset, offset + chunkSize);
    return {
      context_id: stringField(args, "context_id"),
      source: block.source,
      position: block.position,
      key: block.key,
      argument: block.argument,
      content,
      next_offset: offset + chunkSize < material.length ? offset + chunkSize : null,
    };
  }
  throw new Error(`Unknown context tool: ${name}`);
}

/** File names and sizes are cheap enough to include on every request. */
export function contextSourcesOf(blocks: AgentContextBlock[]): AgentContextSource[] {
  const counts = new Map<string, number>();
  for (const block of blocks) counts.set(block.source, (counts.get(block.source) ?? 0) + 1);
  return [...counts].map(([source, blockCount]) => ({ source, blockCount }));
}

const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[]) => ({ type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } });
const str = { type: "string" };
const nullableId = { type: ["string", "null"] };
const integer = { type: "integer", minimum: 0 };
export const CHAT_TOOLS = [
  tool("list_context_sources", "List imported workspace files and their block counts without reading their contents.", {}, []),
  tool("search_context", "Search imported workspace evidence. Returns compact matches and context IDs; call read_context only for relevant matches.", { query: str, position: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20 } }, ["query"]),
  tool("read_context", "Read one matching imported evidence block in bounded chunks. Continue with next_offset only when more of that block is needed.", { context_id: str, offset: { type: "integer", minimum: 0 } }, ["context_id"]),
  tool("create_position", "Create a position in the shared CRDT debate.", { title: str }, ["title"]),
  tool("rename_position", "Rename an existing position.", { position_id: str, title: str }, ["position_id", "title"]),
  tool("create_argument", "Create an argument in the shared flow. parent_id null creates a root; otherwise creates a response. speech is zero-based: 1AC, 1NC, 2AC, Block, 1AR, 2NR, 2AR.", { position_id: str, parent_id: nullableId, text: str, speech: integer }, ["position_id", "parent_id", "text", "speech"]),
  tool("move_argument", "Reparent or reorder an argument and its descendants within a position. null parent promotes to root. index is the zero-based sibling slot. Read the argument first; cycles are rejected. Speech stays unchanged.", { position_id: str, argument_id: str, parent_id: nullableId, expected_parent_id: nullableId, index: integer }, ["position_id", "argument_id", "parent_id", "expected_parent_id", "index"]),
  tool("delete_argument", "Delete an argument AND all descendants only when requested. Supply the exact subtree_snapshot from read_argument to detect concurrent changes.", { position_id: str, argument_id: str, expected_subtree: str }, ["position_id", "argument_id", "expected_subtree"]),
  tool("set_argument_speech", "Change the speech column of one argument without changing parent or descendants. Read first for expected_speech.", { position_id: str, argument_id: str, speech: integer, expected_speech: integer }, ["position_id", "argument_id", "speech", "expected_speech"]),
  tool("list_positions", "List all positions with their IDs.", {}, []),
  tool("read_position", "Read root arguments in a position. Use next_offset for more roots.", { position_id: str, offset: { type: "integer", minimum: 0 } }, ["position_id"]),
  tool("read_argument", "Read full argument text, parent ID, and response IDs. Follow parent and children to traverse the tree.", { position_id: str, argument_id: str }, ["position_id", "argument_id"]),
  tool("edit_argument", "Edit an argument when requested by the user. First read it and supply its exact expected_text to avoid overwriting concurrent changes.", { position_id: str, argument_id: str, expected_text: str, text: str }, ["position_id", "argument_id", "expected_text", "text"]),
];
