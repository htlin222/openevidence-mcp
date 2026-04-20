import { access } from "node:fs/promises";
import { constants } from "node:fs";

import type { AppConfig } from "./config.js";
import { CookieJar } from "./cookies.js";
import type { AuthStatusResult, OpenEvidenceAskRequest, WaitOptions } from "./types.js";

const DEFAULT_ARTICLE_TYPE = "Ask OpenEvidence Light with citations";
const PENDING_STATUSES = new Set(["queued", "pending", "processing", "running", "in_progress"]);

export class OpenEvidenceClient {
  private cookieJar: CookieJar | null = null;

  constructor(private readonly config: AppConfig) {}

  async init(): Promise<void> {
    await access(this.config.cookiesPath, constants.R_OK);
    this.cookieJar = await CookieJar.fromFile(this.config.cookiesPath, this.config.baseUrl);
  }

  close(): void {
    this.cookieJar = null;
  }

  async getAuthStatus(): Promise<AuthStatusResult> {
    const res = await this.get("/api/auth/me");
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

    return (await this.postJson("/api/article", body)) as Record<string, unknown>;
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

      await sleep(intervalMs);
    }
  }

  private api(): CookieJar {
    if (!this.cookieJar) {
      throw new Error("OpenEvidence client is not initialized.");
    }
    return this.cookieJar;
  }

  private async getJson(url: string): Promise<unknown> {
    const res = await this.getWithRetry(url, 3);
    await assertJsonResponse(res, url);
    return res.json();
  }

  private async postJson(url: string, body: unknown): Promise<unknown> {
    const res = await this.postWithRetry(url, body, 2);
    const status = res.status;
    if (status !== 200 && status !== 201) {
      const text = await res.text();
      throw new Error(`POST ${url} failed: ${status} ${text.slice(0, 400)}`);
    }
    return res.json();
  }

  private async getWithRetry(url: string, attempts: number) {
    let last = await this.get(url);
    for (let i = 1; i < attempts; i++) {
      if (last.status < 500) {
        return last;
      }
      await sleep(i * 400);
      last = await this.get(url);
    }
    return last;
  }

  private async postWithRetry(url: string, body: unknown, attempts: number) {
    let last = await this.post(url, body);
    for (let i = 1; i < attempts; i++) {
      if (last.status < 500) {
        return last;
      }
      await sleep(i * 400);
      last = await this.post(url, body);
    }
    return last;
  }

  private get(url: string): Promise<Response> {
    return this.fetchWithCookies(url);
  }

  private post(url: string, body: unknown): Promise<Response> {
    return this.fetchWithCookies(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
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

async function assertJsonResponse(res: Response, url: string): Promise<void> {
  const status = res.status;
  if (status >= 200 && status < 300) {
    return;
  }
  const text = await res.text();
  throw new Error(`GET ${url} failed with status ${status}: ${text.slice(0, 400)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
