// OpenEvidence MCP Relay — MV3 service worker (TypeScript source).
//
// A narrowly allowlisted authenticated fetch bridge. Long-polls the local relay (GET /poll);
// when the MCP server hands us {method, path, body}, we run that fetch INSIDE a
// parked OpenEvidence tab (page-context origin/cookies/TLS — DataDome passes) and
// post the raw {status, body} back to /result. All OpenEvidence logic stays in
// Node; this worker just lends it the browser's authenticated network stack.
//
// The continuous long-poll keeps this service worker alive; a 1-minute alarm
// restarts the loop if the worker was ever evicted.

// Injected by the build (esbuild `define`) so it matches OE_MCP_RELAY_PORT.
declare const __RELAY_PORT__: number;

const RELAY_BASE = `http://127.0.0.1:${__RELAY_PORT__}`;
const OE_BASE = "https://www.openevidence.com";
const RELAY_CLIENT_KEY = "oeRelayClientCapabilityV2";
let relayHeadersPromise: Promise<Record<string, string>> | null = null;

function getRelayHeaders(): Promise<Record<string, string>> {
  if (!relayHeadersPromise) {
    const created = (async (): Promise<Record<string, string>> => {
      const stored = await chrome.storage.local.get(RELAY_CLIENT_KEY);
      const existing = stored[RELAY_CLIENT_KEY];
      let capability: string;
      if (
        typeof existing === "string" &&
        /^extension-v2:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          existing,
        )
      ) {
        capability = existing;
      } else {
        capability = `extension-v2:${crypto.randomUUID()}`;
        await chrome.storage.local.set({ [RELAY_CLIENT_KEY]: capability });
      }
      return { "x-openevidence-relay-client": capability };
    })();
    relayHeadersPromise = created;
    void created.catch(() => {
      relayHeadersPromise = null;
    });
  }
  return relayHeadersPromise;
}
// Park the relay tab on the lightest possible same-origin document, NOT the
// full SPA. `/robots.txt` is text/plain: it carries the openevidence.com origin,
// cookies, and TLS that DataDome checks (a POST /api/article from it returns 201,
// verified), while loading ZERO app scripts. This saves ~100 MB of browser RAM
// versus parking at `/` and — just as importantly — fires ZERO background
// requests at OpenEvidence, where the SPA would otherwise poll telemetry/data
// endpoints and silently eat into the account's rate-limit budget.
// `chrome.scripting.executeScript` injects into text/plain fine (isolated-world
// injection verified against this page).
const OE_PARK_PATH = "/robots.txt";
const OE_PARK_URL = `${OE_BASE}${OE_PARK_PATH}`;
const OE_TAB_KEY = "oeRelayTabId";

// Bounded activity feed the status page renders live. Kept in storage.local so
// it survives service-worker eviction and shows recent history on open.
const ACTIVITY_KEY = "oeRelayActivity";
const ACTIVITY_MAX = 60;

let polling = false;
let inFlight = 0;

interface RelayRequest {
  method: string;
  path: string;
  body?: string;
  deadlineAt?: number;
}

interface InTabResult {
  status: number;
  body: string;
  headers?: Record<string, string>;
  error?: string;
}

interface ActivityEvent {
  reqId: string;
  key: string; // method + path, used to collapse repeated polls into one row
  t: number; // last-updated time (ms epoch)
  phase: "start" | "done";
  icon: string;
  label: string;
  count?: number; // how many times this collapsed row fired (poll bursts)
  status?: number;
  ms?: number; // duration once done
  ok?: boolean;
}

// ---- toolbar badge ------------------------------------------------------------

type BadgeState = "off" | "ok" | "busy" | "err";

// A one-glance connection light on the toolbar icon, so you don't have to open
// the status page to know the relay is alive. Green = connected & idle, blue =
// a request is in flight, grey = relay not reachable.
function setBadge(state: BadgeState): void {
  const color = { off: "#9ca3af", ok: "#16a34a", busy: "#2563eb", err: "#dc2626" }[state];
  const title = {
    off: "OpenEvidence MCP Relay — relay not reachable",
    ok: "OpenEvidence MCP Relay — connected",
    busy: "OpenEvidence MCP Relay — request in flight",
    err: "OpenEvidence MCP Relay — last request failed",
  }[state];
  try {
    void chrome.action.setBadgeText({ text: "●" });
    void chrome.action.setBadgeBackgroundColor({ color });
    void chrome.action.setTitle({ title });
  } catch {
    /* action API can be momentarily unavailable during teardown */
  }
}

// ---- activity feed ------------------------------------------------------------

// Turn a raw relayed request into a human line for the status page — "Asked a
// question" beats "POST /api/article".
function describeRequest(req: RelayRequest): { icon: string; label: string } {
  const path = req.path.split("?")[0];
  const m = req.method.toUpperCase();
  if (m === "POST" && /\/api\/article\/?$/.test(path)) return { icon: "🔍", label: "Asked a question" };
  if (m === "GET" && /\/api\/article\/list/.test(path)) return { icon: "📚", label: "Listed history" };
  if (m === "GET" && /\/api\/article\/[0-9a-f-]{8,}/i.test(path)) return { icon: "📄", label: "Fetched answer" };
  if (/\/api\/auth\/me/.test(path)) return { icon: "🔑", label: "Checked login" };
  if (/\/api\/collection/i.test(path)) return { icon: "🗂️", label: `Collections (${m})` };
  return { icon: "•", label: `${m} ${path.replace("/api/", "")}` };
}

// Writes are chained so overlapping requests never clobber each other's
// read-modify-write of the single storage.local array.
let activityChain: Promise<void> = Promise.resolve();
function writeActivity(mutate: (log: ActivityEvent[]) => void): void {
  activityChain = activityChain
    .then(async () => {
      const store = await chrome.storage.local.get(ACTIVITY_KEY);
      const log: ActivityEvent[] = Array.isArray(store[ACTIVITY_KEY])
        ? (store[ACTIVITY_KEY] as ActivityEvent[])
        : [];
      mutate(log);
      await chrome.storage.local.set({ [ACTIVITY_KEY]: log });
    })
    .catch(() => {});
}

function activityStart(reqId: string, req: RelayRequest): void {
  const { icon, label } = describeRequest(req);
  const key = `${req.method.toUpperCase()} ${req.path.split("?")[0]}`;
  writeActivity((log) => {
    const last = log[log.length - 1];
    // Collapse a burst of identical requests (e.g. the MCP server polling one
    // article id until it finishes) into a single row that bumps a counter,
    // instead of flooding the feed.
    if (last && last.key === key && Date.now() - last.t < 30_000) {
      last.count = (last.count ?? 1) + 1;
      last.t = Date.now();
      last.phase = "start";
      last.reqId = reqId;
    } else {
      log.push({ reqId, key, t: Date.now(), phase: "start", icon, label, count: 1 });
      while (log.length > ACTIVITY_MAX) log.shift();
    }
  });
}

function activityDone(reqId: string, status: number, ms: number): void {
  writeActivity((log) => {
    for (let i = log.length - 1; i >= 0; i -= 1) {
      if (log[i].reqId === reqId) {
        log[i].phase = "done";
        log[i].status = status;
        log[i].ms = ms;
        log[i].ok = status >= 200 && status < 400;
        return;
      }
    }
  });
}

// ---- dedicated tab management -------------------------------------------------

async function getStoredTabId(): Promise<number | undefined> {
  const o = await chrome.storage.session.get(OE_TAB_KEY);
  return o[OE_TAB_KEY] as number | undefined;
}

async function setStoredTabId(id: number): Promise<void> {
  await chrome.storage.session.set({ [OE_TAB_KEY]: id });
}

async function clearStoredTabId(): Promise<void> {
  await chrome.storage.session.remove(OE_TAB_KEY);
}

async function waitForTabComplete(tabId: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === "complete" && (t.url ?? "").startsWith(OE_BASE)) return;
    if (Date.now() > deadline) throw new Error("dedicated OE tab did not finish loading in time");
    await new Promise((r) => setTimeout(r, 400));
  }
}

// Returns the id of a dedicated, logged-in OpenEvidence tab, creating a pinned
// background one if needed. Tracked by tab id (not URL), so it never collides
// with an OpenEvidence tab you opened yourself.
async function ensureOeTab(timeoutMs = 30_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  const remaining = (): number => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error("relay request deadline expired while preparing the OE tab");
    return Math.min(30_000, ms);
  };
  const stored = await getStoredTabId();
  if (stored != null) {
    try {
      const t = await chrome.tabs.get(stored);
      // Any openevidence.com page keeps the origin/cookies we need, so an
      // already-parked tab is reused verbatim — no re-navigation, no extra
      // request at OpenEvidence.
      if ((t.url ?? "").startsWith(OE_BASE)) {
        // Chrome may discard a background tab under memory pressure: it still
        // exists (id valid) but its document is gone, so executeScript would
        // fail. Reload it back to life before handing it out.
        if (t.discarded) {
          await chrome.tabs.reload(stored);
          await waitForTabComplete(stored, remaining());
        }
        return stored;
      }
      await chrome.tabs.update(stored, { url: OE_PARK_URL });
      await waitForTabComplete(stored, remaining());
      return stored;
    } catch {
      // tab was closed; adopt or create a fresh one below.
    }
  }
  // storage.session is wiped on browser restart but Chrome restores pinned tabs,
  // so our previous parked tab survives as an untracked orphan. Adopt it instead
  // of creating a sibling — otherwise every restart adds one more pinned tab.
  // Match our own parked tabs only: pinned, and parked at either the current
  // light URL or the legacy root `/` (older builds parked there) — never a
  // user's own pinned /ask/ tab.
  const pinnedOe = await chrome.tabs.query({ url: `${OE_BASE}/*`, pinned: true });
  const orphans = pinnedOe.filter((t) => {
    const path = urlPath(t.url);
    return path === OE_PARK_PATH || path === "/";
  });
  const adopted = orphans[0]?.id;
  if (adopted != null) {
    for (const extra of orphans.slice(1)) {
      if (extra.id != null) await chrome.tabs.remove(extra.id).catch(() => {});
    }
    await setStoredTabId(adopted);
    // A legacy orphan sitting on the heavy `/` SPA is retired onto the light
    // park page so we stop paying its RAM + background-request cost.
    if (urlPath(orphans[0]?.url) !== OE_PARK_PATH) {
      await chrome.tabs.update(adopted, { url: OE_PARK_URL });
    }
    await waitForTabComplete(adopted, remaining());
    return adopted;
  }
  const created = await chrome.tabs.create({ url: OE_PARK_URL, pinned: true, active: false });
  const id = created.id;
  if (id == null) throw new Error("failed to create OE tab");
  await setStoredTabId(id);
  await waitForTabComplete(id, remaining());
  return id;
}

function urlPath(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

// ---- the in-tab fetch ---------------------------------------------------------

// Serialized and run INSIDE the OpenEvidence tab — keep it self-contained.
async function inTabProxy(req: RelayRequest): Promise<InTabResult> {
  const deadlineAt = req.deadlineAt ?? Date.now() + 90_000;
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    return { status: 0, body: "", error: "relay request deadline expired before fetch" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  const init: RequestInit = {
    method: req.method,
    credentials: "include",
    signal: controller.signal,
  };
  if (req.body != null) {
    init.body = req.body;
    init.headers = { "content-type": "application/json" };
  }
  try {
    const r = await fetch(req.path, init);
    const reader = r.body?.getReader();
    const decoder = new TextDecoder();
    let body = "";
    let bytes = 0;
    if (reader) {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 4_000_000) {
          controller.abort();
          throw new Error("upstream response exceeds 4000000 bytes");
        }
        body += decoder.decode(chunk.value, { stream: true });
      }
      body += decoder.decode();
    }
    const headers: Record<string, string> = {};
    for (const name of [
      "content-type",
      "retry-after",
      "x-datadome",
      "x-dd-b",
      "x-ratelimit-limit",
      "x-ratelimit-remaining",
      "x-ratelimit-reset",
    ]) {
      const value = r.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    return { status: r.status, body, headers };
  } catch (e) {
    return { status: 0, body: "", error: String(e) };
  } finally {
    clearTimeout(timer);
  }
}

async function injectFetch(req: RelayRequest): Promise<InTabResult | undefined> {
  const deadlineAt = req.deadlineAt ?? Date.now() + 90_000;
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new Error("relay request deadline expired before injection");
  const tabId = await ensureOeTab(remaining);
  if (Date.now() >= deadlineAt) throw new Error("relay request deadline expired before injection");
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: inTabProxy,
    args: [req],
  });
  return injection?.result as InTabResult | undefined;
}

async function runProxy(req: RelayRequest): Promise<InTabResult> {
  let out: InTabResult | undefined;
  try {
    out = await injectFetch(req);
  } catch {
    // executeScript itself threw — the parked tab was discarded or died between
    // ensure and inject. Safe reads may rebuild the tab and retry once. Writes
    // are never replayed because an executeScript failure can have an ambiguous
    // outcome. (A genuine fetch failure surfaces as out.error below.)
    const method = req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      throw new Error(
        `in-tab ${method} outcome is unknown after injection failure; not retried to avoid a duplicate write`,
      );
    }
    await clearStoredTabId();
    out = await injectFetch(req);
  }
  if (!out) throw new Error("no result from in-tab fetch");
  if (out.error) throw new Error(out.error);
  return out; // pass status/body through verbatim; Node decides on 4xx/5xx
}

// ---- relay loop ---------------------------------------------------------------

async function postResult(payload: {
  reqId: string;
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  error?: string;
}, deadlineAt?: number): Promise<void> {
  let body = JSON.stringify(payload);
  if (new TextEncoder().encode(body).byteLength > 4_000_000) {
    body = JSON.stringify({
      reqId: payload.reqId,
      error: "serialized relay result exceeds 4000000 bytes",
    });
  }
  const remaining = (deadlineAt ?? Date.now() + 10_000) - Date.now();
  if (remaining <= 0) throw new Error("relay request deadline expired before result acknowledgement");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  try {
    const res = await fetch(`${RELAY_BASE}/result`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(await getRelayHeaders()) },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`relay rejected result (${res.status}): ${detail.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function handleRequest(reqId: string, req: RelayRequest): Promise<void> {
  const startedAt = Date.now();
  activityStart(reqId, req);
  inFlight += 1;
  setBadge("busy");
  let acknowledged = false;
  try {
    let result: InTabResult;
    try {
      result = await runProxy(req);
    } catch (e) {
      result = { status: 0, body: "", error: e instanceof Error ? e.message : String(e) };
    }
    if (result.error) {
      await postResult({ reqId, error: result.error }, req.deadlineAt);
      activityDone(reqId, 0, Date.now() - startedAt);
    } else {
      await postResult(
        { reqId, status: result.status, body: result.body, headers: result.headers },
        req.deadlineAt,
      );
      activityDone(reqId, result.status, Date.now() - startedAt);
    }
    acknowledged = true;
  } catch (e) {
    setBadge("err");
    throw e;
  } finally {
    inFlight = Math.max(0, inFlight - 1);
    if (inFlight === 0 && acknowledged) setBadge("ok");
  }
}

async function pollOnce(): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);
  try {
    const res = await fetch(`${RELAY_BASE}/poll`, {
      method: "GET",
      headers: await getRelayHeaders(),
      signal: controller.signal,
    });
    if (res.status === 200) {
      const { reqId, req } = (await res.json()) as { reqId: string; req: RelayRequest };
      await handleRequest(reqId, req);
      return;
    }
    if (res.status === 204) return;
    const detail = await res.text().catch(() => "");
    throw new Error(`relay poll rejected (${res.status}): ${detail.slice(0, 200)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function pollLoop(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      try {
        await pollOnce();
        // A returned poll (200 delivered a request, or 204 held-then-timed-out)
        // both mean the relay is reachable. Reflect "connected & idle" unless a
        // request is mid-flight (handleRequest owns the badge then).
        if (inFlight === 0) setBadge("ok");
      } catch {
        setBadge("off"); // relay daemon unreachable
        await new Promise((r) => setTimeout(r, 2000)); // relay not up yet / transient
      }
    }
  } finally {
    polling = false;
  }
}

// Open the bundled how-it-works page (its own extension tab).
function openReadme(): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL("README.html") });
}

// Clicking the toolbar icon explains how the relay works.
chrome.action.onClicked.addListener(() => openReadme());

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "oe-relay-client-headers") return false;
  void getRelayHeaders().then(sendResponse);
  return true;
});

chrome.runtime.onStartup.addListener(() => void pollLoop());
chrome.runtime.onInstalled.addListener((details) => {
  void pollLoop();
  // Show the guide once, the first time the extension is installed.
  if (details.reason === "install") openReadme();
});
chrome.alarms.create("oe-relay-keepalive", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "oe-relay-keepalive") void pollLoop();
});

// Start greyed-out; the first successful poll flips it green.
setBadge("off");
void pollLoop();
