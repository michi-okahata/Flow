import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { httpBaseOf, relayTransport } from "../src/sync/transport";

const PORT = 14_000 + Math.floor(Math.random() * 1000);
const RELAY_URL = `ws://127.0.0.1:${PORT}`;
let relay;
let dataDir;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "flow-relay-"));
  relay = spawn(process.execPath, ["server/relay.mjs"], {
    env: { ...process.env, FLOW_RELAY_PORT: String(PORT), FLOW_RELAY_DATA: dataDir },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve) => relay.stdout.once("data", () => resolve()));
});

afterAll(() => {
  relay.kill();
  rmSync(dataDir, { recursive: true, force: true });
});

/** A network that won't carry a WebSocket: every attempt fails. */
class BlockedWebSocket {
  onclose = null;
  onopen = null;
  onerror = null;
  onmessage = null;
  readyState = 0;
  binaryType = "blob";
  constructor() {
    setTimeout(() => this.onclose?.(), 5);
  }
  send() {}
  close() {}
}

function peer(options = {}) {
  const received = [];
  const statuses = [];
  let resolveOpen;
  const opened = new Promise((r) => (resolveOpen = r));
  const transport = relayTransport(
    RELAY_URL,
    {
      onOpen: () => {
        transport.send({ t: "join", room: "bcdfgh", peer: String(Math.random()), role: "human" });
        resolveOpen();
      },
      onMessage: (m) => received.push(m),
      onStatus: (s) => statuses.push(s),
    },
    options,
  );
  const next = (t) =>
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 10_000;
      const check = () => {
        const i = received.findIndex((m) => m.t === t);
        if (i >= 0) return resolve(received.splice(i, 1)[0]);
        if (Date.now() > deadline) return reject(new Error(`no ${t}`));
        setTimeout(check, 20);
      };
      check();
    });
  return { transport, opened, next, statuses };
}

describe("relayTransport", () => {
  it("maps a relay URL to its HTTP base", () => {
    expect(httpBaseOf("wss://flow.up.railway.app/")).toBe("https://flow.up.railway.app");
    expect(httpBaseOf("ws://127.0.0.1:1421")).toBe("http://127.0.0.1:1421");
  });

  it("falls back to polling when WebSockets are blocked, and still shares a room", async () => {
    const ws = peer();
    const polled = peer({ WebSocketImpl: BlockedWebSocket });
    await Promise.all([ws.opened, polled.opened]);
    await ws.next("welcome");
    await polled.next("welcome");
    expect(polled.statuses).toContain("retrying");

    ws.transport.send({ t: "presence", data: "ZnJvbS13cw==" });
    expect(await polled.next("presence")).toEqual({ t: "presence", data: "ZnJvbS13cw==" });

    polled.transport.send({ t: "presence", data: "ZnJvbS1odHRw" });
    expect(await ws.next("presence")).toEqual({ t: "presence", data: "ZnJvbS1odHRw" });

    polled.transport.close();
    expect((await ws.next("gone")).t).toBe("gone");
    ws.transport.close();
  }, 20_000);
});
