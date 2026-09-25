# Relay Observability + Self-Diagnosis Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make a rejected or stale browser extension impossible to mistake for "the relay died": the daemon records why it rejects, `oe_health`/`doctor` say what to do, the extension badge distinguishes "unreachable" from "rejected", and the Makefile stops killing the wrong process.

**Architecture:** relay-server.ts gains rejection telemetry + an extension-version field on `/health`. A new pure module `src/relay-diagnosis.ts` turns a `/health` payload into `{state, hint}` and is shared by `oe_health` (server.ts) and `doctor.ts`. The extension sends its manifest version in a header and shows a distinct badge on 403/409. Makefile filters `lsof` to LISTEN sockets.

**Tech Stack:** Node 26 / TypeScript, `node:test` via `./node_modules/.bin/tsx --test`, esbuild for the extension, GNU make.

**Background (why):** see `docs/plans/2026-09-25-relay-observability-design.md`. Incident: Brave ran a stale 0.3.0 service worker, then the v2 server rejected real polls because Chromium omits `Origin` on host-permitted extension fetches. The daemon logged nothing, so `relay-8780.log` showed only `reap:idle` cycles for two weeks.

**Conventions:**
- Run tests: `./node_modules/.bin/tsx --test test/<file>.test.ts` (never `npx tsx`, the shell hook rewrites it).
- Typecheck: `./node_modules/.bin/tsc -p tsconfig.json --noEmit`.
- Commit on branch `fix/relay-observability`; never push; never commit to `main`.
- Commit trailer (required):
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01VBuRUPxN8dLEmQqCFdKuKj
  ```

---

### Task 1: Daemon records rejections and the extension version

**Files:**
- Modify: `src/relay-server.ts` (state near line 131 `let lastPollAt = 0;`, `ExtensionIdentity` ~line 105, `extensionIdentity` ~line 160, every `sendJson(req, res, 403, …)` on `/poll` and `/result`, the `/health` payload ~line 356)
- Test: `test/relay-server.test.ts`

**Step 1: Write the failing tests** (append to `test/relay-server.test.ts`)

```ts
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
```

**Step 2: Run to verify they fail**

Run: `./node_modules/.bin/tsx --test test/relay-server.test.ts 2>&1 | grep -E '✖|ℹ (pass|fail)'`
Expected: 3 ✖ (rejected undefined / extensionVersion undefined / rejects.length 0).

**Step 3: Implement**

In `src/relay-server.ts`:

1. Add the header constant next to `RELAY_EXTENSION_HEADER`:
   ```ts
   /** Optional: the extension's manifest version, surfaced on /health for diagnosis. */
   export const RELAY_EXTENSION_VERSION_HEADER = "x-openevidence-relay-extension";
   ```
2. `ExtensionIdentity` gets `version: string | null;`. In `extensionIdentity`, after the capability check:
   ```ts
   const rawVersion = req.headers[RELAY_EXTENSION_VERSION_HEADER];
   const v = Array.isArray(rawVersion) ? rawVersion[0] : rawVersion;
   const version = typeof v === "string" && /^[0-9A-Za-z.\-]{1,32}$/.test(v) ? v : null;
   return { origin, clientId, version };
   ```
   `sameInstallation` ignores `version`. When `acceptExtension` returns the cached `activeExtension`, refresh its version: `if (identity.version && activeExtension.version !== identity.version) activeExtension.version = identity.version;` (an extension reload keeps the capability but bumps the version).
3. Rejection state next to `lastActivityAt`:
   ```ts
   let rejected = 0;
   let lastReject: { at: number; path: string; reason: string } | null = null;
   const rejectLoggedAt = new Map<string, number>();
   const REJECT_LOG_INTERVAL_MS = 60_000;

   const reject = (req: IncomingMessage, res: ServerResponse, pathname: string, reason: string): void => {
     rejected += 1;
     lastReject = { at: now(), path: pathname, reason };
     const key = `${pathname} ${reason}`;
     const last = rejectLoggedAt.get(key) ?? -Infinity;
     if (now() - last >= REJECT_LOG_INTERVAL_MS) {
       rejectLoggedAt.set(key, now());
       const hasOrigin = req.headers.origin !== undefined;
       const hasCapability = req.headers[RELAY_EXTENSION_HEADER] !== undefined;
       log(
         `relay: rejected ${req.method ?? "GET"} ${pathname} — ${reason} ` +
           `(origin=${hasOrigin ? "yes" : "no"} capability=${hasCapability ? "yes" : "no"})`,
       );
     }
     sendJson(req, res, 403, { ok: false, error: reason });
   };
   ```
4. Replace the four 403 sites on `/poll` and `/result` with `reject(req, res, pathname, "paired extension channel required")` / `"request belongs to another extension"`. Leave `/health`, `/relay`, OPTIONS and the untrusted-origin 403 as they are (those are not the extension failing to pair). Also count the untrusted-origin 403 via `reject(req, res, pathname, "browser origin not allowed")` — a web page hitting the relay is worth seeing.
5. `/health` payload adds:
   ```ts
   rejected,
   lastRejectAt: lastReject?.at ?? null,
   lastRejectPath: lastReject?.path ?? null,
   lastRejectReason: lastReject?.reason ?? null,
   extensionVersion: activeExtension?.version ?? null,
   ```

**Step 4: Run tests + typecheck**

Run: `./node_modules/.bin/tsx --test test/relay-server.test.ts 2>&1 | grep -E '✖|ℹ (pass|fail)'` → `ℹ fail 0`
Run: `./node_modules/.bin/tsc -p tsconfig.json --noEmit` → no output

**Step 5: Commit**

```bash
git add src/relay-server.ts test/relay-server.test.ts
git commit -m "feat(relay): record rejected polls and the extension version on /health"
```

---

### Task 2: Pure diagnosis module shared by oe_health and doctor

**Files:**
- Create: `src/relay-diagnosis.ts`
- Test: `test/relay-diagnosis.test.ts`

**Step 1: Write the failing tests**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { diagnoseRelay } from "../src/relay-diagnosis.js";

const NOW = 1_000_000;

test("diagnose: daemon down", () => {
  const d = diagnoseRelay(null, { distVersion: "0.4.0", now: NOW });
  assert.equal(d.state, "down");
  assert.match(d.hint, /not answering/);
});

test("diagnose: connected and versions agree → no hint", () => {
  const d = diagnoseRelay({ connected: true, extensionVersion: "0.4.0" }, { distVersion: "0.4.0", now: NOW });
  assert.equal(d.state, "connected");
  assert.equal(d.hint, null);
});

test("diagnose: connected but extension older than extension/dist → reload", () => {
  const d = diagnoseRelay({ connected: true, extensionVersion: "0.3.0" }, { distVersion: "0.4.0", now: NOW });
  assert.equal(d.state, "stale-extension");
  assert.match(d.hint!, /0\.3\.0/);
  assert.match(d.hint!, /0\.4\.0/);
  assert.match(d.hint!, /brave:\/\/extensions|chrome:\/\/extensions/);
});

test("diagnose: not connected, rejected within the last minute → say why", () => {
  const d = diagnoseRelay(
    { connected: false, lastRejectAt: NOW - 5_000, lastRejectReason: "paired extension channel required", lastRejectPath: "/poll" },
    { distVersion: "0.4.0", now: NOW },
  );
  assert.equal(d.state, "rejected");
  assert.match(d.hint!, /paired extension channel required/);
  assert.match(d.hint!, /Reload/);
});

test("diagnose: not connected, no recent rejection → extension is not polling", () => {
  const d = diagnoseRelay({ connected: false, lastRejectAt: NOW - 600_000 }, { distVersion: "0.4.0", now: NOW });
  assert.equal(d.state, "silent");
  assert.match(d.hint!, /not polling/);
});

test("diagnose: unknown versions never trigger the stale hint", () => {
  const d = diagnoseRelay({ connected: true, extensionVersion: null }, { distVersion: null, now: NOW });
  assert.equal(d.state, "connected");
});
```

**Step 2: Run to verify fail** — `./node_modules/.bin/tsx --test test/relay-diagnosis.test.ts` → module not found.

**Step 3: Implement `src/relay-diagnosis.ts`**

```ts
/**
 * Turn a relay `/health` payload into one actionable diagnosis. Pure, so
 * oe_health (server.ts) and `doctor` share the exact same wording.
 */
import { readFileSync } from "node:fs";

export type RelayState = "down" | "connected" | "stale-extension" | "rejected" | "silent";

export interface RelayDiagnosis {
  state: RelayState;
  hint: string | null;
}

export interface RelayHealthLike {
  connected?: unknown;
  extensionVersion?: unknown;
  lastRejectAt?: unknown;
  lastRejectReason?: unknown;
  lastRejectPath?: unknown;
}

const RECENT_REJECT_MS = 60_000;
const RELOAD = "reload the unpacked extension in brave://extensions (or chrome://extensions)";

export function diagnoseRelay(
  h: RelayHealthLike | null,
  ctx: { distVersion: string | null; now: number },
): RelayDiagnosis {
  if (!h) {
    return { state: "down", hint: "Relay daemon is not answering on this port. It respawns on the next oe_ask, or run `make doctor`." };
  }
  const extVersion = typeof h.extensionVersion === "string" ? h.extensionVersion : null;
  if (h.connected === true) {
    if (extVersion && ctx.distVersion && extVersion !== ctx.distVersion) {
      return {
        state: "stale-extension",
        hint: `Browser is running extension v${extVersion} but extension/dist is v${ctx.distVersion} — ${RELOAD}.`,
      };
    }
    return { state: "connected", hint: null };
  }
  const rejectAt = typeof h.lastRejectAt === "number" ? h.lastRejectAt : null;
  if (rejectAt !== null && ctx.now - rejectAt <= RECENT_REJECT_MS) {
    const reason = typeof h.lastRejectReason === "string" ? h.lastRejectReason : "unknown reason";
    const path = typeof h.lastRejectPath === "string" ? h.lastRejectPath : "?";
    return {
      state: "rejected",
      hint: `The extension IS polling but the relay rejects it (${path}: ${reason}). Usually a stale service worker after a rebuild — Reload: ${RELOAD}.`,
    };
  }
  return {
    state: "silent",
    hint: "The extension is not polling the relay — is the browser running with the extension loaded from extension/dist?",
  };
}

/** Version string in extension/dist/manifest.json, or null when not built. */
export function readExtensionDistVersion(manifestPath: string): string | null {
  try {
    const m = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown };
    return typeof m.version === "string" ? m.version : null;
  } catch {
    return null;
  }
}
```

**Step 4: Run tests** → `ℹ fail 0`; typecheck clean.

**Step 5: Commit**

```bash
git add src/relay-diagnosis.ts test/relay-diagnosis.test.ts
git commit -m "feat(relay): pure relay diagnosis shared by oe_health and doctor"
```

---

### Task 3: oe_health and doctor use the diagnosis

**Files:**
- Modify: `src/server.ts` (oe_health tool, ~lines 173-225)
- Modify: `src/doctor.ts` (add an async check near `relayDaemonChecks`, push it in `main()` ~line 515, skip when `--offline`)
- Test: none new for server.ts (thin glue); `test/doctor.test.ts` untouched (the check is I/O, its logic lives in Task 2).

**Step 1: server.ts**

- Import: `import { diagnoseRelay, readExtensionDistVersion } from "./relay-diagnosis.js";` and `import { fileURLToPath } from "node:url";` if not present.
- Add near the top: `const EXTENSION_DIST_MANIFEST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "extension", "dist", "manifest.json");`
- In `oe_health`, after `const h = await fetchRelayHealth(config.relayPort);` compute `const distVersion = readExtensionDistVersion(EXTENSION_DIST_MANIFEST); const diag = diagnoseRelay(h, { distVersion, now: Date.now() });`
- Daemon-down branch: keep fields, set `hint: diag.hint`.
- Up branch: `healthy: h.connected === true && versionMatch && diag.state === "connected"`, add
  ```ts
  extension_version: typeof h.extensionVersion === "string" ? h.extensionVersion : null,
  extension_dist_version: distVersion,
  relay_rejected: typeof h.rejected === "number" ? h.rejected : null,
  last_reject_reason: typeof h.lastRejectReason === "string" ? h.lastRejectReason : null,
  last_reject_at: typeof h.lastRejectAt === "number" ? new Date(h.lastRejectAt).toISOString() : null,
  diagnosis: diag.state,
  ...(diag.hint && { hint: diag.hint }),
  ```
  and delete the old inline `hint` spread.

**Step 2: doctor.ts**

```ts
async function relayExtensionCheck(port: number, manifestPath: string): Promise<DoctorCheck> {
  const h = await fetchRelayHealth(port);
  const diag = diagnoseRelay(h, { distVersion: readExtensionDistVersion(manifestPath), now: Date.now() });
  const level: CheckLevel = diag.state === "connected" ? "pass" : diag.state === "down" ? "warn" : "fail";
  const ext = h && typeof h.extensionVersion === "string" ? ` (extension v${h.extensionVersion})` : "";
  return {
    level,
    code: "relay-extension",
    message: `relay on :${port}: ${diag.state}${ext}`,
    ...(diag.hint && { hint: diag.hint }),
  };
}
```
Import `fetchRelayHealth` from `./relay-client.js` and the two diagnosis functions. In `main()` right after `checks.push(...relayDaemonChecks());`: `if (!offline) checks.push(await relayExtensionCheck(config.relayPort, EXTENSION_DIST_MANIFEST));` with the same `EXTENSION_DIST_MANIFEST` constant defined in doctor.ts.

**Step 3: Typecheck + full tests**

Run: `./node_modules/.bin/tsc -p tsconfig.json --noEmit && ./node_modules/.bin/tsx --test test/*.test.ts 2>&1 | grep -E 'ℹ (pass|fail)'` → `fail 0`.

**Step 4: Commit**

```bash
git add src/server.ts src/doctor.ts
git commit -m "feat(health): oe_health and doctor explain why the extension is not paired"
```

---

### Task 4: Extension sends its version and shows "rejected" distinctly

**Files:**
- Modify: `extension/src/background.ts` (`getRelayHeaders` ~line 20-45, `BadgeState`/`setBadge` ~line 95-115, `pollOnce`/`pollLoop` ~line 450-490)
- Modify: `extension/readme.js` (the `connected:false` explanation block, ~line 150-170)
- Modify: `extension/manifest.json` + `extension/package.json`: bump `"version"` to `0.4.1` (so the new build is distinguishable on /health).
- Test: no unit harness for the extension; verified in Task 6.

**Step 1: version header** — in `getRelayHeaders`, return
```ts
return {
  "x-openevidence-relay-client": capability,
  "x-openevidence-relay-extension": chrome.runtime.getManifest().version,
};
```

**Step 2: badge** — `type BadgeState = "off" | "ok" | "busy" | "err" | "rejected";` and `setBadge(state, detail?: string)`; colours add `rejected: "#ea580c"`; titles add `rejected: "OpenEvidence MCP Relay — relay rejected this extension" + (detail ? `: ${detail}` : "") + " — if you rebuilt it, click Reload in brave://extensions"`.

**Step 3: pollOnce / pollLoop**
```ts
class RelayRejectedError extends Error {
  constructor(public readonly status: number, detail: string) {
    super(`relay poll rejected (${status}): ${detail}`);
  }
}
```
In `pollOnce`, replace the final `throw new Error(...)` with `throw new RelayRejectedError(res.status, detail.slice(0, 200));`.
In `pollLoop`'s catch:
```ts
} catch (e) {
  if (e instanceof RelayRejectedError) {
    setBadge("rejected", e.message);
    activityRejected(e.message);
    await new Promise((r) => setTimeout(r, 5000)); // rejected: back off harder than "not up yet"
  } else {
    setBadge("off"); // relay daemon unreachable
    await new Promise((r) => setTimeout(r, 2000));
  }
}
```
Add next to `activityDone`:
```ts
// One collapsed row per rejection reason so the status page shows "the relay
// refuses us" instead of nothing at all.
function activityRejected(message: string): void {
  const key = `REJECTED ${message}`;
  writeActivity((log) => {
    const last = log[log.length - 1];
    if (last && last.key === key) {
      last.count = (last.count ?? 1) + 1;
      last.t = Date.now();
      return;
    }
    log.push({ reqId: "", key, t: Date.now(), phase: "done", icon: "⛔", label: `Relay rejected us: ${message}`, count: 1, ok: false });
    while (log.length > ACTIVITY_MAX) log.shift();
  });
}
```

**Step 4: readme.js** — in the `connected:false` branch, after the existing "-> ok, daemon pid …" line, add:
```js
if (h.lastRejectReason) {
  lines.push(`-> the relay rejected this extension's last poll: ${h.lastRejectReason} (${h.lastRejectPath ?? "?"})`);
  lines.push("   If you rebuilt the extension, click Reload on brave://extensions — the old service worker is still running.");
}
```
(Match the variable names actually used in that block; read it first.)

**Step 5: Build**

Run: `make extension` → prints `built openevidence-mcp-relay-extension -> extension/dist (relay port 8780)`.
Then: `grep -c 'x-openevidence-relay-extension' extension/dist/background.js` → `1`.

**Step 6: Commit**

```bash
git add extension/src/background.ts extension/readme.js extension/manifest.json extension/package.json extension/package-lock.json
git commit -m "feat(extension): report manifest version and show relay rejections on the badge"
```

---

### Task 5: Makefile stops killing client sockets and reminds to reload

**Files:**
- Modify: `Makefile` (`kill-all` ~line 186-192, `reap` ~line 194-204, `extension` ~line 90-92)

**Step 1:** In `kill-all` and `reap`, change every `lsof -ti tcp:$(RELAY_PORT)` to `lsof -ti tcp:$(RELAY_PORT) -sTCP:LISTEN`. Without `-sTCP:LISTEN`, `lsof` also lists every MCP server holding a *client* socket to the port, so `kill-all` frees the port by killing an MCP server, and `reap` may "keep" an MCP server pid and reap the real daemon.

**Step 2:** Append to the `extension` target:
```make
	@printf '\n\033[1m⚠  Browser still runs the OLD service worker.\033[0m  Open brave://extensions (or chrome://extensions) and click Reload on "OpenEvidence MCP Relay".\n\n'
```

**Step 3: Verify**

Run: `lsof -ti tcp:8780 -sTCP:LISTEN` → exactly one pid, and `ps -p $(lsof -ti tcp:8780 -sTCP:LISTEN) -o command` shows `relay-daemon.js`.
Run: `make -n extension | tail -2` → shows the printf.

**Step 4: Commit**

```bash
git add Makefile
git commit -m "fix(make): only treat the LISTEN socket as the relay daemon; remind to reload the extension"
```

---

### Task 6: Ship it locally and verify end-to-end

**Files:** none (runtime).

1. `./node_modules/.bin/tsc -p tsconfig.json` (server dist) — `make extension` already ran in Task 4.
2. Restart the daemon by its own pid (never via a bare lsof):
   ```bash
   pid=$(lsof -ti tcp:8780 -sTCP:LISTEN); ps -p "$pid" -o command | grep -q relay-daemon && kill -TERM "$pid"
   node -e "const {spawn}=require('child_process');spawn(process.execPath,['dist/relay-daemon.js'],{detached:true,stdio:'ignore'}).unref()"
   ```
3. Ask the user to click Reload on brave://extensions.
4. `curl -s http://127.0.0.1:8780/health` → `connected:true`, `extensionVersion:"0.4.1"`, `rejected` shows the pre-reload 403s.
5. Call the `oe_health` MCP tool → `diagnosis:"connected"`, `extension_version:"0.4.1"`, `extension_dist_version:"0.4.1"`, no hint.
6. Negative check: `curl -s http://127.0.0.1:8780/poll >/dev/null; tail -1 ~/.openevidence-mcp/relay-8780.log` → one `relay: rejected GET /poll — paired extension channel required (origin=no capability=no)` line.
7. Add a CHANGELOG entry under a new `## Unreleased` heading at the top of `CHANGELOG.md` (one bullet per Task 1-5 + the Origin fix), commit `docs: changelog for relay observability`.

---

### Task 7: Cross-agent ask queue in the daemon

Design: `docs/plans/2026-09-25-relay-observability-design.md` → "Addendum: cross-agent ask queue".

**Files:**
- Modify: `src/relay-server.ts` (`RelayServerOptions`, state near `let lastPollAt`, `deliver`, `flush`, the `/poll` handler, the `/result` handler, the timeout in `request()`, `/health`, `close()`)
- Modify: `src/relay-daemon.ts` (pass env-derived `askSpacingMs` / `minGapMs` into `startRelayServer`)
- Modify: `src/server.ts` (`oe_health`: `ask_queue_waiting`, `ask_in_flight`)
- Test: `test/relay-server.test.ts`

**Step 1: Write the failing tests** (append)

```ts
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
```

**Step 2: Run to verify they fail** — `./node_modules/.bin/tsx --test test/relay-server.test.ts 2>&1 | grep -E '✖|ℹ (pass|fail)'` → the five new tests ✖ (options unknown / held poll delivered early).

**Step 3: Implement in `src/relay-server.ts`**

1. Options:
   ```ts
   export interface RelayServerOptions {
     port: number;
     host?: string;
     now?: () => number;
     logger?: (message: string) => void;
     /** Min spacing between consecutive asks (POST /api/article), measured from the previous ask's completion. 0 = off. */
     askSpacingMs?: number;
     /** Min gap between any two deliveries to the extension. 0 = off. */
     minGapMs?: number;
   }
   ```
   `const askSpacingMs = Math.max(0, options.askSpacingMs ?? 0); const minGapMs = Math.max(0, options.minGapMs ?? 0);` — library default 0 keeps every existing test's timing; production values come from the daemon (step 4).
2. Helpers + state next to `let lastPollAt = 0;`:
   ```ts
   const isAsk = (r: RelayRequest): boolean =>
     r.method.toUpperCase() === "POST" && /^\/api\/article\/?$/.test(r.path);
   let askInFlight: string | null = null; // reqId of the delivered-but-unanswered ask
   let lastAskAt = 0;          // last ask delivery (for /health)
   let lastAskDoneAt = -Infinity;
   let lastDeliveredAt = -Infinity;
   let flushTimer: ReturnType<typeof setTimeout> | null = null;
   let flushTimerAt = Infinity; // absolute time the armed flushTimer fires

   // One timer at a time, re-armed when an earlier deadline shows up (a read's
   // gap must not wait behind an ask's spacing).
   const armFlush = (at: number): void => {
     if (flushTimer !== null) {
       if (at >= flushTimerAt) return;
       clearTimeout(flushTimer);
     }
     flushTimerAt = at;
     flushTimer = setTimeout(() => { flushTimer = null; flushTimerAt = Infinity; flush(); }, Math.max(1, at - now()));
   };

   /** First outbox entry deliverable now, or when to look again. */
   const takeEligible = (): PendingReq | null => {
     const t = now();
     let retryAt: number | null = null;
     const later = (at: number): void => { retryAt = retryAt === null ? at : Math.min(retryAt, at); };
     const gapAt = lastDeliveredAt + minGapMs;
     if (t < gapAt) later(gapAt);
     else {
       for (const p of outbox) {
         if (!pending.has(p.reqId)) continue;
         if (isAsk(p.req)) {
           if (askInFlight !== null) continue;
           const readyAt = lastAskDoneAt + askSpacingMs;
           if (t < readyAt) { later(readyAt); continue; }
         }
         outbox.splice(outbox.indexOf(p), 1);
         return p;
       }
     }
     if (retryAt !== null && waiters.length > 0) armFlush(retryAt);
     return null;
   };

   const askFinished = (reqId: string): void => {
     if (askInFlight !== reqId) return;
     askInFlight = null;
     lastAskDoneAt = now();
     // Lane just opened: a parked poller may take the next ask, or arm the spacing timer.
     flush();
   };
   ```
   Note `takeEligible` runs before a waiter is pushed in `/poll`, so also call `armFlush` there (see 4).
3. `deliver`: after `p.clientId = clientId;` add `lastDeliveredAt = now(); if (isAsk(p.req)) { askInFlight = p.reqId; lastAskAt = now(); }`.
4. `flush`: 
   ```ts
   const flush = (): void => {
     while (waiters.length > 0) {
       const p = takeEligible();
       if (!p) break;
       const waiter = waiters.shift()!;
       clearTimeout(waiter.timer);
       deliver(waiter.req, waiter.res, p, waiter.clientId);
     }
   };
   ```
   `/poll` handler: replace `const p = outbox.find((x) => pending.has(x.reqId)); if (p) { outbox.splice(...); deliver(...); return; }` with `const p = takeEligible(); if (p) { deliver(req, res, p, extension.clientId); return; }` and, right after `waiters.push(...)`, call `takeEligible()` once more? No — simpler: after `waiters.push(...)`, call `flush()` (it is a no-op when nothing is eligible, and it arms the timer now that a waiter exists).
5. `/result` handler: right after `clearTimeout(p.timer); pending.delete(p.reqId);` (both the success path, before `lastPollAt = now()`, and the malformed-payload 400 branch), add `askFinished(p.reqId);` — it flushes itself when the lane opens.
6. `request()` timeout callback: add `askFinished(reqId);` after `pending.delete(reqId)`. Because `askFinished` flushes, a poller already parked while the lane was busy (skipped at `askInFlight !== null`, so no timer exists) receives the next ask immediately instead of waiting out `POLL_HOLD_MS`. Freeing the lane on timeout relies on the extension honouring `deadlineAt` (it aborts the in-tab fetch).
7. `/health` payload: `askWaiting: outbox.filter((p) => pending.has(p.reqId) && isAsk(p.req)).length, askInFlight: askInFlight !== null, lastAskAt: lastAskAt || null,`.
8. `close()`: `if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; flushTimerAt = Infinity; }`.

**Step 4: Daemon wiring (`src/relay-daemon.ts`)** — next to `idleTtlMs()`:
```ts
function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
```
and pass `askSpacingMs: envMs("OE_MCP_ASK_MIN_INTERVAL_MS", 1000), minGapMs: envMs("OE_MCP_RELAY_MIN_GAP_MS", 250)` into `startRelayServer(...)`. Log them on the "listening" line: `listening on :${port} v2 pid ${pid} askSpacing=${askSpacingMs}ms gap=${minGapMs}ms`.

**Step 5: `oe_health`** — add `ask_queue_waiting: typeof h.askWaiting === "number" ? h.askWaiting : null, ask_in_flight: h.askInFlight === true,`.

**Step 6: Tests + typecheck**

Run: `./node_modules/.bin/tsx --test test/*.test.ts 2>&1 | grep -E 'ℹ (pass|fail)'` → `fail 0`; `./node_modules/.bin/tsc -p tsconfig.json --noEmit` clean. Also `./node_modules/.bin/tsx --test test/relay-server.test.ts` wall time should stay under ~5 s (no accidental 25 s poll holds).

**Step 7: Commit**

```bash
git add src/relay-server.ts src/relay-daemon.ts src/server.ts test/relay-server.test.ts
git commit -m "feat(relay): serialize and space asks across sessions in the daemon"
```

Then re-run Task 6 steps 1-2 (rebuild dist, restart the daemon by pid) and check `curl -s 127.0.0.1:8780/health` shows `askInFlight:false`, and the log line shows `askSpacing=1000ms gap=250ms`.
