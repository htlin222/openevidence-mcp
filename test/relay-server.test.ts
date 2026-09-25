import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

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
      ["/health", { headers: { origin: "https://evil.example" } }],
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

test("relay: no-Origin callers without the capability header cannot poll or post results", async () => {
  const relay = await startRelayServer({ port: 0 });
  try {
    for (const [path, init] of [
      ["/poll", {}],
      [
        "/result",
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
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

// Chromium omits the Origin header on fetches an extension makes to a host it
// holds host_permissions for (sec-fetch-site: none). The real extension therefore
// arrives with the capability header but NO Origin — that must be accepted, or
// the relay can never pair with a live browser.
test("relay: accepts the capability header without an Origin (real Chromium extension fetch)", async () => {
  const relay = await startRelayServer({ port: 0 });
  const noOrigin = { [RELAY_EXTENSION_HEADER]: RELAY_EXTENSION_HEADER_VALUE };
  try {
    const pollP = fetch(`http://127.0.0.1:${relay.port}/poll`, { headers: noOrigin }).then((r) =>
      r.json(),
    );
    const pending = relay.request({ method: "GET", path: "/api/auth/me" }, { timeoutMs: 5000 });
    const delivered = (await pollP) as { reqId: string };
    assert.ok(delivered.reqId);
    assert.equal(relay.isConnected(), true);

    const res = await fetch(`http://127.0.0.1:${relay.port}/result`, {
      method: "POST",
      headers: { "content-type": "application/json", ...noOrigin },
      body: JSON.stringify({ reqId: delivered.reqId, status: 200, body: '{"ok":1}' }),
    });
    assert.equal(res.status, 200);
    const out = await pending;
    assert.equal(out.status, 200);
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

test("relay: allows PATCH /api/article/<id>/access (share toggle) and only that PATCH", async () => {
  const relay = await startRelayServer({ port: 0 });
  const endpoint = `http://127.0.0.1:${relay.port}/relay`;
  const id = "11111111-2222-4333-8444-555555555555";
  const daemonPost = (body: unknown) =>
    fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    // Allowed: passes validation and reaches the (absent) extension → 504, not 400.
    const ok = await daemonPost({
      method: "PATCH",
      path: `/api/article/${id}/access`,
      body: JSON.stringify({ access_level: "ANYONE_WITH_LINK", shared_with_emails: [] }),
      timeoutMs: 50,
    });
    assert.equal(ok.status, 504);
    // PATCH on any other article path stays blocked.
    for (const path of [`/api/article/${id}`, "/api/article", `/api/article/${id}/access/extra`]) {
      const res = await daemonPost({ method: "PATCH", path, body: "{}", timeoutMs: 50 });
      assert.equal(res.status, 400, path);
      assert.match((await res.json()).error, /not allowed/);
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

test("relay: /health reports rejected polls with the reason and path", async () => {
  const relay = await startRelayServer({ port: 0 });
  try {
    const base = `http://127.0.0.1:${relay.port}`;
    // no capability header → 403
    const res = await fetch(`${base}/poll`);
    assert.equal(res.status, 403);
    const h = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
    assert.equal(h.rejected, 1);
    assert.equal(h.lastRejectPath, "/poll");
    assert.equal(h.lastRejectReason, "paired extension channel required");
    assert.equal(typeof h.lastRejectAt, "number");
  } finally {
    relay.close();
  }
});

test("relay: rejection log lines are rate-limited per reason", async () => {
  let t = 1_000_000;
  const lines: string[] = [];
  const relay = await startRelayServer({ port: 0, now: () => t, logger: (m) => lines.push(m) });
  try {
    const base = `http://127.0.0.1:${relay.port}`;
    await fetch(`${base}/poll`);
    await fetch(`${base}/poll`);
    t += 61_000;
    await fetch(`${base}/poll`);
    const rejects = lines.filter((l) => l.includes("rejected"));
    assert.equal(rejects.length, 2);
    assert.match(rejects[0], /GET \/poll/);
    assert.match(rejects[0], /paired extension channel required/);
    assert.match(rejects[0], /origin=no/);
    assert.match(rejects[0], /capability=no/);
  } finally {
    relay.close();
  }
});

test("relay: /health carries the paired extension's version header", async () => {
  const relay = await startRelayServer({ port: 0 });
  try {
    const base = `http://127.0.0.1:${relay.port}`;
    const pollP = fetch(`${base}/poll`, {
      headers: { ...extensionHeaders, "x-openevidence-relay-extension": "0.4.1" },
    });
    const pending = relay.request({ method: "GET", path: "/api/auth/me" }, { timeoutMs: 5000 });
    const delivered = (await (await pollP).json()) as { reqId: string };
    const h = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
    assert.equal(h.extensionVersion, "0.4.1");
    await post(`${base}/result`, { reqId: delivered.reqId, status: 200, body: "{}" });
    await pending;
  } finally {
    relay.close();
  }
});

test("relay: rejection log rate limit is keyed on the daemon's own routes, not attacker paths", async () => {
  let t = 1_000_000;
  const lines: string[] = [];
  const relay = await startRelayServer({ port: 0, now: () => t, logger: (m) => lines.push(m) });
  try {
    const base = `http://127.0.0.1:${relay.port}`;
    const evil = { origin: "https://evil.example" };
    const res1 = await fetch(`${base}/${randomUUID()}`, { headers: evil });
    assert.equal(res1.status, 403);
    const lastPath = `/${randomUUID()}`;
    const res2 = await fetch(`${base}${lastPath}`, { headers: evil });
    assert.equal(res2.status, 403);
    const rejects = lines.filter((l) => l.includes("rejected"));
    assert.equal(rejects.length, 1, "one log line per reason+normalised path per window");
    const h = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
    assert.equal(h.rejected, 2);
    assert.equal(h.lastRejectPath, lastPath);
    assert.equal(h.lastRejectAt, t);
  } finally {
    relay.close();
  }
});

const ASK = { method: "POST", path: "/api/article", body: "{}" } as const;
const READ = { method: "GET", path: "/api/auth/me" } as const;
type Delivered = { reqId: string; req: { method: string; path: string } };

test("relay: asks are serialized and spaced from the previous ask's completion", async () => {
  const relay = await startRelayServer({ port: 0, askSpacingMs: 200 });
  const base = `http://127.0.0.1:${relay.port}`;
  try {
    const a = relay.request(ASK, { timeoutMs: 5000 });
    const b = relay.request(ASK, { timeoutMs: 5000 });
    const first = (await poll(`${base}/poll`)) as Delivered;
    assert.equal(first.req.path, "/api/article");
    const secondPoll = poll(`${base}/poll`);
    const early = await Promise.race([
      secondPoll.then(() => "delivered"),
      new Promise<string>((r) => setTimeout(() => r("held"), 150)),
    ]);
    assert.equal(early, "held", "second ask must wait while the first is in flight");
    const doneAt = Date.now();
    await post(`${base}/result`, { reqId: first.reqId, status: 201, body: "{}" });
    const second = (await secondPoll) as Delivered;
    assert.equal(second.req.path, "/api/article");
    assert.ok(Date.now() - doneAt >= 180, "second ask honoured askSpacingMs after the first completed");
    await post(`${base}/result`, { reqId: second.reqId, status: 201, body: "{}" });
    await a;
    await b;
  } finally {
    relay.close();
  }
});

test("relay: reads are not blocked behind an in-flight ask", async () => {
  const relay = await startRelayServer({ port: 0, askSpacingMs: 1000 });
  const base = `http://127.0.0.1:${relay.port}`;
  try {
    const ask = relay.request(ASK, { timeoutMs: 5000 });
    const read = relay.request(READ, { timeoutMs: 5000 });
    const first = (await poll(`${base}/poll`)) as Delivered;
    assert.equal(first.req.method, "POST");
    const second = (await poll(`${base}/poll`)) as Delivered;
    assert.equal(second.req.path, "/api/auth/me");
    await post(`${base}/result`, { reqId: second.reqId, status: 200, body: "{}" });
    await read;
    await post(`${base}/result`, { reqId: first.reqId, status: 201, body: "{}" });
    await ask;
  } finally {
    relay.close();
  }
});

test("relay: consecutive deliveries respect the global minimum gap", async () => {
  const relay = await startRelayServer({ port: 0, minGapMs: 150 });
  const base = `http://127.0.0.1:${relay.port}`;
  try {
    const r1 = relay.request(READ, { timeoutMs: 5000 });
    const r2 = relay.request(READ, { timeoutMs: 5000 });
    const t0 = Date.now();
    const first = (await poll(`${base}/poll`)) as Delivered;
    const second = (await poll(`${base}/poll`)) as Delivered;
    assert.ok(Date.now() - t0 >= 140, "second delivery waited for minGapMs");
    await post(`${base}/result`, { reqId: first.reqId, status: 200, body: "{}" });
    await post(`${base}/result`, { reqId: second.reqId, status: 200, body: "{}" });
    await r1;
    await r2;
  } finally {
    relay.close();
  }
});

test("relay: a timed-out ask frees the ask lane", async () => {
  const relay = await startRelayServer({ port: 0, askSpacingMs: 0 });
  const base = `http://127.0.0.1:${relay.port}`;
  try {
    const stuck = relay.request(ASK, { timeoutMs: 100 });
    const first = (await poll(`${base}/poll`)) as Delivered;
    await assert.rejects(stuck, /did not respond/);
    const next = relay.request(ASK, { timeoutMs: 5000 });
    const second = (await poll(`${base}/poll`)) as Delivered;
    assert.notEqual(second.reqId, first.reqId);
    await post(`${base}/result`, { reqId: second.reqId, status: 201, body: "{}" });
    await next;
  } finally {
    relay.close();
  }
});

test("relay: /health exposes the ask queue", async () => {
  const relay = await startRelayServer({ port: 0, askSpacingMs: 1000 });
  const base = `http://127.0.0.1:${relay.port}`;
  try {
    const a = relay.request(ASK, { timeoutMs: 5000 });
    const b = relay.request(ASK, { timeoutMs: 5000 });
    const first = (await poll(`${base}/poll`)) as Delivered;
    const h = (await (await fetch(`${base}/health`)).json()) as Record<string, unknown>;
    assert.equal(h.askInFlight, true);
    assert.equal(h.askWaiting, 1);
    assert.equal(typeof h.lastAskAt, "number");
    await post(`${base}/result`, { reqId: first.reqId, status: 201, body: "{}" });
    await a;
    relay.close(); // drops b
    await assert.rejects(b);
  } finally {
    relay.close();
  }
});

test("relay: a malformed result for an ask frees the ask lane", async () => {
  const relay = await startRelayServer({ port: 0, askSpacingMs: 0 });
  const base = `http://127.0.0.1:${relay.port}`;
  try {
    const bad = relay.request(ASK, { timeoutMs: 5000 });
    const rejected = assert.rejects(bad, /malformed result payload/);
    const first = (await poll(`${base}/poll`)) as Delivered;
    const res = await post(`${base}/result`, { reqId: first.reqId, status: 200 });
    assert.equal(res.status, 400);
    await rejected;
    const next = relay.request(ASK, { timeoutMs: 5000 });
    const second = (await poll(`${base}/poll`)) as Delivered;
    assert.notEqual(second.reqId, first.reqId);
    await post(`${base}/result`, { reqId: second.reqId, status: 201, body: "{}" });
    await next;
  } finally {
    relay.close();
  }
});

// Resolves "held" if `p` is still pending after `ms`; clears its timer so the
// runner does not stay alive waiting on it.
const raceHeld = async <T>(p: Promise<T>, ms: number): Promise<T | "held"> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const held = new Promise<"held">((r) => {
    timer = setTimeout(() => r("held"), ms);
  });
  try {
    return await Promise.race([p, held]);
  } finally {
    clearTimeout(timer);
  }
};

test("relay: an ask timing out re-flushes the already-parked poller", async () => {
  const relay = await startRelayServer({ port: 0, askSpacingMs: 0 });
  const base = `http://127.0.0.1:${relay.port}`;
  try {
    const stuck = relay.request(ASK, { timeoutMs: 100 });
    const first = (await poll(`${base}/poll`)) as Delivered;
    const next = relay.request(ASK, { timeoutMs: 5000 });
    const parked = poll(`${base}/poll`); // parks: the lane is busy, nothing is eligible
    await assert.rejects(stuck, /did not respond/);
    const outcome = await raceHeld(parked.then((d) => (d as Delivered).reqId), 2000);
    assert.notEqual(outcome, "held", "parked poll must receive the next ask once the lane opens");
    assert.notEqual(outcome, first.reqId);
    await post(`${base}/result`, { reqId: outcome, status: 201, body: "{}" });
    await next;
  } finally {
    relay.close();
  }
});

test("relay: the flush timer is re-armed for an earlier deadline", async () => {
  const relay = await startRelayServer({ port: 0, askSpacingMs: 1000, minGapMs: 100 });
  const base = `http://127.0.0.1:${relay.port}`;
  try {
    const a = relay.request(ASK, { timeoutMs: 5000 });
    const first = (await poll(`${base}/poll`)) as Delivered;
    const b = relay.request(ASK, { timeoutMs: 5000 });
    const bDropped = assert.rejects(b); // never delivered here; dropped by close()
    const parked = poll(`${base}/poll`);
    await post(`${base}/result`, { reqId: first.reqId, status: 201, body: "{}" });
    await a;
    // Let the gap elapse so the only armed timer is B's spacing deadline (~1 s out).
    await new Promise((r) => setTimeout(r, 150));
    const r1 = relay.request(READ, { timeoutMs: 5000 });
    const read1 = (await parked) as Delivered;
    assert.equal(read1.req.path, "/api/auth/me");
    const repoll = poll(`${base}/poll`); // parks inside the gap after read1
    const t0 = Date.now();
    const r2 = relay.request(READ, { timeoutMs: 5000 });
    const outcome = await raceHeld(repoll.then((d) => d as Delivered), 500);
    assert.notEqual(outcome, "held", "read must land after the gap, not after the ask spacing");
    const read2 = outcome as Delivered;
    assert.equal(read2.req.path, "/api/auth/me");
    assert.ok(Date.now() - t0 < 500);
    await post(`${base}/result`, { reqId: read1.reqId, status: 200, body: "{}" });
    await post(`${base}/result`, { reqId: read2.reqId, status: 200, body: "{}" });
    await r1;
    await r2;
    relay.close();
    await bDropped;
  } finally {
    relay.close();
  }
});
