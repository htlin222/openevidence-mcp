import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * In-process relay between the MCP server and a Brave/Chrome extension.
 *
 * The extension long-polls `GET /poll`; when the MCP server issues a request we
 * hand it `{method, path, body}`, the extension runs that `fetch` *inside* a
 * parked OpenEvidence tab (page-context Origin/Referer/cookies/TLS ⇒ DataDome
 * passes), then posts the `{status, body}` back to `POST /result`. The extension
 * is a narrowly-scoped authenticated fetch bridge — all OpenEvidence logic
 * stays in Node and only the API routes used by this project are accepted.
 *
 * The long-poll doubles as a keepalive for the MV3 service worker. Localhost-only,
 * single-client. No WebSocket dependency — a held HTTP response is the one push.
 */

const POLL_HOLD_MS = 25_000; // how long a /poll request is held before a 204
const CONNECTED_SLACK_MS = 8_000; // grace beyond POLL_HOLD before we call it gone
const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_BODY_BYTES = 4_000_000;
const MAX_UPSTREAM_REQUEST_BODY_BYTES = 256_000;
const MAX_PENDING_REQUESTS = 32;
const MAX_POLL_WAITERS = 1;
const MAX_RELAY_TIMEOUT_MS = 10 * 60_000;

/**
 * Browser pages can reach loopback addresses. The extension sends a random,
 * per-install capability in this non-simple header. The daemon leases itself to
 * the first live installation, preventing other browser profiles from sharing
 * one logical OpenEvidence session. Same-user local processes remain inside the
 * host trust boundary, but cannot impersonate an extension endpoint by omitting
 * Origin.
 */
export const RELAY_EXTENSION_HEADER = "x-openevidence-relay-client";
/** Deterministic valid capability used only by protocol tests and fake clients. */
export const RELAY_EXTENSION_HEADER_VALUE =
  "extension-v2:00000000-0000-4000-8000-000000000001";
const RELAY_EXTENSION_CAPABILITY =
  /^extension-v2:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// Chrome explicitly recommends constraining resources reachable through a
// privileged extension bridge instead of accepting caller-provided URLs:
// https://developer.chrome.com/docs/extensions/develop/concepts/network-requests#limit-content-script-access-to-cross-origin-requests
const ALLOWED_RELAY_ROUTES: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: "GET", path: /^\/api\/auth\/me$/ },
  { method: "GET", path: /^\/api\/article\/list(?:\?[^#]*)?$/ },
  { method: "GET", path: new RegExp(`^/api/article/${UUID}$`, "i") },
  { method: "GET", path: /^\/api\/collections\/collections$/ },
  { method: "GET", path: new RegExp(`^/api/collections/collections/${UUID}$`, "i") },
  { method: "GET", path: new RegExp(`^/ask/${UUID}$`, "i") },
  { method: "POST", path: /^\/api\/article$/ },
  { method: "POST", path: /^\/api\/collections\/collections$/ },
  {
    method: "POST",
    path: new RegExp(`^/api/collections/collections/${UUID}/add_article$`, "i"),
  },
];

/**
 * Protocol version of the daemon-facing surface (`POST /relay`, `/health` shape).
 * Bump whenever the client↔daemon contract changes so a stale daemon from an
 * older build is detected and respawned instead of serving an incompatible API.
 */
export const RELAY_VERSION = 2;

/** A request for the extension to run inside the OpenEvidence tab. */
export interface RelayRequest {
  method: string;
  path: string;
  /** Pre-serialized request body (JSON string), or undefined for GET/HEAD. */
  body?: string;
}

/** The raw response the extension read from the in-tab fetch. */
export interface RelayResponse {
  status: number;
  body: string;
  /** Small allowlisted subset used for throttling and challenge diagnostics. */
  headers?: Record<string, string>;
}

interface PendingReq {
  reqId: string;
  req: RelayRequest;
  resolve: (value: RelayResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Installation capability that received this request. */
  clientId?: string;
  deadlineAt: number;
}

interface Waiter {
  req: IncomingMessage;
  res: ServerResponse;
  timer: ReturnType<typeof setTimeout>;
  clientId: string;
}

interface ExtensionIdentity {
  origin: string;
  clientId: string;
  leaseId: string;
}

export interface RelayServer {
  readonly port: number;
  /** True while the extension is actively long-polling (recently seen). */
  isConnected(): boolean;
  /** Number of requests currently awaiting an extension response. */
  pending(): number;
  /** Run a request through the extension; resolves with its raw {status, body}. */
  request(req: RelayRequest, opts?: { timeoutMs?: number }): Promise<RelayResponse>;
  close(): void;
}

export interface RelayServerOptions {
  port: number;
  host?: string;
  now?: () => number;
  logger?: (message: string) => void;
}

export function startRelayServer(options: RelayServerOptions): Promise<RelayServer> {
  const host = options.host ?? "127.0.0.1";
  const now = options.now ?? (() => Date.now());
  const log = options.logger ?? (() => {});

  const pending = new Map<string, PendingReq>();
  const outbox: PendingReq[] = [];
  const waiters: Waiter[] = [];
  let lastPollAt = 0;
  let activeExtension: ExtensionIdentity | null = null;
  let closed = false;
  // Live stats surfaced on /health so the extension's status page can show what
  // the relay is actually doing, not just that it exists. Additive fields only —
  // the client contract (connected/version/pid) is unchanged.
  const startedAt = now();
  let served = 0;
  let errored = 0;
  let lastActivityAt = 0;

  const extensionOrigin = (req: IncomingMessage): string | null => {
    const raw = req.headers.origin;
    const origin = Array.isArray(raw) ? raw[0] : raw;
    return origin && /^chrome-extension:\/\/[a-p]{32}$/i.test(origin) ? origin : null;
  };

  const extensionIdentity = (
    req: IncomingMessage,
  ): Omit<ExtensionIdentity, "leaseId"> | null => {
    const origin = extensionOrigin(req);
    if (!origin) return null;
    const marker = req.headers[RELAY_EXTENSION_HEADER];
    const clientId = Array.isArray(marker) ? marker[0] : marker;
    if (typeof clientId !== "string" || !RELAY_EXTENSION_CAPABILITY.test(clientId)) return null;
    return { origin, clientId };
  };

  const acceptExtension = (
    req: IncomingMessage,
    allowLease: boolean,
  ): ExtensionIdentity | null => {
    const identity = extensionIdentity(req);
    if (!identity) return null;
    if (
      activeExtension &&
      activeExtension.origin === identity.origin &&
      activeExtension.clientId === identity.clientId
    ) {
      return activeExtension;
    }
    const leaseExpired = now() - lastPollAt >= POLL_HOLD_MS + CONNECTED_SLACK_MS;
    if (allowLease && (!activeExtension || (leaseExpired && pending.size === 0))) {
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        sendJson(waiter.req, waiter.res, 409, {
          ok: false,
          error: "extension lease replaced",
        });
      }
      activeExtension = { ...identity, leaseId: randomUUID() };
      return activeExtension;
    }
    return null;
  };

  const isActiveExtension = (identity: Omit<ExtensionIdentity, "leaseId">): boolean =>
    activeExtension === null ||
    (activeExtension.origin === identity.origin &&
      activeExtension.clientId === identity.clientId);

  const isExtensionPreflight = (req: IncomingMessage): boolean => {
    const raw = req.headers["access-control-request-headers"];
    const requested = (Array.isArray(raw) ? raw.join(",") : raw ?? "")
      .toLowerCase()
      .split(",")
      .map((value) => value.trim());
    return requested.includes(RELAY_EXTENSION_HEADER);
  };

  const hasUntrustedBrowserOrigin = (req: IncomingMessage): boolean => {
    const raw = req.headers.origin;
    if (raw === undefined) return false;
    return extensionOrigin(req) === null;
  };

  const cors = (req: IncomingMessage, res: ServerResponse): void => {
    const origin = extensionOrigin(req);
    if (!origin) return;
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "Origin");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader(
      "access-control-allow-headers",
      `content-type, ${RELAY_EXTENSION_HEADER}`,
    );
  };

  const sendJson = (
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    body: unknown,
  ): void => {
    cors(req, res);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const deliver = (
    req: IncomingMessage,
    res: ServerResponse,
    p: PendingReq,
    clientId: string,
  ): void => {
    p.clientId = clientId;
    sendJson(req, res, 200, {
      reqId: p.reqId,
      req: { ...p.req, deadlineAt: p.deadlineAt },
    });
    log(`relay: delivered ${p.req.method} ${p.req.path} (${p.reqId})`);
  };

  // Deliver queued requests to waiting long-polls, while both exist.
  const flush = (): void => {
    while (waiters.length > 0 && outbox.length > 0) {
      const p = outbox.shift();
      if (!p) break;
      if (!pending.has(p.reqId)) continue; // already timed out
      const waiter = waiters.shift();
      if (!waiter) {
        outbox.unshift(p);
        break;
      }
      clearTimeout(waiter.timer);
      deliver(waiter.req, waiter.res, p, waiter.clientId);
    }
  };

  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error("request body too large"));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });

  const server: Server = createServer((req, res) => {
    const rawUrl = req.url ?? "/";
    let pathname: string;
    try {
      pathname = new URL(rawUrl, "http://127.0.0.1").pathname;
    } catch {
      sendJson(req, res, 400, { ok: false, error: "invalid request URL" });
      return;
    }
    const method = req.method ?? "GET";

    // A normal web page must never be able to consume requests from /poll,
    // forge /result, or borrow the logged-in OpenEvidence tab via /relay.
    if (hasUntrustedBrowserOrigin(req)) {
      sendJson(req, res, 403, { ok: false, error: "browser origin not allowed" });
      return;
    }

    if (method === "OPTIONS") {
      if (!extensionOrigin(req) || !isExtensionPreflight(req)) {
        sendJson(req, res, 403, { ok: false, error: "extension channel required" });
        return;
      }
      cors(req, res);
      res.writeHead(204);
      res.end();
      return;
    }

    if (method === "GET" && pathname === "/poll") {
      const extension = acceptExtension(req, true);
      if (!extension) {
        sendJson(req, res, 403, { ok: false, error: "paired extension channel required" });
        return;
      }
      lastPollAt = now();
      const p = outbox.find((x) => pending.has(x.reqId));
      if (p) {
        outbox.splice(outbox.indexOf(p), 1);
        deliver(req, res, p, extension.clientId);
        return;
      }
      if (waiters.length >= MAX_POLL_WAITERS) {
        sendJson(req, res, 503, { ok: false, error: "too many relay pollers" });
        return;
      }
      const timer = setTimeout(() => {
        const i = waiters.findIndex((w) => w.res === res);
        if (i >= 0) waiters.splice(i, 1);
        sendJson(req, res, 204, {});
      }, POLL_HOLD_MS);
      waiters.push({ req, res, timer, clientId: extension.clientId });
      res.on("close", () => {
        clearTimeout(timer);
        const i = waiters.findIndex((w) => w.res === res);
        if (i >= 0) waiters.splice(i, 1);
      });
      return;
    }

    if (method === "GET" && pathname === "/health") {
      // Node/curl callers have no Origin. Extension pages must identify the
      // extension channel; ordinary browser origins were rejected above.
      if (req.headers.origin !== undefined) {
        const identity = extensionIdentity(req);
        if (!identity || !isActiveExtension(identity)) {
          sendJson(req, res, 403, { ok: false, error: "paired extension channel required" });
          return;
        }
      }
      sendJson(req, res, 200, {
        ok: true,
        connected: isConnected(),
        pending: pending.size,
        version: RELAY_VERSION,
        pid: process.pid,
        startedAt,
        served,
        errored,
        lastActivityAt,
        leaseId: activeExtension?.leaseId ?? null,
      });
      return;
    }

    // Daemon-facing bridge: an out-of-process MCP server submits a request here
    // and we run it through the extension on its behalf. Mirrors the in-process
    // `request()` so a remote RelayClient is indistinguishable from a local host.
    if (method === "POST" && pathname === "/relay") {
      if (req.headers.origin !== undefined) {
        sendJson(req, res, 403, { ok: false, error: "daemon channel required" });
        return;
      }
      readBody(req)
        .then(async (raw) => {
          const data = JSON.parse(raw) as {
            method?: string;
            path?: string;
            body?: string;
            timeoutMs?: number;
            expectedLeaseId?: string;
          };
          if (!data.path || !data.method) {
            sendJson(req, res, 400, { ok: false, error: "method and path are required" });
            return;
          }
          const validationError = validateRelayRequest(data);
          if (validationError) {
            sendJson(req, res, 400, { ok: false, error: validationError });
            return;
          }
          if (
            data.expectedLeaseId !== undefined &&
            typeof data.expectedLeaseId !== "string"
          ) {
            sendJson(req, res, 400, { ok: false, error: "expectedLeaseId must be a string" });
            return;
          }
          if (
            typeof data.expectedLeaseId === "string" &&
            data.expectedLeaseId !== activeExtension?.leaseId
          ) {
            sendJson(req, res, 409, { ok: false, error: "extension lease changed" });
            return;
          }
          try {
            const result = await request(
              { method: data.method, path: data.path, body: data.body },
              { timeoutMs: data.timeoutMs },
            );
            sendJson(req, res, 200, {
              ok: true,
              status: result.status,
              body: result.body,
              headers: result.headers,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            // 504 when the extension never answered, 502 for everything else.
            const code = /did not respond within/.test(message) ? 504 : 502;
            sendJson(req, res, code, { ok: false, error: message });
          }
        })
        .catch((err: unknown) => sendJson(req, res, 400, { ok: false, error: String(err) }));
      return;
    }

    if (method === "POST" && pathname === "/result") {
      const extension = acceptExtension(req, false);
      if (!extension) {
        sendJson(req, res, 403, { ok: false, error: "paired extension channel required" });
        return;
      }
      readBody(req)
        .then((raw) => {
          const data = JSON.parse(raw) as {
            reqId?: string;
            status?: number;
            body?: string;
            error?: string;
            headers?: Record<string, unknown>;
          };
          const p = data.reqId ? pending.get(data.reqId) : undefined;
          if (!p) {
            sendJson(req, res, 404, { ok: false, error: "unknown reqId" });
            return;
          }
          if (p.clientId !== extension.clientId) {
            sendJson(req, res, 403, { ok: false, error: "request belongs to another extension" });
            return;
          }
          const validError =
            typeof data.error === "string" &&
            data.error.trim().length > 0 &&
            data.status === undefined &&
            data.body === undefined;
          const validResponse =
            data.error === undefined &&
            Number.isInteger(data.status) &&
            data.status! >= 200 &&
            data.status! <= 599 &&
            typeof data.body === "string";
          if (!validError && !validResponse) {
            clearTimeout(p.timer);
            pending.delete(p.reqId);
            errored += 1;
            p.reject(new Error("extension: malformed result payload"));
            sendJson(req, res, 400, { ok: false, error: "malformed result payload" });
            return;
          }
          clearTimeout(p.timer);
          pending.delete(p.reqId);
          // A completed request is proof that the leased installation is still
          // alive; renew the lease so another profile cannot seize the tiny gap
          // before this extension opens its next long-poll.
          lastPollAt = now();
          lastActivityAt = now();
          if (validError) {
            errored += 1;
            p.reject(new Error(`extension: ${data.error}`));
          } else {
            served += 1;
            p.resolve({
              status: data.status!,
              body: data.body ?? "",
              headers: normalizeResponseHeaders(data.headers),
            });
          }
          sendJson(req, res, 200, { ok: true });
        })
        .catch((err: unknown) => sendJson(req, res, 400, { ok: false, error: String(err) }));
      return;
    }

    sendJson(req, res, 404, { ok: false, error: "not found" });
  });

  function isConnected(): boolean {
    return activeExtension !== null && now() - lastPollAt < POLL_HOLD_MS + CONNECTED_SLACK_MS;
  }

  function request(req: RelayRequest, opts?: { timeoutMs?: number }): Promise<RelayResponse> {
    if (closed) return Promise.reject(new Error("relay server closed"));
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const validationError = validateRelayRequest({ ...req, timeoutMs });
    if (validationError) return Promise.reject(new Error(`relay: ${validationError}`));
    if (pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new Error("relay: too many pending requests"));
    }
    lastActivityAt = now();
    const reqId = `req-${randomUUID()}`;
    return new Promise<RelayResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(reqId);
        const i = outbox.findIndex((x) => x.reqId === reqId);
        if (i >= 0) outbox.splice(i, 1);
        errored += 1;
        lastActivityAt = now();
        reject(new Error(`relay: extension did not respond within ${timeoutMs}ms`));
      }, timeoutMs);
      const p: PendingReq = { reqId, req, resolve, reject, timer, deadlineAt: now() + timeoutMs };
      pending.set(reqId, p);
      outbox.push(p);
      flush();
    });
  }

  return new Promise<RelayServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => {
      server.removeListener("error", reject);
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : options.port;
      log(`relay: listening on http://${host}:${boundPort}`);
      resolve({
        port: boundPort,
        isConnected,
        pending: () => pending.size,
        request,
        close: () => {
          if (closed) return;
          closed = true;
          for (const w of waiters) {
            clearTimeout(w.timer);
            if (!w.res.writableEnded) {
              sendJson(w.req, w.res, 503, { ok: false, error: "relay server closed" });
            }
          }
          for (const p of pending.values()) {
            clearTimeout(p.timer);
            p.reject(new Error("relay server closed"));
          }
          waiters.length = 0;
          pending.clear();
          outbox.length = 0;
          server.close();
        },
      });
    });
  });
}

function validateRelayRequest(req: {
  method?: string;
  path?: string;
  body?: string;
  timeoutMs?: number;
}): string | null {
  const method = req.method?.toUpperCase();
  const path = req.path;
  if (!method || !path) return "method and path are required";
  if (req.method !== method) return "method must be uppercase";
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.includes("#")) {
    return "path must be a same-origin absolute path";
  }
  if (!ALLOWED_RELAY_ROUTES.some((route) => route.method === method && route.path.test(path))) {
    return `relay route not allowed: ${method} ${path}`;
  }
  if ((method === "GET" || method === "HEAD") && req.body !== undefined) {
    return `${method} requests must not include a body`;
  }
  if (
    req.body !== undefined &&
    (typeof req.body !== "string" || Buffer.byteLength(req.body, "utf8") > MAX_UPSTREAM_REQUEST_BODY_BYTES)
  ) {
    return `body must be a string no larger than ${MAX_UPSTREAM_REQUEST_BODY_BYTES} bytes`;
  }
  if (req.timeoutMs !== undefined) {
    if (!Number.isFinite(req.timeoutMs) || req.timeoutMs < 1 || req.timeoutMs > MAX_RELAY_TIMEOUT_MS) {
      return `timeoutMs must be between 1 and ${MAX_RELAY_TIMEOUT_MS}`;
    }
  }
  return null;
}

const RELAY_RESPONSE_HEADERS = new Set([
  "content-type",
  "retry-after",
  "x-datadome",
  "x-dd-b",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
]);

function normalizeResponseHeaders(
  input: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const output: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(input)) {
    const name = rawName.toLowerCase();
    if (RELAY_RESPONSE_HEADERS.has(name) && typeof value === "string") output[name] = value;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}
