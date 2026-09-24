import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Flow } from "../model/flow";
import type { Round } from "../model/round";
import type { Argument } from "../model/types";
import type { Block } from "../memory/store";
import { compactDebate, compactHistory, selectContext } from "./context";
import { providerFor } from "./provider";
import { saveTranscript } from "./transcript";
import { applyAgentToolCall, contextSourcesOf, executeChatTool, executeContextTool } from "./tools";
import type {
  AiConfig,
  AgentChatRequest,
  AgentDraft,
  AgentMessage,
  AgentRequest,
  AgentStep,
  DebateSheet,
  Transcript,
} from "./types";

interface AgentContext {
  config: AiConfig | null;
  flow: Flow | null;
  roots: Argument[];
  sheet: string;
  speeches: number;
  round: Round;
  imported: Block[];
  loadContext: (blocks: Block[]) => Promise<Block[]>;
  selectedArgument?: string;
}

/**
 * A thread as the panel draws it: what the document remembers, with whatever
 * is happening right now folded in on top. The panel never has to join those
 * two halves itself, and so cannot draw a thread as idle while it is running.
 */
export interface AgentThreadView {
  id: string;
  title: string;
  createdAt: string;
  messages: AgentMessage[];
  running: boolean;
  /** Reply text as it streams. Empty between turns. */
  draft: string;
  /** Tool calls made on the turn now running, in order. */
  steps: AgentStep[];
}

export interface AgentControls {
  drafts: AgentDraft[];
  generate: (argumentIds: string[]) => void;
  accept: (requestId?: string) => string | null;
  dismiss: (requestId?: string) => void;
  /** Every thread on the round, oldest first, with live state folded in. */
  threads: AgentThreadView[];
  /** The one on screen. Null means an unstarted thread: the composer is empty
      and nothing has been written to the document yet. */
  thread: AgentThreadView | null;
  activeThread: string | null;
  selectThread: (threadId: string | null) => void;
  renameThread: (threadId: string, title: string) => void;
  deleteThread: (threadId: string) => void;
  send: (message: string) => void;
  /** Interrupt a turn. Defaults to the active thread. */
  stop: (threadId?: string) => void;
  /** Empty a thread without deleting it. Defaults to the active thread. */
  clearThread: (threadId?: string) => void;
  /** True while any thread is working — threads run side by side. */
  running: boolean;
  importedCount: number;
  error: string | null;
}

/** What is on the wire for one thread, until it lands in the document. */
interface Run {
  requestId: string;
  draft: string;
  steps: AgentStep[];
}

function id(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

/** A thread is named after the question that started it, until it is renamed. */
function titleFor(message: string): string {
  const line = message.trim().split("\n")[0]?.trim() ?? "";
  if (!line) return "New thread";
  return line.length > 48 ? `${line.slice(0, 47)}…` : line;
}

/** One line of what a tool returned, for the step list. The full result is in
    the transcript; this is the part you read while it runs. */
function summarize(result: unknown): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "object" && !Array.isArray(result)) {
    const item = result as Record<string, unknown>;
    if (typeof item.context_id === "string" && typeof item.argument === "string") {
      const position = typeof item.position === "string" && item.position ? `${item.position} · ` : "";
      const source = typeof item.source === "string" ? item.source.split(/[\\/]/).pop() : "";
      return `${position}${item.argument}${source ? ` · ${source}` : ""}`.slice(0, 120);
    }
  }
  const text = typeof result === "string" ? result : JSON.stringify(result);
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

export function useAgent(ctx: AgentContext): AgentControls {
  const [drafts, setDrafts] = useState<AgentDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Keyed by thread: two threads run at once, and neither may overwrite the
  // other's streaming reply.
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const abort = useRef(new Map<string, AbortController>());
  const chatAbort = useRef(new Map<string, AbortController>());
  const transcript = useRef(new Map<string, Transcript>());
  const latest = useRef(ctx);
  const draftRef = useRef(drafts);
  const runRef = useRef(runs);
  const activeRound = useRef(ctx.round);
  latest.current = ctx;
  draftRef.current = drafts;
  runRef.current = runs;

  const threads = useMemo<AgentThreadView[]>(
    () => ctx.round.agentThreads().map((thread) => {
      const run = runs[thread.id];
      return {
        ...thread,
        messages: ctx.round.agentMessages(thread.id),
        running: run !== undefined,
        draft: run?.draft ?? "",
        steps: run?.steps ?? [],
      };
    }),
    // `ctx.round` is one object for the life of a document and its messages
    // change underneath it, so the dependency that matters is the document's
    // own version rather than anything React can compare. The render that
    // re-reads it is driven by the session's subscription, which fires on
    // every commit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runs, ctx.round, ctx.round.version()],
  );

  // A thread that was open when it was deleted — by this peer or another —
  // stops being the answer to "which one is showing".
  const shownThread = activeThread && threads.some((thread) => thread.id === activeThread)
    ? activeThread
    : null;
  const thread = threads.find((entry) => entry.id === shownThread) ?? null;
  // Read inside callbacks that outlive this render — a reply landing two
  // minutes later must go to the thread it was sent from, not this closure's.
  const activeThreadRef = useRef(shownThread);
  activeThreadRef.current = shownThread;

  const debate = useCallback((budget: number): DebateSheet[] => {
    const { round } = latest.current;
    return compactDebate(
      round.sheets().map((sheet) => ({ title: sheet.title, arguments: round.flow(sheet.id).roots() })),
      budget,
    );
  }, []);

  /** The standing direction a draft is written under: the open thread's own
      conversation, so switching threads switches what the agent is told. */
  const threadHistory = useCallback((budget: number): AgentMessage[] => {
    const { round } = latest.current;
    const open = activeThreadRef.current;
    return open && round.hasAgentThread(open)
      ? compactHistory(round.agentMessages(open), budget)
      : [];
  }, []);

  const finish = useCallback((requestId: string, outcome: Transcript["outcome"], message?: string) => {
    const current = transcript.current.get(requestId);
    if (!current) return;
    transcript.current.delete(requestId);
    void saveTranscript({
      ...current,
      finishedAt: new Date().toISOString(),
      response: draftRef.current.find((draft) => draft.requestId === requestId)?.text ?? current.response,
      outcome,
      ...(message ? { error: message } : {}),
    });
  }, []);

  const dismiss = useCallback((requestId?: string) => {
    const targets = requestId ? draftRef.current.filter((draft) => draft.requestId === requestId) : draftRef.current;
    for (const draft of targets) {
      abort.current.get(draft.requestId)?.abort();
      abort.current.delete(draft.requestId);
      finish(draft.requestId, draft.status === "generating" ? "cancelled" : "dismissed");
    }
    setDrafts((current) => requestId ? current.filter((draft) => draft.requestId !== requestId) : []);
    setError(null);
  }, [finish]);

  const generateOne = useCallback((argumentId: string) => {
    const { config, flow, roots, sheet, speeches, imported, loadContext } = latest.current;
    if (!config) {
      setError("AI is not configured — add a valid ai section to ~/.flow/config.json");
      return;
    }
    if (!flow?.has(argumentId)) return;
    const speech = flow.speechOf(argumentId) + 1;
    if (speech >= speeches) {
      setError("there is no speech after this argument");
      return;
    }

    const budget = config.contextTokens ?? 12_000;
    const history = threadHistory(Math.floor(budget * 0.35));
    const contextQuery =
      `${sheet} ${flow.textOf(argumentId)} ${history.filter((m) => m.role === "user").map((m) => m.content).join(" ")}`;
    const contextBudget = Math.floor(budget * 0.3);
    const context = selectContext(
      imported,
      contextQuery,
      sheet,
      contextBudget,
    );
    const request: AgentRequest = {
      id: id(),
      sheet,
      argumentId,
      argument: flow.textOf(argumentId),
      speech,
      flow: roots,
      debate: debate(Math.floor(budget * 0.35)),
      history,
      context,
      contextSources: contextSourcesOf(imported),
    };
    let provider;
    try {
      provider = providerFor(config);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    const controller = new AbortController();
    abort.current.set(request.id, controller);
    const startedAt = new Date().toISOString();
    transcript.current.set(request.id, {
      id: request.id,
      startedAt,
      finishedAt: startedAt,
      provider: provider.name,
      router: config.router,
      api: config.api,
      model: config.model,
      request,
      response: "",
      outcome: "generated",
    });
    setError(null);
    setDrafts((current) => [...current, {
      requestId: request.id,
      sourceId: argumentId,
      speech,
      text: "",
      answers: [],
      status: "generating",
    }]);

    void (async () => {
      try {
        request.context = selectContext(
          await loadContext(request.context),
          contextQuery,
          sheet,
          contextBudget,
        );
        for await (const token of provider.generate(request, controller.signal)) {
          const running = transcript.current.get(request.id);
          if (running) {
            running.response += token;
          }
          setDrafts((current) => current.map((draft) =>
            draft.requestId === request.id ? { ...draft, text: draft.text + token } : draft,
          ));
        }
        abort.current.delete(request.id);
        setDrafts((current) => current.map((draft) => {
          if (draft.requestId !== request.id) return draft;
          const response = draft.text.trim();
          const answers = parseAnswers(response);
          if (answers.length === 0) {
            const message = response ? "agent returned malformed answer JSON" : "agent returned no answer";
            setError(message);
            finish(request.id, "error", message);
            return { ...draft, status: "error", error: message };
          }
          const saved = transcript.current.get(request.id);
          if (saved) saved.response = response;
          return { ...draft, text: response, answers, status: "ready" };
        }));
      } catch (cause) {
        if (controller.signal.aborted) return;
        abort.current.delete(request.id);
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        setDrafts((current) => current.map((draft) =>
          draft.requestId === request.id ? { ...draft, status: "error", error: message } : draft,
        ));
        finish(request.id, "error", message);
      }
    })();
  }, [debate, finish, threadHistory]);

  const generate = useCallback((argumentIds: string[]) => {
    for (const argumentId of new Set(argumentIds)) generateOne(argumentId);
  }, [generateOne]);

  const accept = useCallback((requestId?: string): string | null => {
    const current = requestId
      ? draftRef.current.find((draft) => draft.requestId === requestId)
      : draftRef.current.find((draft) => draft.status === "ready");
    const { flow } = latest.current;
    if (!current || !flow || current.status !== "ready" || current.answers.length === 0) return null;
    const toolCalls = current.answers.map((text) => ({
      name: "add_argument" as const,
      arguments: { under: current.sourceId, speech: current.speech, text },
    }));
    try {
      const results = toolCalls.map((toolCall) => applyAgentToolCall(flow, toolCall));
      const saved = transcript.current.get(current.requestId);
      if (saved) {
        transcript.current.set(current.requestId, { ...saved, toolCalls, toolResults: results });
      }
      finish(current.requestId, "accepted");
      setDrafts((drafts) => drafts.filter((draft) => draft.requestId !== current.requestId));
      setError(null);
      return results[0]?.argumentId ?? null;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      finish(current.requestId, "error", message);
      setDrafts((drafts) => drafts.filter((draft) => draft.requestId !== current.requestId));
      return null;
    }
  }, [finish]);

  /* ---- threads ---------------------------------------------------------- */

  const selectThread = useCallback((threadId: string | null) => {
    setActiveThread(threadId);
    setError(null);
  }, []);

  const renameThread = useCallback((threadId: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    latest.current.round.renameAgentThread(threadId, trimmed.slice(0, 200));
  }, []);

  const stop = useCallback((threadId?: string) => {
    const target = threadId ?? activeThreadRef.current;
    if (!target) return;
    chatAbort.current.get(target)?.abort();
  }, []);

  const deleteThread = useCallback((threadId: string) => {
    chatAbort.current.get(threadId)?.abort();
    latest.current.round.removeAgentThread(threadId);
    setActiveThread((current) => (current === threadId ? null : current));
  }, []);

  const clearThread = useCallback((threadId?: string) => {
    const target = threadId ?? activeThreadRef.current;
    if (!target) return;
    chatAbort.current.get(target)?.abort();
    latest.current.round.clearAgentMessages(target);
  }, []);

  const send = useCallback((raw: string) => {
    const message = raw.trim().slice(0, 8000);
    if (!message) return;
    const { config, round, imported, sheet, selectedArgument } = latest.current;
    if (!config) {
      setError("AI is not configured — add a valid ai section to ~/.flow/config.json");
      return;
    }
    let provider;
    try {
      provider = providerFor(config);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }

    // The thread is written on the first message rather than when the panel
    // opens: a thread nobody said anything in is not a thread, and every peer
    // in the room would see it appear.
    const open = activeThreadRef.current;
    const threadId = open && round.hasAgentThread(open) ? open : round.addAgentThread(titleFor(message));
    if (threadId !== open) {
      setActiveThread(threadId);
      activeThreadRef.current = threadId;
    }
    // One turn at a time within a thread; the next message would be answering
    // a conversation the running turn has not finished writing.
    if (chatAbort.current.has(threadId)) return;

    const requestId = id();
    const budget = config.contextTokens ?? 12_000;
    const history = compactHistory(round.agentMessages(threadId), Math.floor(budget * 0.35));
    const request: AgentChatRequest = {
      id: requestId,
      message,
      selectedArgument,
      sheet,
      debate: debate(Math.floor(budget * 0.35)),
      history,
      context: [],
      contextSources: contextSourcesOf(imported),
    };
    const now = new Date().toISOString();
    round.appendAgentMessage(threadId, { id: `${requestId}:user`, role: "user", content: message, createdAt: now });
    const controller = new AbortController();
    chatAbort.current.set(threadId, controller);
    transcript.current.set(requestId, {
      id: requestId,
      startedAt: now,
      finishedAt: now,
      provider: provider.name,
      router: config.router,
      api: config.api,
      model: config.model,
      request,
      response: "",
      outcome: "generated",
    });
    setRuns((current) => ({ ...current, [threadId]: { requestId, draft: "", steps: [] } }));
    setError(null);

    /** Record a step against this thread's run, by id. */
    const patchStep = (stepId: string, change: Partial<AgentStep>) =>
      setRuns((current) => {
        const run = current[threadId];
        if (!run) return current;
        return {
          ...current,
          [threadId]: {
            ...run,
            steps: run.steps.map((step) => (step.id === stepId ? { ...step, ...change } : step)),
          },
        };
      });

    void (async () => {
      let response = "";
      const steps: AgentStep[] = [];
      try {
        for await (const token of provider.chat(request, controller.signal, (name, args) => {
          controller.signal.throwIfAborted();
          if (latest.current.round !== round) throw new Error("The active debate changed");
          const stepId = id();
          const step: AgentStep = {
            id: stepId,
            name,
            arguments: args,
            status: "running",
            startedAt: new Date().toISOString(),
          };
          steps.push(step);
          setRuns((current) => {
            const run = current[threadId];
            return run ? { ...current, [threadId]: { ...run, steps: [...run.steps, step] } } : current;
          });
          try {
            const result = name === "search_context" || name === "read_context" || name === "list_context_sources"
              ? executeContextTool(imported, name, args)
              : executeChatTool(round, name, args);
            const done = { status: "done" as const, detail: summarize(result), finishedAt: new Date().toISOString() };
            Object.assign(step, done);
            patchStep(stepId, done);
            const saved = transcript.current.get(requestId);
            if (saved) (saved.chatTools ??= []).push({ name, arguments: args, result });
            return result;
          } catch (cause) {
            const detail = cause instanceof Error ? cause.message : String(cause);
            const failed = { status: "error" as const, detail, finishedAt: new Date().toISOString() };
            Object.assign(step, failed);
            patchStep(stepId, failed);
            throw cause;
          }
        })) {
          response += token;
          setRuns((current) => {
            const run = current[threadId];
            return run ? { ...current, [threadId]: { ...run, draft: response } } : current;
          });
        }
        const content = response.trim();
        if (!content) throw new Error("agent returned no reply");
        round.appendAgentMessage(threadId, {
          id: `${requestId}:assistant`,
          role: "assistant",
          content,
          createdAt: new Date().toISOString(),
          ...(steps.length ? { steps } : {}),
        });
        const saved = transcript.current.get(requestId);
        if (saved) saved.response = content;
        finish(requestId, "generated");
      } catch (cause) {
        const stopped = controller.signal.aborted;
        const message = stopped
          ? "stopped"
          : cause instanceof Error ? cause.message : String(cause);
        // The turn is written down either way. Its tool calls already changed
        // the flow, and a thread that shows the reply but not the edits — or
        // shows neither — is a thread that lies about what happened.
        if ((steps.length || response.trim()) && latest.current.round === round && round.hasAgentThread(threadId)) {
          round.appendAgentMessage(threadId, {
            id: `${requestId}:assistant`,
            role: "assistant",
            content: response.trim(),
            createdAt: new Date().toISOString(),
            ...(steps.length ? { steps } : {}),
            error: message,
          });
        }
        if (!stopped) setError(message);
        finish(requestId, stopped ? "cancelled" : "error", message);
      } finally {
        if (chatAbort.current.get(threadId) === controller) chatAbort.current.delete(threadId);
        setRuns((current) => {
          if (current[threadId]?.requestId !== requestId) return current;
          const { [threadId]: _done, ...rest } = current;
          return rest;
        });
      }
    })();
  }, [debate, finish]);

  // A loaded or joined round is a different debate. Work started against the
  // old one must not arrive late and append itself to a document off screen.
  useEffect(() => {
    if (activeRound.current === ctx.round) return;
    for (const controller of chatAbort.current.values()) controller.abort();
    for (const requestId of Object.values(runRef.current).map((run) => run.requestId)) {
      finish(requestId, "cancelled");
    }
    for (const [requestId, controller] of abort.current) {
      controller.abort();
      finish(requestId, "cancelled");
    }
    abort.current.clear();
    chatAbort.current.clear();
    activeRound.current = ctx.round;
    setDrafts([]);
    setRuns({});
    setActiveThread(null);
  }, [ctx.round, finish]);

  useEffect(() => () => {
    for (const controller of chatAbort.current.values()) controller.abort();
    for (const run of Object.values(runRef.current)) finish(run.requestId, "cancelled");
    for (const controller of abort.current.values()) controller.abort();
    for (const draft of draftRef.current) finish(draft.requestId, "cancelled");
  }, [finish]);

  return {
    drafts,
    generate,
    accept,
    dismiss,
    threads,
    thread,
    activeThread: shownThread,
    selectThread,
    renameThread,
    deleteThread,
    send,
    stop,
    clearThread,
    running: Object.keys(runs).length > 0,
    importedCount: ctx.imported.length,
    error,
  };
}

/** A provider should return the requested JSON array; plain text stays useful
 * if a compatible endpoint ignores that instruction. */
export function parseAnswers(response: string): string[] {
  const text = response.trim();
  if (!text) return [];
  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) candidates.push(fenced);
  const array = enclosedArray(text);
  if (array) candidates.push(array);

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      const values = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && Array.isArray((parsed as { answers?: unknown }).answers)
          ? (parsed as { answers: unknown[] }).answers
          : null;
      if (!values) continue;
      return values
        .filter((answer): answer is string => typeof answer === "string")
        .map((answer) => answer.trim())
        .filter(Boolean);
    } catch {
      // Try the next wrapper a compatible provider may have added.
    }
  }

  // Plain prose from an endpoint that ignored the format instruction remains
  // useful as one answer. JSON-looking output is withheld so brackets and
  // half-written strings never become a flow argument.
  return text.startsWith("[") || text.startsWith("{") || text.includes("```json") ? [] : [text];
}

/** Find the first complete JSON array even when reasoning or prose surrounds it. */
function enclosedArray(text: string): string | null {
  const start = text.indexOf("[");
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "[") depth++;
    else if (char === "]" && --depth === 0) return text.slice(start, index + 1);
  }
  return null;
}
