import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { RelayClient } from "../src/relay-client.js";
import {
  RELAY_EXTENSION_HEADER,
  RELAY_EXTENSION_HEADER_VALUE,
  startRelayServer,
  type RelayServer,
} from "../src/relay-server.js";

const extensionHeaders = {
  [RELAY_EXTENSION_HEADER]: RELAY_EXTENSION_HEADER_VALUE,
  origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
};

test("relay client respawns a dead daemon and waits for the extension to reconnect", async () => {
  const reservation = await startRelayServer({ port: 0 });
  const port = reservation.port;
  reservation.close();

  let daemon: RelayServer | null = null;
  let extensionRoundTrip: Promise<void> | null = null;
  const client = new RelayClient(port, async () => {
    daemon = await startRelayServer({ port });
    extensionRoundTrip = (async () => {
      const delivered = (await fetch(`http://127.0.0.1:${port}/poll`, {
        headers: extensionHeaders,
      }).then((res) => res.json())) as { reqId: string };
      await fetch(`http://127.0.0.1:${port}/result`, {
        method: "POST",
        headers: { "content-type": "application/json", ...extensionHeaders },
        body: JSON.stringify({
          reqId: delivered.reqId,
          status: 200,
          body: '{"email":"doctor@example.com"}',
        }),
      });
    })();
    return true;
  });

  try {
    await client.start();
    assert.equal(client.isConnected(), false);
    const result = await client.request({ method: "GET", path: "/api/auth/me" });
    assert.equal(result.status, 200);
    assert.match(result.body, /doctor@example\.com/);
    await extensionRoundTrip;
  } finally {
    client.close();
    daemon?.close();
  }
});

test("relay client never replays a POST after an ambiguous daemon disconnect", async () => {
  let relayAttempts = 0;
  let ensureCalls = 0;
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ connected: true, version: 2, pid: process.pid }));
      return;
    }
    if (req.url === "/relay") {
      relayAttempts += 1;
      req.socket.destroy();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new RelayClient(address.port, async () => {
    ensureCalls += 1;
    return true;
  });
  try {
    await client.start();
    await assert.rejects(
      client.request({ method: "POST", path: "/api/article", body: "{}" }),
      /outcome is unknown.*not retried/,
    );
    assert.equal(relayAttempts, 1);
    assert.equal(ensureCalls, 1);
  } finally {
    client.close();
    server.close();
  }
});

test("relay session refuses to cross an extension lease change", async () => {
  let clock = 1_000;
  const relay = await startRelayServer({ port: 0, now: () => clock });
  const base = `http://127.0.0.1:${relay.port}`;
  const firstPoll = fetch(`${base}/poll`, { headers: extensionHeaders });
  const client = new RelayClient(relay.port, async () => true);
  try {
    for (let i = 0; i < 20 && !relay.isConnected(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await client.start();
    const session = await client.openSession();
    assert.ok(session);

    clock += 40_000;
    const secondHeaders = {
      origin: "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      [RELAY_EXTENSION_HEADER]: "extension-v2:11111111-1111-4111-8111-111111111111",
    };
    const secondPoll = fetch(`${base}/poll`, { headers: secondHeaders });
    const replaced = await firstPoll;
    assert.equal(replaced.status, 409);

    await assert.rejects(
      session.request({ method: "GET", path: "/api/auth/me" }),
      /extension lease changed/,
    );
    assert.equal(relay.pending(), 0);
    relay.close();
    assert.equal((await secondPoll).status, 503);
  } finally {
    client.close();
    relay.close();
  }
});
