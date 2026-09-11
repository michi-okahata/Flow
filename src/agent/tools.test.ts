import { describe, expect, it } from "vitest";
import { Flow } from "../model/flow";
import { applyAgentToolCall } from "./tools";

describe("agent CRDT tools", () => {
  it("adds a generated answer through the ordinary Flow mutation path", () => {
    const flow = new Flow();
    const source = flow.addRoot(null, "no solvency", 1);
    const result = applyAgentToolCall(flow, {
      name: "add_argument",
      arguments: { under: source, speech: 2, text: "solvency advocate answers" },
    });

    expect(flow.parentOf(result.argumentId)).toBe(source);
    expect(flow.speechOf(result.argumentId)).toBe(2);
    expect(flow.textOf(result.argumentId)).toBe("solvency advocate answers");
  });

  it("does not write when the source argument disappeared", () => {
    const flow = new Flow();
    expect(() =>
      applyAgentToolCall(flow, {
        name: "add_argument",
        arguments: { under: "missing", speech: 1, text: "answer" },
      }),
    ).toThrow("no longer exists");
    expect(flow.roots()).toEqual([]);
  });
});

import { Round } from "../model/round";
import { executeChatTool } from "./tools";

describe("chat position tools", () => {
  it("traverses positions, roots, parents and responses and edits full text", () => {
    const round = new Round();
    const position_id = round.addSheet("Politics");
    const flow = round.flow(position_id);
    const root = flow.addRoot(null, "Original argument", 0);
    const child = flow.add({ under: root }, { text: "Response", speech: 1 });
    expect(executeChatTool(round, "list_positions", {})).toContainEqual({ id: position_id, title: "Politics" });
    expect(executeChatTool(round, "read_position", { position_id })).toMatchObject({ arguments: [{ id: root }], next_offset: null });
    expect(executeChatTool(round, "read_argument", { position_id, argument_id: root })).toMatchObject({ text: "Original argument", children: [{ id: child }] });
    expect(executeChatTool(round, "read_argument", { position_id, argument_id: child })).toMatchObject({ parent_id: root });
    executeChatTool(round, "edit_argument", { position_id, argument_id: root, expected_text: "Original argument", text: "Revised warrant" });
    expect(flow.textOf(root)).toBe("Revised warrant");
    expect(flow.parentOf(child)).toBe(root);
    expect(() => executeChatTool(round, "edit_argument", { position_id, argument_id: root, expected_text: "Original argument", text: "Stale rewrite" })).toThrow("changed");
    expect(flow.textOf(root)).toBe("Revised warrant");
    flow.remove(root);
    expect(() => executeChatTool(round, "read_argument", { position_id, argument_id: root })).toThrow("no longer exists");
    expect(() => executeChatTool(round, "read_position", { position_id: "missing" })).toThrow("no longer exists");
  });
});

it("mutates the shared tree, rejects cycles, and protects changed branches", () => {
  const round = new Round();
  const { position_id } = executeChatTool(round, "create_position", { title: "Case" }) as { position_id: string };
  const flow = round.flow(position_id);
  const create = (parent_id: string | null, text: string) => (executeChatTool(round, "create_argument", { position_id, parent_id, text, speech: 1 }) as { argumentId: string }).argumentId;
  const root = create(null, "Root");
  const child = create(root, "Child");
  expect(() => executeChatTool(round, "move_argument", { position_id, argument_id: root, parent_id: child, expected_parent_id: null, index: 0 })).toThrow();
  expect(flow.parentOf(root)).toBeNull();
  executeChatTool(round, "move_argument", { position_id, argument_id: child, parent_id: null, expected_parent_id: root, index: 0 });
  expect(flow.roots()[0].id).toBe(child);
  executeChatTool(round, "set_argument_speech", { position_id, argument_id: child, expected_speech: 1, speech: 2 });
  expect(flow.speechOf(child)).toBe(2);
  const snapshot = executeChatTool(round, "read_argument", { position_id, argument_id: root }) as { subtree_snapshot: string };
  const response = create(root, "New response");
  expect(() => executeChatTool(round, "delete_argument", { position_id, argument_id: root, expected_subtree: snapshot.subtree_snapshot })).toThrow("changed");
  const fresh = executeChatTool(round, "read_argument", { position_id, argument_id: root }) as { subtree_snapshot: string };
  executeChatTool(round, "delete_argument", { position_id, argument_id: root, expected_subtree: fresh.subtree_snapshot });
  expect(flow.has(root)).toBe(false);
  expect(flow.has(response)).toBe(false);
  expect(flow.has(child)).toBe(true);
  executeChatTool(round, "rename_position", { position_id, title: "Solvency" });
  expect(round.sheets().find(s => s.id === position_id)?.title).toBe("Solvency");
});
