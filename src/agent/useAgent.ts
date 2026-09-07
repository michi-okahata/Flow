import { useCallback, useEffect, useRef, useState } from "react";
import type { Flow } from "../model/flow";
import type { Round } from "../model/round";
import type { Argument } from "../model/types";
import type { Block } from "../memory/store";
import { compactDebate, compactHistory, selectContext } from "./context";
import { providerFor } from "./provider";
import { saveTranscript } from "./transcript";
import { applyAgentToolCall } from "./tools";
import type {
  AiConfig,
  AgentChatRequest,
  AgentDraft,
  AgentMessage,
  AgentRequest,
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

export interface AgentControls {
  drafts: AgentDraft[];
  generate: (argumentIds: string[]) => void;
  accept: (requestId?: string) => string | null;
  dismiss: (requestId?: string) => void;
  messages: AgentMessage[];
  chatDraft: string;
  chatting: boolean;
  send: (message: string) => void;
  clearChat: () => void;
  importedCount: number;
  error: string | null;
}

function id(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

export function useAgent(ctx: AgentContext): AgentControls {
  const [drafts, setDrafts] = useState<AgentDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [chatDraft, setChatDraft] = useState("");
  const [chatting, setChatting] = useState(false);
  const abort = useRef(new Map<string, AbortController>());
  const transcript = useRef(new Map<string, Transcript>());
  const latest = useRef(ctx);
  const draftRef = useRef(drafts);
  const chatAbort = useRef<AbortController | null>(null);
  const chatRequest = useRef<string | null>(null);
  const activeRound = useRef(ctx.round);
  latest.current = ctx;
  draftRef.current = drafts;

  const debate = useCallback((budget: number): DebateSheet[] => {
    const { round } = latest.current;
    return compactDebate(
      round.sheets().map((sheet) => ({ title: sheet.title, arguments: round.flow(sheet.id).roots() })),
      budget,
    );
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
    const { config, flow, roots, sheet, speeches, round, imported, loadContext } = latest.current;
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
    const history = compactHistory(round.agentMessages(), Math.floor(budget * 0.35));
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
            const message = "agent returned no answer";
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
  }, [debate, finish]);

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

  const send = useCallback((raw: string) => {
    const message = raw.trim().slice(0, 8000);
    if (!message || chatting) return;
    const { config, round, imported, loadContext, sheet, selectedArgument } = latest.current;
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

    const requestId = id();
    const budget = config.contextTokens ?? 12_000;
    const prior = round.agentMessages();
    const history = compactHistory(prior, Math.floor(budget * 0.35));
    const contextQuery = `${sheet} ${selectedArgument ?? ""} ${message}`;
    const contextBudget = Math.floor(budget * 0.3);
    const request: AgentChatRequest = {
      id: requestId,
      message,
      selectedArgument,
      sheet,
      debate: debate(Math.floor(budget * 0.35)),
      history,
      context: selectContext(
        imported,
        contextQuery,
        sheet,
        Math.floor(budget * 0.3),
      ),
    };
    const now = new Date().toISOString();
    round.appendAgentMessage({ id: `${requestId}:user`, role: "user", content: message, createdAt: now });
    const controller = new AbortController();
    chatAbort.current?.abort();
    chatAbort.current = controller;
    chatRequest.current = requestId;
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
    setChatDraft("");
    setChatting(true);
    setError(null);

    void (async () => {
      let response = "";
      try {
        request.context = selectContext(
          await loadContext(request.context),
          contextQuery,
          sheet,
          contextBudget,
        );
        for await (const token of provider.chat(request, controller.signal)) {
          response += token;
          setChatDraft(response);
        }
        const content = response.trim();
        if (!content) throw new Error("agent returned no reply");
        round.appendAgentMessage({
          id: `${requestId}:assistant`,
          role: "assistant",
          content,
          createdAt: new Date().toISOString(),
        });
        const saved = transcript.current.get(requestId);
        if (saved) saved.response = content;
        finish(requestId, "generated");
      } catch (cause) {
        if (!controller.signal.aborted) {
          const message = cause instanceof Error ? cause.message : String(cause);
          setError(message);
          finish(requestId, "error", message);
        }
      } finally {
        if (chatAbort.current === controller) chatAbort.current = null;
        if (chatRequest.current === requestId) chatRequest.current = null;
        setChatDraft("");
        setChatting(false);
      }
    })();
  }, [chatting, debate, finish]);

  const clearChat = useCallback(() => {
    chatAbort.current?.abort();
    if (chatRequest.current) finish(chatRequest.current, "cancelled");
    chatAbort.current = null;
    chatRequest.current = null;
    setChatDraft("");
    setChatting(false);
    latest.current.round.clearAgentMessages();
  }, [finish]);

  // A loaded or joined round is a different debate. Work started against the
  // old one must not arrive late and append itself to a document off screen.
  useEffect(() => {
    if (activeRound.current === ctx.round) return;
    chatAbort.current?.abort();
    if (chatRequest.current) finish(chatRequest.current, "cancelled");
    for (const [requestId, controller] of abort.current) {
      controller.abort();
      finish(requestId, "cancelled");
    }
    abort.current.clear();
    chatAbort.current = null;
    chatRequest.current = null;
    activeRound.current = ctx.round;
    setDrafts([]);
    setChatDraft("");
    setChatting(false);
  }, [ctx.round, finish]);

  useEffect(() => () => {
    chatAbort.current?.abort();
    if (chatRequest.current) finish(chatRequest.current, "cancelled");
    for (const controller of abort.current.values()) controller.abort();
    for (const draft of draftRef.current) finish(draft.requestId, "cancelled");
  }, [finish]);

  return {
    drafts,
    generate,
    accept,
    dismiss,
    messages: ctx.round.agentMessages(),
    chatDraft,
    chatting,
    send,
    clearChat,
    importedCount: ctx.imported.length,
    error,
  };
}

/** A provider should return the requested JSON array; plain text stays useful
 * if a compatible endpoint ignores that instruction. */
function parseAnswers(response: string): string[] {
  try {
    const parsed: unknown = JSON.parse(response);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((answer): answer is string => typeof answer === "string")
        .map((answer) => answer.trim())
        .filter(Boolean);
    }
  } catch {
    // Keep a non-conforming provider's text as one accept-able argument.
  }
  return response ? [response] : [];
}
