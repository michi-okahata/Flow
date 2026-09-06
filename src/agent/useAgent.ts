import { useCallback, useEffect, useRef, useState } from "react";
import type { Flow } from "../model/flow";
import type { Argument } from "../model/types";
import { providerFor } from "./provider";
import { saveTranscript } from "./transcript";
import { applyAgentToolCall } from "./tools";
import type { AiConfig, AgentDraft, AgentRequest, Transcript } from "./types";

interface AgentContext {
  config: AiConfig | null;
  flow: Flow | null;
  roots: Argument[];
  sheet: string;
  speeches: number;
}

export interface AgentControls {
  drafts: AgentDraft[];
  generate: (argumentIds: string[]) => void;
  accept: (requestId?: string) => string | null;
  dismiss: (requestId?: string) => void;
  error: string | null;
}

function id(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

export function useAgent(ctx: AgentContext): AgentControls {
  const [drafts, setDrafts] = useState<AgentDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef(new Map<string, AbortController>());
  const transcript = useRef(new Map<string, Transcript>());
  const latest = useRef(ctx);
  const draftRef = useRef(drafts);
  latest.current = ctx;
  draftRef.current = drafts;

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
    const { config, flow, roots, sheet, speeches } = latest.current;
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

    const request: AgentRequest = {
      id: id(),
      sheet,
      argumentId,
      argument: flow.textOf(argumentId),
      speech,
      flow: roots,
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
  }, [finish]);

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

  useEffect(() => () => {
    for (const controller of abort.current.values()) controller.abort();
    for (const draft of draftRef.current) finish(draft.requestId, "cancelled");
  }, [finish]);

  return { drafts, generate, accept, dismiss, error };
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
