import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { LoroDoc } from "loro-crdt";
import { WebSocketServer } from "ws";

/**
 * The relay: one process, one room per code, no accounts.
 *
 * It does two things. It forwards — every message from a peer goes to everyone
 * else in that room, and nothing else. And it remembers — it keeps each room's
 * document merged in memory and on disk, so the third person to arrive gets the
 * flow even if the first two have gone home, and so a round survives the
 * process restarting.
 *
 * It does not understand a flow. The document is a Loro blob it merges and
 * re-exports; the relay has no idea what an argument is, which is what lets the
 * sheet's model change without the server being redeployed.
 *
 * ---- writing another peer ------------------------------------------------
 * Anything that speaks this protocol is a peer, including something with no
 * screen. An assistant that transcribes a speech into arguments would connect
 * here exactly as the app does: open a socket, send
 *
 *   { "t": "join", "room": "<code>", "peer": "<loro peer id>", "role": "ai" }
 *
 * then send `{ "t": "doc", "data": "<base64 loro update>" }` as it writes into
 * its own `Flow`, and `{ "t": "presence", … }` so the sheet can show where it
 * is working. `src/model/flow.ts` and `src/sync/session.ts` are free of the DOM
 * for this reason — the same session class runs here.
 */

// `PORT` is what a host like Railway assigns; `FLOW_RELAY_PORT` still wins so
// an existing deploy that set it keeps its port.
const PORT = Number(process.env.FLOW_RELAY_PORT ?? process.env.PORT ?? 1421);
const DATA_DIR = process.env.FLOW_RELAY_DATA ?? ".flow-rooms";
/** How long after the last change a room is written to disk. */
const SAVE_DEBOUNCE_MS = 2_000;

const ROOM_ALPHABET = "bcdfghjkmnpqrstvwxyz23456789";
const ROOM_LENGTH = 6;

/** A room code becomes a filename, so it is validated rather than sanitised. */
const isRoomCode = (code) =>
  typeof code === "string" &&
  code.length === ROOM_LENGTH &&
  [...code].every((c) => ROOM_ALPHABET.includes(c));

mkdirSync(DATA_DIR, { recursive: true });

/** code -> { doc, clients: Set<ws>, saveTimer } */
const rooms = new Map();

function openRoom(code) {
  const existing = rooms.get(code);
  if (existing) return existing;

  const doc = new LoroDoc();
  const path = join(DATA_DIR, `${code}.loro`);
  if (existsSync(path)) {
    try {
      doc.import(new Uint8Array(readFileSync(path)));
    } catch (error) {
      // A snapshot we can't read is worse than none: starting empty lets the
      // room work, and the peers still hold the flow between them.
      console.error(`[relay] ${code}: unreadable snapshot, starting empty`, error);
    }
  }
  // Whether this room's document has ever been written to. Tracked rather than
  // asked of the document, because asking would mean knowing what an empty flow
  // looks like — the one thing the relay is built not to know.
  const written = existsSync(path);
  const room = { doc, path, clients: new Set(), saveTimer: null, written };
  rooms.set(code, room);
  return room;
}

function save(room) {
  if (room.saveTimer) return;
  room.saveTimer = setTimeout(() => {
    room.saveTimer = null;
    try {
      writeFileSync(room.path, Buffer.from(room.doc.export({ mode: "snapshot" })));
    } catch (error) {
      console.error(`[relay] could not save ${room.path}`, error);
    }
  }, SAVE_DEBOUNCE_MS);
}

function broadcast(room, from, message) {
  const payload = JSON.stringify(message);
  for (const client of room.clients) {
    if (client !== from) client.deliver(payload);
  }
}

const send = (client, message) => client.deliver(JSON.stringify(message));

/**
 * A peer, whatever it is connected over. `deliver` takes an already-serialised
 * message; the room logic below never learns whether that went down a socket
 * or into a queue for the next poll.
 */
const newClient = (deliver) => ({ room: null, peer: null, deliver });

function handle(client, message) {
  if (message.t === "join") {
    if (!isRoomCode(message.room)) {
      send(client, { t: "error", reason: "bad room code" });
      return;
    }
    leaveRoom(client);
    const room = openRoom(message.room);
    client.room = room;
    client.peer = typeof message.peer === "string" ? message.peer : null;
    room.clients.add(client);
    send(client, {
      t: "welcome",
      room: message.room,
      doc: room.written
        ? Buffer.from(room.doc.export({ mode: "snapshot" })).toString("base64")
        : null,
    });
    console.log(`[relay] ${message.room}: ${room.clients.size} peer(s)`);
    return;
  }

  // Set by `join`; until then the connection belongs to no room and anything
  // else it says is ignored.
  const room = client.room;
  if (!room) return;

  if (message.t === "doc" && typeof message.data === "string") {
    try {
      room.doc.import(new Uint8Array(Buffer.from(message.data, "base64")));
    } catch (error) {
      // Still forwarded: the peers can merge what the relay's own copy
      // choked on, and a room that keeps working is worth more than a
      // relay whose snapshot is complete.
      console.error(`[relay] bad update`, error);
    }
    room.written = true;
    save(room);
    broadcast(room, client, message);
    return;
  }

  if (message.t === "presence" && typeof message.data === "string") {
    broadcast(room, client, message);
  }
}

function leaveRoom(client) {
  const room = client.room;
  if (!room) return;
  room.clients.delete(client);
  client.room = null;
  // Presence expires on its own, but not for half a minute — telling the room
  // now is what takes a closed laptop's cursor off the sheet immediately.
  if (client.peer) broadcast(room, client, { t: "gone", peer: client.peer });
}

/* ---- polling -------------------------------------------------------------
   The same protocol over plain HTTPS requests, for the networks that won't
   carry a WebSocket: school and tournament wifi whose filtering proxy drops
   the upgrade, or holds it open and never answers. A proxy that lets a web
   page load lets these through, because that is all they are.

     POST /http/open             -> { "sid": "…" }
     POST /http/send?sid=…       body: a JSON array of client messages
     GET  /http/poll?sid=…       -> a JSON array of server messages, answered
                                    as soon as there is one, or empty after
                                    POLL_HOLD_MS

   Bodies go as text/plain so a browser sends them without a CORS preflight —
   one fewer request for a proxy to have an opinion about. */

/** How long a poll is held open with nothing to say. Under the minute most
    proxies allow an idle request. */
const POLL_HOLD_MS = 20_000;
/** A polling peer that hasn't asked for anything in this long has gone. */
const POLL_EXPIRE_MS = 45_000;
/** A snapshot of a long round, base64'd, with room to spare. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

/** sid -> { client, queue: string[], waiting: ServerResponse | null, holdTimer, seen } */
const polling = new Map();

function openPolling() {
  const sid = randomUUID();
  const entry = { queue: [], waiting: null, holdTimer: null, seen: Date.now() };
  entry.client = newClient((payload) => {
    entry.queue.push(payload);
    if (entry.waiting) flushPoll(entry);
  });
  polling.set(sid, entry);
  return sid;
}

function flushPoll(entry) {
  const res = entry.waiting;
  if (!res) return;
  entry.waiting = null;
  clearTimeout(entry.holdTimer);
  entry.holdTimer = null;
  entry.seen = Date.now();
  const body = `[${entry.queue.join(",")}]`;
  entry.queue = [];
  reply(res, 200, body, "application/json");
}

function closePolling(sid) {
  const entry = polling.get(sid);
  if (!entry) return;
  polling.delete(sid);
  if (entry.waiting) flushPoll(entry);
  leaveRoom(entry.client);
}

setInterval(() => {
  const now = Date.now();
  for (const [sid, entry] of polling) {
    if (!entry.waiting && now - entry.seen > POLL_EXPIRE_MS) closePolling(sid);
  }
}, 10_000).unref();

function reply(res, status, body = "", type = "text/plain") {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    // The app is served from anywhere — a dev server, `tauri://localhost` —
    // and a room code is the only credential there is.
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function serveHttp(req, res) {
  const url = new URL(req.url ?? "/", "http://relay");
  if (req.method === "OPTIONS") return reply(res, 204);

  if (url.pathname === "/" && req.method === "GET") {
    // Something to open in a browser to see whether this network reaches the
    // relay at all, and for a host's health check.
    return reply(res, 200, "flow relay\n");
  }

  if (url.pathname === "/http/open" && req.method === "POST") {
    return reply(res, 200, JSON.stringify({ sid: openPolling() }), "application/json");
  }

  const sid = url.searchParams.get("sid") ?? "";
  const entry = polling.get(sid);

  if (url.pathname === "/http/send" && req.method === "POST") {
    let messages;
    try {
      messages = JSON.parse(await readBody(req));
    } catch {
      return reply(res, 400);
    }
    // Checked after the body: the sweep may have run while it was arriving.
    const live = polling.get(sid);
    if (!live) return reply(res, 410);
    live.seen = Date.now();
    if (Array.isArray(messages)) {
      for (const message of messages) {
        if (message && typeof message === "object") handle(live.client, message);
      }
    }
    return reply(res, 204);
  }

  if (url.pathname === "/http/poll" && req.method === "GET") {
    if (!entry) return reply(res, 410);
    // One poll at a time. A second means the first was given up on by the
    // client, so it is answered (empty) rather than left to time out.
    if (entry.waiting) flushPoll(entry);
    entry.waiting = res;
    entry.seen = Date.now();
    if (entry.queue.length > 0) return flushPoll(entry);
    entry.holdTimer = setTimeout(() => flushPoll(entry), POLL_HOLD_MS);
    res.on("close", () => {
      if (entry.waiting === res) {
        entry.waiting = null;
        clearTimeout(entry.holdTimer);
        entry.holdTimer = null;
      }
    });
    return;
  }

  if (url.pathname === "/http/close" && req.method === "POST") {
    closePolling(sid);
    return reply(res, 204);
  }

  reply(res, 404);
}

const httpServer = createServer((req, res) => {
  serveHttp(req, res).catch(() => {
    if (!res.headersSent) reply(res, 500);
  });
});

const server = new WebSocketServer({ server: httpServer });

server.on("connection", (ws) => {
  const client = newClient((payload) => {
    if (ws.readyState === 1) ws.send(payload);
  });

  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message && typeof message === "object") handle(client, message);
  });

  ws.on("close", () => leaveRoom(client));
  ws.on("error", () => leaveRoom(client));
});

httpServer.listen(PORT);

console.log(`[relay] listening on :${PORT} (ws, and http polling), rooms in ${DATA_DIR}/`);
