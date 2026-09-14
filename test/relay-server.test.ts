import test from "node:test";
import assert from "node:assert/strict";

import {
  RELAY_EXTENSION_HEADER,
  RELAY_EXTENSION_HEADER_VALUE,
  startRelayServer,
} from "../src/relay-server.js";

const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const extensionHeaders = {
  [RELAY_EXTENSION_HEADER]: RELAY_EXTENSION_HEADER_VALUE,
  origin: EXTENSION_ORIGIN,
};

const post = (url: string, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...extensionHeaders },
    body: JSON.stringify(body),
  });

const poll = (url: string) => fetch(url, { headers: extensionHeaders }).then((r) => r.json());

test("relay: delivers a request to a polling client and resolves with status+body", async () => {
  const relay = await startRelayServer({ port: 0 });
  try {
    assert.equal(relay.isConnected(), false);

    const pollP = poll(`http://127.0.0.1:${relay.port}/poll`);
    const reqP = relay.request(
      { method: "POST", path: "/api/article", body: '{"q":1}' },
      { timeoutMs: 5000 },
    );

    const delivered = (await pollP) as {
      reqId: string;
      req: { method: string; path: string; body?: string };
    };
    assert.equal(delivered.req.method, "POST");
    assert.equal(delivered.req.path, "/api/article");
    assert.equal(delivered.req.body, '{"q":1}');
    assert.equal(relay.isConnected(), true);

    const r = await post(`http://127.0.0.1:${relay.port}/result`, {
      reqId: delivered.reqId,
      status: 200,
      body: '{"id":"abc-123"}',
      headers: {
        "content-type": "application/json; charset=utf-8",
        "retry-after": "3",
        "set-cookie": "session=must-not-cross-the-relay",
      },
    });
    assert.equal(r.status, 200);

    const out = await reqP;
    assert.equal(out.status, 200);
    assert.equal(out.body, '{"id":"abc-123"}');
    assert.deepEqual(out.headers, {
      "content-type": "application/json; charset=utf-8",
      "retry-after": "3",
    });
  } finally {
    relay.close();
  }
});

test("relay: surfaces an extension-reported error", async () => {
  const relay = await startRelayServer({ port: 0 });
  try {
    const pollP = poll(`http://127.0.0.1:${relay.port}/poll`);
    const reqP = relay.request({ method: "GET", path: "/api/auth/me" }, { timeoutMs: 5000 });
    const delivered = (await pollP) as { reqId: string };
    const rejection = assert.rejects(reqP, /DataDome 403 even from the tab/);
    await post(`http://127.0.0.1:${relay.port}/result`, {
      reqId: delivered.reqId,
      error: "DataDome 403 even from the tab",
    });
    await rejection;
  } finally {
    relay.close();
  }
});

test("relay: request times out when no extension responds", async () => {
  const relay = await startRelayServer({ port: 0 });
  try {
    await assert.rejects(
      relay.request({ method: "GET", path: "/api/auth/me" }, { timeoutMs: 150 }),
      /did not respond/,
    );
  } finally {
    relay.close();
  }
});

test("relay: /health reports connection state", async () => {
  const relay = await startRelayServer({ port: 0 });
  try {
    const h = await fetch(`http://127.0.0.1:${relay.port}/health`).then((r) => r.json());
    assert.equal(h.ok, true);
    assert.equal(h.connected, false);
  } finally {
    relay.close();
  }
});

test("relay: /health carries live stats (uptime, served, errored, last activity)", async () => {
  const relay = await startRelayServer({ port: 0 });
  const health = () =>
    fetch(`http://127.0.0.1:${relay.port}/health`).then((r) => r.json()) as Promise<{
      startedAt: number;
      served: number;
      errored: number;
      lastActivityAt: number;
      pending: number;
    }>;
  try {
    const before = await health();
    assert.ok(typeof before.startedAt === "number" && before.startedAt > 0);
    assert.equal(before.served, 0);
    assert.equal(before.errored, 0);
    assert.equal(before.lastActivityAt, 0);

    // One served round-trip…
    const pollP = poll(`http://127.0.0.1:${relay.port}/poll`);
    const reqP = relay.request({ method: "GET", path: "/api/auth/me" }, { timeoutMs: 5000 });
    const delivered = (await pollP) as { reqId: string };
    await post(`http://127.0.0.1:${relay.port}/result`, {
      reqId: delivered.reqId,
      status: 200,
      body: "{}",
    });
    await reqP;

    // …and one extension-reported failure.
    const pollP2 = poll(`http://127.0.0.1:${relay.port}/poll`);
    const reqP2 = relay.request({ method: "GET", path: "/api/auth/me" }, { timeoutMs: 5000 });
    // Attach the rejection handler before the result lands, or the runner sees
    // a momentarily-unhandled rejection.
    const rejected = assert.rejects(reqP2, /extension: boom/);
    const delivered2 = (await pollP2) as { reqId: string };
    await post(`http://127.0.0.1:${relay.port}/result`, {
      reqId: delivered2.reqId,
      error: "boom",
    });
    await rejected;

    const after = await health();
    assert.equal(after.served, 1);
    assert.equal(after.errored, 1);
    assert.ok(after.lastActivityAt >= before.startedAt);
    assert.equal(after.pending, 0);
  } finally {
    relay.close();
  }
});

test("relay: rejects ordinary web origins before they can poll, forge, or proxy", async () => {
  const relay = await startRelayServer({ port: 0 });
  const base = `http://127.0.0.1:${relay.port}`;
  const evilHeaders = {
    origin: "https://evil.example",
    "content-type": "application/json",
    [RELAY_EXTENSION_HEADER]: RELAY_EXTENSION_HEADER_VALUE,
  };
  try {
    for (const [path, init] of [
      ["/poll", { headers: evilHeaders }],
      ["/result", { method: "POST", headers: evilHeaders, body: "{}" }],
      [
        "/relay",
        {
          method: "POST",
          headers: evilHeaders,
          body: JSON.stringify({ method: "GET", path: "/api/auth/me" }),
        },
      ],
    ] as const) {
      const res = await fetch(base + path, init);
      assert.equal(res.status, 403);
      assert.equal(res.headers.get("access-control-allow-origin"), null);
    }
    assert.equal(relay.isConnected(), false);
    assert.equal(relay.pending(), 0);
  } finally {
    relay.close();
  }
});

test("relay: extension endpoints require the non-simple channel marker", async () => {
  const relay = await startRelayServer({ port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${relay.port}/poll`, {
      headers: { origin: EXTENSION_ORIGIN },
    });
    assert.equal(res.status, 403);
    assert.equal(relay.isConnected(), false);
  } finally {
    relay.close();
  }
});

test("relay: marker-only no-Origin callers cannot impersonate the extension", async () => {
  const relay = await startRelayServer({ port: 0 });
  try {
    for (const [path, init] of [
      ["/poll", { headers: { [RELAY_EXTENSION_HEADER]: RELAY_EXTENSION_HEADER_VALUE } }],
      [
        "/result",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [RELAY_EXTENSION_HEADER]: RELAY_EXTENSION_HEADER_VALUE,
          },
          body: "{}",
        },
      ],
    ] as const) {
      const res = await fetch(`http://127.0.0.1:${relay.port}${path}`, init);
      assert.equal(res.status, 403);
    }
    assert.equal(relay.isConnected(), false);
  } finally {
    relay.close();
  }
});

test("relay: one live extension installation owns an exclusive lease", async () => {
  const relay = await startRelayServer({ port: 0 });
  const otherHeaders = {
    origin: "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    [RELAY_EXTENSION_HEADER]: "extension-v2:11111111-1111-4111-8111-111111111111",
  };
  try {
    const firstPoll = poll(`http://127.0.0.1:${relay.port}/poll`);
    const pending = relay.request({ method: "GET", path: "/api/auth/me" }, { timeoutMs: 5000 });
    const delivered = (await firstPoll) as { reqId: string };

    const otherPoll = await fetch(`http://127.0.0.1:${relay.port}/poll`, {
      headers: otherHeaders,
    });
    assert.equal(otherPoll.status, 403);

    await post(`http://127.0.0.1:${relay.port}/result`, {
      reqId: delivered.reqId,
      status: 200,
      body: "{}",
    });
    await pending;
  } finally {
    relay.close();
  }
});

test("relay: daemon requests can be pinned to the authenticated extension lease", async () => {
  const relay = await startRelayServer({ port: 0 });
  const base = `http://127.0.0.1:${relay.port}`;
  try {
    const pollP = poll(`${base}/poll`);
    const requestP = relay.request({ method: "GET", path: "/api/auth/me" }, { timeoutMs: 5000 });
    const delivered = (await pollP) as { reqId: string };
    await post(`${base}/result`, { reqId: delivered.reqId, status: 200, body: "{}" });
    await requestP;

    const health = (await fetch(`${base}/health`).then((res) => res.json())) as {
      leaseId: string;
    };
    assert.match(health.leaseId, /^[0-9a-f-]{36}$/i);

    const stale = await fetch(`${base}/relay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "GET",
        path: "/api/auth/me",
        expectedLeaseId: "00000000-0000-4000-8000-000000000000",
      }),
    });
    assert.equal(stale.status, 409);
    assert.equal(relay.pending(), 0);
  } finally {
    relay.close();
  }
});

test("relay: rejects malformed success/error result unions", async () => {
  for (const malformed of [
    { error: "" },
    { status: 199, body: "{}" },
    { status: 200 },
    { status: 200, body: "{}", error: "both" },
  ]) {
    const relay = await startRelayServer({ port: 0 });
    try {
      const pollP = poll(`http://127.0.0.1:${relay.port}/poll`);
      const reqP = relay.request({ method: "GET", path: "/api/auth/me" }, { timeoutMs: 5000 });
      const rejected = assert.rejects(reqP, /malformed result payload/);
      const delivered = (await pollP) as { reqId: string };
      const res = await post(`http://127.0.0.1:${relay.port}/result`, {
        reqId: delivered.reqId,
        ...malformed,
      });
      assert.equal(res.status, 400);
      await rejected;
    } finally {
      relay.close();
    }
  }
});

test("relay: allows an extension CORS preflight and never uses wildcard origin", async () => {
  const relay = await startRelayServer({ port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${relay.port}/poll`, {
      method: "OPTIONS",
      headers: {
        origin: EXTENSION_ORIGIN,
        "access-control-request-method": "GET",
        "access-control-request-headers": RELAY_EXTENSION_HEADER,
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), EXTENSION_ORIGIN);
    assert.notEqual(res.headers.get("access-control-allow-origin"), "*");
  } finally {
    relay.close();
  }
});

test("relay: daemon proxy rejects methods, cross-origin paths, and unknown routes", async () => {
  const relay = await startRelayServer({ port: 0 });
  const endpoint = `http://127.0.0.1:${relay.port}/relay`;
  const daemonPost = (body: unknown) =>
    fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    for (const body of [
      { method: "DELETE", path: "/api/article" },
      { method: "GET", path: "https://evil.example/steal" },
      { method: "GET", path: "//evil.example/steal" },
      { method: "GET", path: "/api/unknown" },
      { method: "GET", path: "/api/auth/me", timeoutMs: 600_001 },
    ]) {
      const res = await daemonPost(body);
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /not allowed|same-origin|timeoutMs/);
    }
  } finally {
    relay.close();
  }
});

test("relay: route matching is exact, not prefix-based", async () => {
  const relay = await startRelayServer({ port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${relay.port}/relay-anything`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "GET", path: "/api/auth/me" }),
    });
    assert.equal(res.status, 404);
  } finally {
    relay.close();
  }
});
