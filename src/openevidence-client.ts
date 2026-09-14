import { access } from "node:fs/promises";
import { constants } from "node:fs";

import type { AppConfig } from "./config.js";
import { CookieJar } from "./cookies.js";
import {
  DEFAULT_BROWSER_FINGERPRINT,
  loadBrowserFingerprint,
  type BrowserFingerprint,
  type HeaderTuple,
} from "./fingerprint.js";
import {
  HttpError,
  RateLimitController,
  isRetryableStatus,
  parseRetryAfterMs,
  withExponentialBackoff,
  type ClinicalPriority,
  type HeaderLike,
  type RateLimitConfig,
  type RateLimitMetrics,
} from "./rate-limit.js";
import type {
  ArticleAccessLevel,
  AuthStatusResult,
  OpenEvidenceAskRequest,
  WaitOptions,
} from "./types.js";

const DEFAULT_ARTICLE_TYPE = "Ask OpenEvidence Light with citations";
const PENDING_STATUSES = new Set(["queued", "pending", "processing", "running", "in_progress"]);

export interface RelayTransport {
  isConnected(): boolean;
  request(req: {
    method: string;
    path: string;
    body?: string;
  }): Promise<{ status: number; body: string; headers?: Record<string, string> }>;
}

export class OpenEvidenceClient {
  private cookieJar: CookieJar | null = null;
  private fingerprint: BrowserFingerprint = DEFAULT_BROWSER_FINGERPRINT;
  private relay: RelayTransport | null = null;
  private readonly limiter: RateLimitController;

  constructor(private readonly config: AppConfig, rateLimitConfig?: Partial<RateLimitConfig>) {
    const merged = config.rateLimit;
    this.limiter = new RateLimitController(
      rateLimitConfig ? { ...merged, ...rateLimitConfig } : merged,
    );
  }

  getRateLimitMetrics(): RateLimitMetrics {
    return this.limiter.getMetrics();
  }

  /**
   * Route all requests through a connected browser-extension relay (the browser's
   * own authenticated session) instead of Node + cookies. DataDome never sees a
   * Node request, and no cookie file is required.
   */
  useRelay(relay: RelayTransport): void {
    this.relay = relay;
  }

  async init(): Promise<void> {
    this.fingerprint = await loadBrowserFingerprint(this.config.fingerprintPath);
    // With a connected relay the browser session is the auth — no cookie file needed.
    if (this.relay?.isConnected()) return;
    await access(this.config.cookiesPath, constants.R_OK);
    this.cookieJar = await CookieJar.fromFile(this.config.cookiesPath, this.config.baseUrl);
  }

  close(): void {
    this.cookieJar = null;
  }

  async getAuthStatus(): Promise<AuthStatusResult> {
    const res = await this.requestWithRateLimit("/api/auth/me", undefined, "urgent");
    const statusCode = res.status;
    if (statusCode !== 200) {
      return {
        authenticated: false,
        statusCode,
        message: `OpenEvidence auth is not active (status ${statusCode}). Run login flow.`,
      };
    }

    const user = (await res.json()) as Record<string, unknown>;
    return {
      authenticated: true,
      statusCode,
      user,
    };
  }

  async listHistory(limit = 20, offset = 0, search?: string): Promise<unknown> {
    const query = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
    });
    if (search && search.length > 0) {
      query.set("search", search);
    }
    return this.getJson(`/api/article/list?${query.toString()}`);
  }

  async getArticle(articleId: string): Promise<Record<string, unknown>> {
    return (await this.getJson(`/api/article/${articleId}`)) as Record<string, unknown>;
  }

  async listCollections(): Promise<unknown[]> {
    const data = await this.getJson("/api/collections/collections");
    return Array.isArray(data) ? (data as unknown[]) : [];
  }

  async getCollection(collectionId: string): Promise<Record<string, unknown>> {
    return (await this.getJson(
      `/api/collections/collections/${collectionId}`,
    )) as Record<string, unknown>;
  }

  async createCollection(
    name: string,
    description?: string,
  ): Promise<Record<string, unknown>> {
    const body = { name, description: description ?? "" };
    return (await this.postJson("/api/collections/collections", body)) as Record<
      string,
      unknown
    >;
  }

  async addArticleToCollection(
    collectionId: string,
    articleId: string,
  ): Promise<Record<string, unknown>> {
    return (await this.postJson(
      `/api/collections/collections/${collectionId}/add_article`,
      { article_id: articleId },
    )) as Record<string, unknown>;
  }

  /**
   * Toggle an article's share visibility (PATCH /api/article/<id>/access).
   * `ANYONE_WITH_LINK` makes it public (anyone with the URL can read it);
   * `CREATOR_ONLY` makes it private again. The payload mirrors the live site's
   * Share dialog capture (2026-07-13). Requires the browser relay, since only
   * the owning session may change access.
   */
  async setArticleAccess(
    articleId: string,
    accessLevel: ArticleAccessLevel,
  ): Promise<Record<string, unknown>> {
    return (await this.patchJson(`/api/article/${articleId}/access`, {
      access_level: accessLevel,
      shared_with_emails: [],
    })) as Record<string, unknown>;
  }

  /**
   * Submit the ask (POST /api/article). With a connected relay (the default
   * OE_MCP_RELAY_TRANSPORT=all) this runs inside your logged-in browser tab, so it
   * clears DataDome and the created article is owned by that same session — the
   * follow-up reads can see it. Without a relay it falls back to a direct Node
   * POST, which DataDome blocks; only the cookie-path tooling (doctor/smoke) and
   * tests should ever reach that branch.
   */
  async ask(payload: OpenEvidenceAskRequest): Promise<Record<string, unknown>> {
    const body = buildAskBody(payload);

    return (await this.postJson("/api/article", body, payload.priority)) as Record<
      string,
      unknown
    >;
  }

  async waitForArticle(articleId: string, options?: WaitOptions): Promise<Record<string, unknown>> {
    const timeoutMs = options?.timeoutMs ?? this.config.pollTimeoutMs;
    const intervalMs = options?.intervalMs ?? this.config.pollIntervalMs;
    const started = Date.now();

    while (true) {
      let article: Record<string, unknown>;
      try {
        article = await this.getArticle(articleId);
      } catch (error) {
        // A just-created article 404s until OpenEvidence finishes provisioning it.
        // Treat that as "still pending" and keep polling rather than aborting the ask.
        if (
          error instanceof HttpError &&
          error.status === 404 &&
          Date.now() - started <= timeoutMs
        ) {
          await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
          continue;
        }
        throw error;
      }
      const status = String(article.status ?? "").toLowerCase();
      if (status.length > 0 && !PENDING_STATUSES.has(status)) {
        return article;
      }

      if (Date.now() - started > timeoutMs) {
        return article;
      }

      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  private api(): CookieJar {
    if (!this.cookieJar) {
      throw new Error("OpenEvidence client is not initialized.");
    }
    return this.cookieJar;
  }

  private async getJson(url: string, priority?: ClinicalPriority): Promise<unknown> {
    const res = await this.requestWithRateLimit(url, undefined, priority);
    await assertSuccessResponse(res, "GET", url);
    return res.json();
  }

  private async postJson(
    url: string,
    body: unknown,
    priority?: ClinicalPriority,
  ): Promise<unknown> {
    const res = await this.requestWithRateLimit(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      priority,
    );
    await assertSuccessResponse(res, "POST", url);
    return res.json();
  }

  private async patchJson(
    url: string,
    body: unknown,
    priority?: ClinicalPriority,
  ): Promise<unknown> {
    const res = await this.requestWithRateLimit(
      url,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      priority,
    );
    await assertSuccessResponse(res, "PATCH", url);
    return res.json();
  }

  /**
   * Self-harnessed request: the limiter throttles us before we burst, and
   * withExponentialBackoff retries 429 / 5xx while honoring Retry-After.
   * 4xx (except retryable) propagates immediately.
   */
  private async requestWithRateLimit(
    url: string,
    init: RequestInit | undefined,
    priority: ClinicalPriority = "routine",
  ): Promise<Response> {
    const method = String(init?.method ?? "GET").toUpperCase();
    const retrySafe = method === "GET" || method === "HEAD";
    return withExponentialBackoff(
      async () => {
        await this.limiter.acquire(priority);
        try {
          const res = await this.fetchWithCookies(url, init ?? {});
          this.limiter.observe({ status: res.status, headers: res.headers });
          // DataDome bot-protection serves a 403 interstitial when it flags the
          // request as automated. This is non-retryable: hammering it only makes
          // things worse, and there is no client-side bypass. Surface a clear,
          // actionable error pointing at the browser re-auth / cookie refresh.
          if (res.status === 403) {
            const snippet = await safeReadSnippet(res);
            if (isDataDomeChallenge(res, snippet)) {
              throw new DataDomeChallengeError(`${init?.method ?? "GET"} ${url}`, res.headers);
            }
          }
          if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
            const retryAfterMs =
              parseRetryAfterMs(res.headers.get("retry-after"), Date.now()) ?? undefined;
            const snippet = await safeReadSnippet(res);
            throw new HttpError(
              `${init?.method ?? "GET"} ${url} -> ${res.status} ${snippet}`,
              res.status,
              retryAfterMs,
              res.headers,
            );
          }
          return res;
        } finally {
          this.limiter.release();
        }
      },
      this.config.rateLimit.retry,
      undefined,
      undefined,
      (error) => {
        if (!retrySafe) return false;
        const status = (error as { status?: number } | undefined)?.status;
        return status === undefined || isRetryableStatus(status);
      },
    );
  }

  private fetchWithCookies(url: string, init: RequestInit = {}): Promise<Response> {
    const fullUrl = new URL(url, this.config.baseUrl);
    if (this.relay?.isConnected()) {
      return this.fetchViaRelay(fullUrl, init);
    }
    const cookie = this.api().headerFor(fullUrl.toString());
    if (!cookie) {
      throw new Error(`No cookies in ${this.config.cookiesPath} match ${fullUrl.hostname}`);
    }

    const headers = buildOpenEvidenceHeaders(fullUrl, init, cookie, this.fingerprint);

    return fetch(fullUrl, {
      ...init,
      headers,
    });
  }

  /** Run a request through the extension relay and adapt it back to a Response. */
  private async fetchViaRelay(fullUrl: URL, init: RequestInit): Promise<Response> {
    const relay = this.relay;
    if (!relay) throw new Error("relay transport not set");
    const method = String(init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? init.body : undefined;
    const { status, body: respBody, headers } = await relay.request({
      method,
      path: fullUrl.pathname + fullUrl.search,
      body,
    });
    const nullBody = status === 204 || status === 205 || status === 304;
    return new Response(nullBody ? null : respBody, {
      status,
      headers: headers ?? { "content-type": "application/json" },
    });
  }
}

/**
 * Build the `POST /api/article` request body. Shared by the Node client and the
 * browser-extension relay so both submit a byte-identical ask.
 */
export function buildAskBody(payload: OpenEvidenceAskRequest): Record<string, unknown> {
  // Field set and order mirror the live site's POST /api/article capture
  // (2026-07-13): article_type, inputs{variant_configuration_file, attachments,
  // question, use_gatekeeper, component_config_version}, original_article?,
  // personalization_enabled. The browser omits disable_caching entirely, so it
  // is only emitted when explicitly requested.
  const body: Record<string, unknown> = {
    article_type: payload.articleType ?? DEFAULT_ARTICLE_TYPE,
    inputs: {
      variant_configuration_file: payload.variantConfigurationFile ?? "prod",
      attachments: [],
      question: payload.question,
      use_gatekeeper: true,
      component_config_version: "stable",
    },
  };

  if (payload.originalArticleId) {
    body.original_article = payload.originalArticleId;
  }

  body.personalization_enabled = payload.personalizationEnabled ?? false;

  if (payload.disableCaching) {
    body.disable_caching = true;
  }

  return body;
}

export function buildOpenEvidenceHeaders(
  fullUrl: URL,
  init: RequestInit = {},
  cookie: string,
  fingerprint: BrowserFingerprint = DEFAULT_BROWSER_FINGERPRINT,
): HeaderTuple[] {
  const method = String(init.method ?? "GET").toUpperCase();
  const overrides = normalizeHeaders(init.headers);
  const extras = new Map(overrides);
  const isBodyMethod = method !== "GET" && method !== "HEAD";

  // Per-request values that take precedence over the captured snapshot.
  const dynamic = new Map<string, string>([
    ["origin", fullUrl.origin],
    ["referer", defaultRefererFor(fullUrl, method)],
  ]);

  const ordered: HeaderTuple[] = [];
  const emitted = new Set<string>();
  const emit = (name: string, value: string): void => {
    ordered.push([name, value]);
    emitted.add(name);
    extras.delete(name);
  };

  // Emit EXACTLY the captured browser's header set, in its captured order, with
  // no backfill from any other browser profile. This is what keeps a Safari
  // fingerprint free of Chromium-only client hints (sec-ch-ua*) instead of
  // sending a Safari UA alongside fabricated Chrome hints.
  for (const [name, fpValue] of fingerprint.headers) {
    if (emitted.has(name)) continue;
    if (name === "content-type" && !isBodyMethod && !overrides.has("content-type")) {
      continue; // no content-type on GET/HEAD unless the caller set one
    }
    emit(name, overrides.get(name) ?? dynamic.get(name) ?? fpValue);
  }

  // Protocol-required headers the fingerprint may not have carried.
  if (!emitted.has("origin")) emit("origin", overrides.get("origin") ?? dynamic.get("origin") ?? fullUrl.origin);
  if (!emitted.has("referer")) {
    emit("referer", overrides.get("referer") ?? dynamic.get("referer") ?? `${fullUrl.origin}/`);
  }
  if (isBodyMethod && !emitted.has("content-type")) {
    emit("content-type", overrides.get("content-type") ?? "application/json");
  }

  emit("cookie", cookie);
  ordered.push(...extras);
  return ordered;
}

function normalizeHeaders(input: HeadersInit | undefined): Map<string, string> {
  const normalized = new Map<string, string>();
  if (!input) return normalized;

  const headers = new Headers(input);
  headers.forEach((value, name) => normalized.set(name.toLowerCase(), value));
  return normalized;
}

function defaultRefererFor(fullUrl: URL, method: string): string {
  if (method === "POST" && fullUrl.pathname === "/api/article") {
    return `${fullUrl.origin}/ask`;
  }

  const articleMatch = fullUrl.pathname.match(/^\/api\/article\/([0-9a-f-]{36})(?:\/.*)?$/i);
  if (articleMatch) {
    return `${fullUrl.origin}/ask/${articleMatch[1]}`;
  }

  if (fullUrl.pathname === "/api/article/list") {
    return `${fullUrl.origin}/history`;
  }

  return `${fullUrl.origin}/`;
}

/**
 * Fetch an HTML page (e.g. /ask/<id>) over the legacy cookies.json session,
 * with the captured fingerprint headers — the same shape as the cookie read
 * path. Returns null when no usable cookie file exists, so callers can treat
 * it as an optional fallback. Throws on DataDome interstitials and on a
 * signed-out session (login redirect).
 */
export async function fetchHtmlWithCookies(
  config: AppConfig,
  path: string,
): Promise<string | null> {
  let jar: CookieJar;
  try {
    await access(config.cookiesPath, constants.R_OK);
    jar = await CookieJar.fromFile(config.cookiesPath, config.baseUrl);
  } catch {
    return null;
  }
  const fullUrl = new URL(path, config.baseUrl);
  const cookie = jar.headerFor(fullUrl.toString());
  if (!cookie) return null;

  const fingerprint = await loadBrowserFingerprint(config.fingerprintPath);
  const headers = buildOpenEvidenceHeaders(
    fullUrl,
    { headers: { accept: "text/html,application/xhtml+xml" } },
    cookie,
    fingerprint,
  );
  const res = await fetch(fullUrl, { headers, redirect: "follow" });
  if (res.status === 403) {
    const snippet = await safeReadSnippet(res);
    if (isDataDomeChallenge(res, snippet)) {
      throw new DataDomeChallengeError(`GET ${path}`, res.headers);
    }
  }
  if (!res.ok) {
    throw new HttpError(`GET ${path} over cookies returned ${res.status}`, res.status);
  }
  const finalPath = res.url ? new URL(res.url).pathname : path;
  if (/login|signin|auth/i.test(finalPath)) {
    throw new Error(
      "The cookies.json session is signed out (OpenEvidence redirected to login). " +
        "Refresh it with: npm run login",
    );
  }
  return res.text();
}

/**
 * Raised when OpenEvidence's DataDome anti-bot layer returns a challenge
 * interstitial (HTTP 403) instead of the requested resource.
 *
 * This is NOT an auth failure — the login session is unaffected. It means the
 * bot-protection scored this request as automated traffic. There is no
 * supported client-side bypass; the resolution is for a human to solve the
 * challenge in a real browser and refresh the exported cookie jar.
 */
export class DataDomeChallengeError extends HttpError {
  constructor(target: string, headers?: HeaderLike) {
    super(
      [
        `OpenEvidence returned a 403 challenge on ${target}.`,
        `Your login session is still valid, but this Node request was not accepted.`,
        `Use the browser-extension relay (which issues requests from your own`,
        `logged-in tab), or re-establish a fresh browser session and refresh cookies.json.`,
      ].join(" "),
      403,
      undefined,
      headers,
    );
    this.name = "DataDomeChallengeError";
  }
}

/** Heuristically detect a DataDome challenge from a 403 response. */
export function isDataDomeChallenge(res: Pick<Response, "headers">, bodySnippet: string): boolean {
  const h = res.headers;
  if (h.has("x-datadome") || h.has("x-dd-b")) return true;
  if (/datadome/i.test(h.get("set-cookie") ?? "")) return true;
  return /captcha-delivery\.com|datadome|"interstitial"/i.test(bodySnippet);
}

async function assertSuccessResponse(res: Response, method: string, url: string): Promise<void> {
  const status = res.status;
  if (status >= 200 && status < 300) {
    return;
  }
  const text = await res.text();
  throw new HttpError(`${method} ${url} failed with status ${status}: ${text.slice(0, 400)}`, status);
}

async function safeReadSnippet(res: Response): Promise<string> {
  try {
    const text = await res.clone().text();
    return text.slice(0, 200);
  } catch {
    return "";
  }
}

/**
 * The suggested follow-up questions OpenEvidence renders under an answer, taken
 * verbatim from `output.structured_article.follow_up_questions`. Pass any of
 * these back as `oe_ask(question, original_article_id)` to continue the thread.
 */
export function extractFollowUpQuestions(article: Record<string, unknown>): string[] {
  const output = article.output as Record<string, unknown> | undefined;
  const structuredArticle = output?.structured_article as Record<string, unknown> | undefined;
  const raw = structuredArticle?.follow_up_questions;
  if (!Array.isArray(raw)) return [];
  return raw.filter((q): q is string => typeof q === "string" && q.trim().length > 0);
}

export function extractAnswerText(article: Record<string, unknown>): string | null {
  const output = article.output as Record<string, unknown> | undefined;
  const structuredArticle = output?.structured_article as Record<string, unknown> | undefined;
  if (typeof structuredArticle?.raw_text === "string" && structuredArticle.raw_text.length > 0) {
    return structuredArticle.raw_text;
  }

  if (typeof output?.text === "string" && output.text.length > 0) {
    return stripReactComponentBlocks(output.text);
  }

  const history = article.inputs as Record<string, unknown> | undefined;
  const historyItems = Array.isArray(history?.history) ? history.history : [];
  if (historyItems.length === 0) {
    return null;
  }

  const last = historyItems[historyItems.length - 1] as Record<string, unknown>;
  const raw = typeof last.outputText === "string" ? last.outputText : null;
  if (!raw) {
    return null;
  }
  return raw;
}

function stripReactComponentBlocks(text: string): string {
  return text
    .replace(/^REACTCOMPONENT!:![\s\S]*?\n\n\n/, "")
    .replace(/REACTCOMPONENT!:![A-Za-z]+!:!\{[\s\S]*?\}\n*/g, "")
    .trim();
}

interface FigurePayload {
  url?: string;
  name?: string;
  caption?: string;
}

export interface FigureRecord {
  name: string;
  url: string;
  caption?: string;
  localPath?: string;
}

const PUBLICATION_FIGURE_RE = /REACTCOMPONENT!:!PublicationFigure!:!(\{[\s\S]*?\})\n*/g;

export function extractFiguresFromText(text: string): FigureRecord[] {
  const figures: FigureRecord[] = [];
  for (const match of text.matchAll(PUBLICATION_FIGURE_RE)) {
    try {
      const payload = JSON.parse(match[1]) as FigurePayload;
      if (typeof payload.url === "string" && payload.url.length > 0) {
        figures.push({
          name: typeof payload.name === "string" ? payload.name : "",
          url: payload.url,
          ...(typeof payload.caption === "string" && payload.caption.length > 0
            ? { caption: payload.caption }
            : {}),
        });
      }
    } catch {
      // skip malformed JSON
    }
  }
  return figures;
}

const VISUAL_TAG_RE = /<visual>([^[<]+?)(?:\[\d+\])?<\/visual>/g;

export function resolveVisualTags(text: string, figures: FigureRecord[]): string {
  if (figures.length === 0) return text;

  const lookup = new Map<string, FigureRecord>();
  for (const fig of figures) {
    if (fig.name && !lookup.has(fig.name)) {
      lookup.set(fig.name, fig);
    }
  }

  return text.replace(VISUAL_TAG_RE, (original, name: string) => {
    const fig = lookup.get(name);
    if (!fig) return original;
    const alt = fig.caption ? `${fig.name}: ${fig.caption}` : fig.name;
    return `![${alt}](${fig.url})`;
  });
}
