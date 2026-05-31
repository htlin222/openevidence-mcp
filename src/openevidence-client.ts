import { access } from "node:fs/promises";
import { constants } from "node:fs";

import type { AppConfig } from "./config.js";
import { CookieJar } from "./cookies.js";
import {
  HttpError,
  RateLimitController,
  parseRetryAfterMs,
  withExponentialBackoff,
  type ClinicalPriority,
  type HeaderLike,
  type RateLimitConfig,
  type RateLimitMetrics,
} from "./rate-limit.js";
import type { AuthStatusResult, OpenEvidenceAskRequest, WaitOptions } from "./types.js";

const DEFAULT_ARTICLE_TYPE = "Ask OpenEvidence Light with citations";
const PENDING_STATUSES = new Set(["queued", "pending", "processing", "running", "in_progress"]);

export class OpenEvidenceClient {
  private cookieJar: CookieJar | null = null;
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

  async init(): Promise<void> {
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

  async ask(payload: OpenEvidenceAskRequest): Promise<Record<string, unknown>> {
    const body: Record<string, unknown> = {
      article_type: payload.articleType ?? DEFAULT_ARTICLE_TYPE,
      inputs: {
        variant_configuration_file: payload.variantConfigurationFile ?? "prod",
        attachments: [],
        question: payload.question,
        use_gatekeeper: true,
      },
      personalization_enabled: payload.personalizationEnabled ?? false,
      disable_caching: payload.disableCaching ?? false,
    };

    if (payload.originalArticleId) {
      body.original_article = payload.originalArticleId;
    }

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
      const article = await this.getArticle(articleId);
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
    );
  }

  private fetchWithCookies(url: string, init: RequestInit = {}): Promise<Response> {
    const fullUrl = new URL(url, this.config.baseUrl);
    const cookie = this.api().headerFor(fullUrl.toString());
    if (!cookie) {
      throw new Error(`No cookies in ${this.config.cookiesPath} match ${fullUrl.hostname}`);
    }

    const headers = new Headers(init.headers);
    headers.set("cookie", cookie);
    headers.set("origin", fullUrl.origin);
    headers.set("referer", `${fullUrl.origin}/`);
    if (!headers.has("accept")) {
      headers.set("accept", "application/json, text/plain, */*");
    }
    if (!headers.has("user-agent")) {
      headers.set(
        "user-agent",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      );
    }

    return fetch(fullUrl, {
      ...init,
      headers,
    });
  }
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
        `DataDome bot-protection challenge on ${target} (HTTP 403).`,
        `Your OpenEvidence login session is still valid — the anti-bot layer flagged`,
        `this request as automated. Re-authenticate in a real browser, solve the`,
        `challenge, then refresh cookies.json. Automated bypass is not supported.`,
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
  throw new Error(`${method} ${url} failed with status ${status}: ${text.slice(0, 400)}`);
}

async function safeReadSnippet(res: Response): Promise<string> {
  try {
    const text = await res.clone().text();
    return text.slice(0, 200);
  } catch {
    return "";
  }
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
