import type { ClientMessage, ServerMessage } from "./protocol";

/**
 * The wire, as the session sees it: somewhere to send messages, somewhere they
 * arrive from, and a status.
 *
 * An interface rather than a WebSocket directly because the session shouldn't
 * know what it's talking over. Today that is a WebSocket, or polling over
 * HTTP where a network won't carry one; the ones worth leaving room for are a `BroadcastChannel` (two windows on one machine,
 * no server), and an in-process pipe — which is how an assistant flowing a
 * round could run inside the app rather than across a network, without the
 * session being written twice.
 */

export type ConnectionStatus =
  /** Not trying to be connected. */
  | "offline"
  /** First attempt, or an attempt after the connection dropped. */
  | "connecting"
  /** Connected, and the room has been joined. */
  | "online"
  /** Dropped, waiting out the backoff before trying again. */
  | "retrying";

export interface Transport {
  send(message: ClientMessage): void;
  close(): void;
}

export interface TransportHandlers {
  /**
   * The connection is up. Whatever has to be said before anything else — the
   * `join`, and the snapshot that follows it — is said here, because it has to
   * be said again after every reconnect and this is the one place that knows a
   * reconnect happened.
   */
  onOpen(): void;
  onMessage(message: ServerMessage): void;
  onStatus(status: ConnectionStatus): void;
}

/** Backoff between reconnection attempts: doubling, capped, from a half-second. */
const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 10_000;

/**
 * How long a WebSocket gets to open. Some filtering proxies neither refuse an
 * upgrade nor complete it, and a socket stuck in `CONNECTING` never closes on
 * its own — without this it would be the last attempt ever made.
 */
const WS_OPEN_TIMEOUT_MS = 8_000;

/** Attempts that never open, in one way, before trying the other. */
const FAILURES_BEFORE_SWITCH = 2;

/** How long any polling request may take. A poll is held at most twenty
    seconds by the relay; past this, something between us has swallowed it. */
const HTTP_TIMEOUT_MS = 35_000;

export interface WebSocketOptions {
  /**
   * The WebSocket constructor to use. Browsers and Node 22+ both have one
   * globally; this is for a headless peer on a runtime that doesn't, which can
   * pass `ws`'s.
   */
  WebSocketImpl?: typeof WebSocket;
  /** `fetch`, for polling, where the global one won't do. */
  fetchImpl?: typeof fetch;
}

/** One attempt at a connection, over one kind of wire. */
interface Channel {
  send(message: ClientMessage): void;
  /** Tear down without reporting a close — this is not a drop. */
  close(): void;
}

interface ChannelEvents {
  onOpen(): void;
  onMessage(message: ServerMessage): void;
  /** Once, however it ended: failed to open, or dropped after. */
  onClose(): void;
}

type Wire = "ws" | "http";

/**
 * A relay connection that keeps trying.
 *
 * Reconnection is not a nicety here: a flow is written in the twenty minutes
 * where nobody can stop to fix anything, over conference-room wifi. Messages
 * sent while the connection is down are dropped rather than queued — every one
 * of them is either a CRDT update, which the snapshot sent on reconnect makes
 * good anyway, or presence, which is worthless by the time it would be
 * delivered.
 *
 * It starts as a WebSocket and falls back to polling over plain HTTP(S) when
 * the socket keeps failing to open — which on a school or tournament network
 * usually means a proxy that won't carry one, not a relay that is down. The
 * two alternate until one opens, and whichever did is tried first on every
 * reconnect after.
 */
export function relayTransport(
  url: string,
  handlers: TransportHandlers,
  options: WebSocketOptions = {},
): Transport {
  let channel: Channel | null = null;
  let wire: Wire = "ws";
  let failures = 0;
  let retryMs = RETRY_MIN_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const open = () => {
    if (closed) return;
    handlers.onStatus("connecting");
    let opened = false;
    const events: ChannelEvents = {
      onOpen: () => {
        if (closed || channel !== current) return;
        opened = true;
        failures = 0;
        retryMs = RETRY_MIN_MS;
        handlers.onStatus("online");
        handlers.onOpen();
      },
      onMessage: (message) => {
        if (!closed && channel === current) handlers.onMessage(message);
      },
      onClose: () => {
        if (channel !== current) return;
        channel = null;
        if (!opened && ++failures >= FAILURES_BEFORE_SWITCH) {
          wire = wire === "ws" ? "http" : "ws";
          failures = 0;
        }
        retry();
      },
    };
    const current: Channel =
      wire === "ws"
        ? websocketChannel(url, events, options)
        : pollingChannel(url, events, options);
    channel = current;
  };

  const retry = () => {
    if (closed || timer !== null) return;
    handlers.onStatus("retrying");
    timer = setTimeout(() => {
      timer = null;
      open();
    }, retryMs);
    retryMs = Math.min(RETRY_MAX_MS, retryMs * 2);
  };

  open();

  return {
    send(message) {
      channel?.send(message);
    },
    close() {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      const current = channel;
      channel = null;
      current?.close();
      handlers.onStatus("offline");
    },
  };
}

function websocketChannel(
  url: string,
  events: ChannelEvents,
  options: WebSocketOptions,
): Channel {
  const Impl = options.WebSocketImpl ?? WebSocket;
  let done = false;
  let ws: WebSocket | null = null;
  let openTimer: ReturnType<typeof setTimeout> | null = null;

  const end = () => {
    if (done) return;
    done = true;
    if (openTimer !== null) clearTimeout(openTimer);
    detach();
    // Reported on the next tick, so a constructor that throws doesn't close
    // the channel before `relayTransport` has been handed it.
    setTimeout(events.onClose, 0);
  };

  const detach = () => {
    if (!ws) return;
    ws.onopen = null;
    ws.onclose = null;
    ws.onerror = null;
    ws.onmessage = null;
    try {
      ws.close();
    } catch {
      // Already closing.
    }
  };

  try {
    ws = new Impl(url);
  } catch {
    // A malformed URL, or a scheme the runtime won't open. Retrying is still
    // right — the URL can be corrected while the app runs.
    end();
    return { send() {}, close() {} };
  }
  ws.binaryType = "arraybuffer";
  openTimer = setTimeout(end, WS_OPEN_TIMEOUT_MS);

  ws.onopen = () => {
    if (openTimer !== null) clearTimeout(openTimer);
    openTimer = null;
    events.onOpen();
  };
  ws.onmessage = (event) => {
    if (typeof event.data !== "string") return;
    let message: ServerMessage;
    try {
      message = JSON.parse(event.data) as ServerMessage;
    } catch {
      return; // not ours; the alternative is taking the connection down
    }
    events.onMessage(message);
  };
  // Both paths end the same way. `onerror` fires before `onclose` on a failed
  // connection, so the close is reported from `onclose` alone.
  ws.onerror = () => {};
  ws.onclose = end;

  return {
    send(message) {
      if (!done && ws?.readyState === 1) ws.send(JSON.stringify(message));
    },
    close() {
      done = true;
      if (openTimer !== null) clearTimeout(openTimer);
      detach();
    },
  };
}

/**
 * The relay's protocol over ordinary requests: one held-open poll for what
 * arrives, and posts, one at a time and in order, for what is sent. See
 * `server/relay.mjs` for the other end.
 */
function pollingChannel(
  url: string,
  events: ChannelEvents,
  options: WebSocketOptions,
): Channel {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const base = httpBaseOf(url);
  const abort = new AbortController();
  let done = false;
  let sid: string | null = null;
  let outbox: ClientMessage[] = [];
  let sending = false;

  const end = () => {
    if (done) return;
    done = true;
    abort.abort();
    events.onClose();
  };

  const request = async (path: string, init: RequestInit = {}) => {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), HTTP_TIMEOUT_MS);
    const onAbort = () => timeout.abort();
    abort.signal.addEventListener("abort", onAbort);
    try {
      const response = await fetchImpl(`${base}${path}`, {
        ...init,
        cache: "no-store",
        signal: timeout.signal,
      });
      if (!response.ok) throw new Error(`relay: ${response.status}`);
      return response;
    } finally {
      clearTimeout(timer);
      abort.signal.removeEventListener("abort", onAbort);
    }
  };

  const flush = async () => {
    if (sending || done || sid === null || outbox.length === 0) return;
    sending = true;
    const batch = outbox;
    outbox = [];
    try {
      await request(`/http/send?sid=${encodeURIComponent(sid)}`, {
        method: "POST",
        // text/plain, so a browser doesn't preflight it.
        headers: { "content-type": "text/plain" },
        body: JSON.stringify(batch),
      });
    } catch {
      end();
      return;
    } finally {
      sending = false;
    }
    void flush();
  };

  void (async () => {
    try {
      const opened = await request("/http/open", { method: "POST" });
      const body = (await opened.json()) as { sid?: unknown };
      if (typeof body.sid !== "string") throw new Error("relay: no session");
      if (done) return;
      sid = body.sid;
      events.onOpen();
      void flush();
      while (!done) {
        const polled = await request(`/http/poll?sid=${encodeURIComponent(sid)}`);
        const messages = (await polled.json()) as unknown;
        if (done) return;
        if (Array.isArray(messages)) {
          for (const message of messages) events.onMessage(message as ServerMessage);
        }
      }
    } catch {
      end();
    }
  })();

  return {
    send(message) {
      if (done || sid === null) return;
      outbox.push(message);
      void flush();
    },
    close() {
      if (done) return;
      done = true;
      abort.abort();
      // Tells the room now rather than when the relay notices the silence.
      // Best effort: nothing waits on it.
      if (sid !== null) {
        fetchImpl(`${base}/http/close?sid=${encodeURIComponent(sid)}`, {
          method: "POST",
          keepalive: true,
        }).catch(() => {});
      }
    },
  };
}

/** `wss://host/path` -> `https://host/path`, with no trailing slash. */
export function httpBaseOf(url: string): string {
  return url.replace(/^ws(s?):\/\//i, "http$1://").replace(/\/+$/, "");
}
