import { describe, expect, it } from "vitest";
import { LoroDoc } from "loro-crdt";
import { Round } from "./round";
import type { AgentMessage } from "../agent/types";

const message = (id: string, content: string): AgentMessage => ({
  id,
  role: "user",
  content,
  createdAt: "2026-09-09T00:00:00.000Z",
});

describe("agent threads", () => {
  it("starts with none, and writes nothing until one is asked for", () => {
    const round = new Round();
    expect(round.agentThreads()).toEqual([]);
    // Opening a round must not put a thread in everyone's document.
    expect(round.doc.getMovableList("agent-threads").length).toBe(0);
  });

  it("keeps each thread's messages to itself", () => {
    const round = new Round();
    const politics = round.addAgentThread("Politics DA");
    const topicality = round.addAgentThread("T");
    round.appendAgentMessage(politics, message("m1", "go for the link turn"));
    round.appendAgentMessage(topicality, message("m2", "we are effects-topical"));

    expect(round.agentThreads().map((thread) => thread.title)).toEqual(["Politics DA", "T"]);
    expect(round.agentMessages(politics).map((m) => m.content)).toEqual(["go for the link turn"]);
    expect(round.agentMessages(topicality).map((m) => m.content)).toEqual(["we are effects-topical"]);
  });

  it("renames a thread without moving its messages", () => {
    const round = new Round();
    const thread = round.addAgentThread("New thread");
    round.appendAgentMessage(thread, message("m1", "prep the 2NR"));
    round.renameAgentThread(thread, "2NR");
    expect(round.agentThreads()[0]).toMatchObject({ id: thread, title: "2NR" });
    expect(round.agentMessages(thread)).toHaveLength(1);
  });

  it("takes the messages with the thread when it is deleted", () => {
    const round = new Round();
    const thread = round.addAgentThread("scratch");
    round.appendAgentMessage(thread, message("m1", "never mind"));
    round.removeAgentThread(thread);
    expect(round.agentThreads()).toEqual([]);
    expect(round.hasAgentThread(thread)).toBe(false);
    expect(round.agentMessages(thread)).toEqual([]);
  });

  it("empties a thread without deleting it", () => {
    const round = new Round();
    const thread = round.addAgentThread("Case");
    round.appendAgentMessage(thread, message("m1", "start over"));
    round.clearAgentMessages(thread);
    expect(round.agentMessages(thread)).toEqual([]);
    expect(round.hasAgentThread(thread)).toBe(true);
  });

  it("reads a pre-threads document as one thread, without rewriting it", () => {
    const doc = new LoroDoc();
    const legacy = doc.getList("agent-chat");
    legacy.insert(0, message("m1", "flow the DA first"));
    doc.commit();
    const round = new Round(doc);

    const [thread, ...rest] = round.agentThreads();
    expect(rest).toEqual([]);
    expect(thread.id).toBe("agent-chat");
    expect(round.agentMessages(thread.id).map((m) => m.content)).toEqual(["flow the DA first"]);
    // Reading it is not a change: the registry stays unwritten until something
    // actually needs it.
    expect(doc.getMovableList("agent-threads").length).toBe(0);
  });

  it("keeps the inferred thread listed once a second one is started", () => {
    const doc = new LoroDoc();
    doc.getList("agent-chat").insert(0, message("m1", "flow the DA first"));
    doc.commit();
    const round = new Round(doc);
    const second = round.addAgentThread("Topicality");

    expect(round.agentThreads().map((thread) => thread.id)).toEqual(["agent-chat", second]);
    expect(round.agentMessages("agent-chat")).toHaveLength(1);
  });

  it("moves the document version when a message lands", () => {
    // What the panel memoizes its reads on: a message appended by a peer has
    // to change this, or the thread it arrived in would never redraw.
    const round = new Round();
    const thread = round.addAgentThread("Case");
    const before = round.version();
    round.appendAgentMessage(thread, message("m1", "turn the impact"));
    expect(round.version()).not.toBe(before);
  });

  it("does not put a thread on the undo stack", () => {
    const round = new Round();
    const sheet = round.addSheet("Case");
    round.flow(sheet).add({ root: null }, { text: "warming advantage", speech: 0 });
    const thread = round.addAgentThread("Case");
    round.appendAgentMessage(thread, message("m1", "turn it"));

    // `u` after the agent says something takes back your last argument, not
    // the conversation.
    round.undo();
    expect(round.flow(sheet).roots()).toEqual([]);
    expect(round.agentMessages(thread)).toHaveLength(1);
  });

  it("merges two peers' threads rather than losing one", () => {
    const mine = new Round();
    mine.addSheet("Case");
    const yours = Round.fromSnapshot(mine.export());

    mine.appendAgentMessage(mine.addAgentThread("Politics"), message("m1", "link turn"));
    yours.appendAgentMessage(yours.addAgentThread("Topicality"), message("m2", "we meet"));
    mine.import(yours.export());

    expect(mine.agentThreads().map((thread) => thread.title).sort()).toEqual(["Politics", "Topicality"]);
    for (const thread of mine.agentThreads()) {
      expect(mine.agentMessages(thread.id)).toHaveLength(1);
    }
  });
});
