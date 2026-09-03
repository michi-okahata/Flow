import { useCallback, useEffect, useRef, useState } from "react";
import type { Flow } from "../model/flow";
import type { Argument } from "../model/types";
import { providerFor } from "./provider";
import { saveTranscript } from "./transcript";
import { applyAgentToolCall } from "./tools";
import type { AgentConfig, AgentDraft, AgentRequest, Transcript } from "./types";

interface AgentContext {
  config: AgentConfig | null;
  flow: Flow | null;
  roots: Argument[];
  sheet: string;
  speeches: number;
}

export interface AgentControls {
  draft: AgentDraft | null;
  generate: (argumentId: string) => void;
  accept: () => string | null;
  dismiss: () => void;
  error: string | null;
}

function id(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

export function useAgent(ctx: AgentContext): AgentControls {
  const [draft, setDraft] = useState<AgentDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const transcript = useRef<Transcript | null>(null);
  const latest = useRef(ctx);
  const draftRef = useRef(draft);
  latest.current = ctx;
  draftRef.current = draft;

  const finish = useCallback((outcome: Transcript["outcome"], message?: string) => {
    const current = transcript.current;
    if (!current) return;
    transcript.current = null;
    void saveTranscript({
      ...current,
      finishedAt: new Date().toISOString(),
      response: draftRef.current?.text ?? current.response,
      outcome,
      ...(message ? { error: message } : {}),
    });
  }, []);

  const dismiss = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    if (draftRef.current) finish(
      draftRef.current.status === "generating" ? "cancelled" : "dismissed",
    );
    setDraft(null);
    setError(null);
  }, [finish]);

  const generate = useCallback((argumentId: string) => {
    const { config, flow, roots, sheet, speeches } = latest.current;
    if (!config) {
      setError("agent is not configured — add an agent section to ~/.flow/config.json");
      return;
    }
    if (!flow?.has(argumentId)) return;
    dismiss();
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
    abort.current = controller;
    const startedAt = new Date().toISOString();
    transcript.current = {
      id: request.id,
      startedAt,
      finishedAt: startedAt,
      provider: provider.name,
      model: config.model,
      request,
      response: "",
      outcome: "generated",
    };
    setError(null);
    setDraft({
      requestId: request.id,
      sourceId: argumentId,
      speech,
      text: "",
      status: "generating",
    });

    void (async () => {
      try {
        for await (const token of provider.generate(request, controller.signal)) {
          if (transcript.current?.id === request.id) {
            transcript.current.response += token;
          }
          setDraft((current) =>
            current?.requestId === request.id
              ? { ...current, text: current.text + token }
              : current,
          );
        }
        abort.current = null;
        setDraft((current) => {
          if (current?.requestId !== request.id) return current;
          const text = current.text.trim();
          if (!text) {
            const message = "agent returned no answer";
            setError(message);
            finish("error", message);
            return { ...current, status: "error", error: message };
          }
          if (transcript.current?.id === request.id) transcript.current.response = text;
          return { ...current, text, status: "ready" };
        });
      } catch (cause) {
        if (controller.signal.aborted) return;
        abort.current = null;
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        setDraft((current) =>
          current?.requestId === request.id
            ? { ...current, status: "error", error: message }
            : current,
        );
        finish("error", message);
      }
    })();
  }, [dismiss, finish]);

  const accept = useCallback((): string | null => {
    const current = draftRef.current;
    const { flow } = latest.current;
    if (!current || !flow || current.status !== "ready" || !current.text) return null;
    const toolCall = {
      name: "add_argument" as const,
      arguments: {
        under: current.sourceId,
        speech: current.speech,
        text: current.text,
      },
    };
    try {
      const result = applyAgentToolCall(flow, toolCall);
      if (transcript.current) {
        transcript.current = { ...transcript.current, toolCall, toolResult: result };
      }
      finish("accepted");
      setDraft(null);
      setError(null);
      return result.argumentId;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      finish("error", message);
      setDraft(null);
      return null;
    }
  }, [finish]);

  useEffect(() => () => {
    abort.current?.abort();
    finish("cancelled");
  }, [finish]);

  return { draft, generate, accept, dismiss, error };
}
