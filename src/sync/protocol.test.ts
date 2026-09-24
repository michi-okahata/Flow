import { describe, expect, it } from "vitest";
import { relayUrlFor } from "./protocol";
import { hostFromUrl } from "./relay";

describe("relayUrlFor", () => {
  it("speaks plain ws on the default port to a machine on the network", () => {
    expect(relayUrlFor("192.168.1.42")).toBe("ws://192.168.1.42:1421");
    expect(relayUrlFor("192.168.1.42:2000")).toBe("ws://192.168.1.42:2000");
    expect(relayUrlFor("localhost")).toBe("ws://localhost:1421");
    expect(relayUrlFor("michis-mac.local")).toBe("ws://michis-mac.local:1421");
  });

  it("speaks wss on 443 to a relay on the internet", () => {
    expect(relayUrlFor("flow.up.railway.app")).toBe("wss://flow.up.railway.app");
    expect(relayUrlFor("ws://flow.example.com:1421")).toBe("ws://flow.example.com:1421");
  });
});

describe("hostFromUrl", () => {
  it("names a relay so that relayUrlFor finds it again", () => {
    for (const url of [
      "wss://flow.up.railway.app",
      "ws://192.168.1.42:1421",
      "ws://192.168.1.42:2000",
      "ws://127.0.0.1:1421",
    ]) {
      const host = hostFromUrl(url)!;
      expect(new URL(relayUrlFor(host)).href).toBe(new URL(url).href);
    }
    expect(hostFromUrl("wss://flow.up.railway.app")).toBe("flow.up.railway.app");
    expect(hostFromUrl("ws://192.168.1.42:1421")).toBe("192.168.1.42");
  });
});
