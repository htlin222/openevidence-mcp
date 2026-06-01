import { access } from "node:fs/promises";
import { constants } from "node:fs";

import type { AppConfig } from "./config.js";
import { CookieJar } from "./cookies.js";
import {
	BROWSER_FINGERPRINT_HEADER_NAMES,
	DEFAULT_BROWSER_FINGERPRINT,
	loadBrowserFingerprint,
	type BrowserFingerprint,
	type HeaderTuple,
} from "./fingerprint.js";
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
import type {
	AuthStatusResult,
	OpenEvidenceAskRequest,
	WaitOptions,
} from "./types.js";

const DEFAULT_ARTICLE_TYPE = "Ask OpenEvidence Light with citations";
const PENDING_STATUSES = new Set([
	"queued",
	"pending",
	"processing",
	"running",
	"in_progress",
]);

export class OpenEvidenceClient {
	private cookieJar: CookieJar | null = null;
	private fingerprint: BrowserFingerprint = DEFAULT_BROWSER_FINGERPRINT;
	private readonly limiter: RateLimitController;

	constructor(
		private readonly config: AppConfig,
		rateLimitConfig?: Partial<RateLimitConfig>,
	) {
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
		this.fingerprint = await loadBrowserFingerprint(
			this.config.fingerprintPath,
		);
		this.cookieJar = await CookieJar.fromFile(
			this.config.cookiesPath,
			this.config.baseUrl,
		);
	}

	close(): void {
		this.cookieJar = null;
	}

	async getAuthStatus(): Promise<AuthStatusResult> {
		const res = await this.requestWithRateLimit(
			"/api/auth/me",
			undefined,
			"urgent",
		);
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
		return (await this.getJson(`/api/article/${articleId}`)) as Record<
			string,
			unknown
		>;
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
		return (await this.postJson(
			"/api/collections/collections",
			body,
		)) as Record<string, unknown>;
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
	 * Submit an ask. POST /api/article is DataDome-protected and 403s from Node
	 * (see DataDomeChallengeError); when that happens and the browser fallback is
	 * enabled, we re-issue the POST through a real browser over CDP and return the
	 * created article. The caller's subsequent GET polling (waitForArticle) is not
	 * DataDome-blocked, so it continues over Node as usual.
	 */
	async ask(payload: OpenEvidenceAskRequest): Promise<Record<string, unknown>> {
		const body = buildAskRequestBody(payload);

		if (this.config.askViaBrowser) {
			return this.askViaBrowser(body);
		}

		try {
			return (await this.postJson(
				"/api/article",
				body,
				payload.priority,
			)) as Record<string, unknown>;
		} catch (error) {
			if (
				error instanceof DataDomeChallengeError &&
				this.config.browserFallback
			) {
				return this.askViaBrowser(body);
			}
			throw error;
		}
	}

	private async askViaBrowser(
		body: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		// Lazy import keeps playwright-core out of the hot path (and optional) for
		// deployments that never hit DataDome.
		const { submitAskViaBrowser } = await import("./browser-ask.js");
		const { created } = await submitAskViaBrowser({
			cdpUrl: this.config.cdpUrl,
			webOrigin: this.config.webOrigin,
			body,
			log: (message) => process.stderr.write(`[oe_ask:browser] ${message}\n`),
		});
		return created;
	}

	async waitForArticle(
		articleId: string,
		options?: WaitOptions,
	): Promise<Record<string, unknown>> {
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

	private async getJson(
		url: string,
		priority?: ClinicalPriority,
	): Promise<unknown> {
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
		return withExponentialBackoff(async () => {
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
						throw new DataDomeChallengeError(
							`${init?.method ?? "GET"} ${url}`,
							res.headers,
						);
					}
				}
				if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
					const retryAfterMs =
						parseRetryAfterMs(res.headers.get("retry-after"), Date.now()) ??
						undefined;
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
		}, this.config.rateLimit.retry);
	}

	private fetchWithCookies(
		url: string,
		init: RequestInit = {},
	): Promise<Response> {
		const fullUrl = new URL(url, this.config.baseUrl);
		const cookie = this.api().headerFor(fullUrl.toString());
		if (!cookie) {
			throw new Error(
				`No cookies in ${this.config.cookiesPath} match ${fullUrl.hostname}`,
			);
		}

		const headers = buildOpenEvidenceHeaders(
			fullUrl,
			init,
			cookie,
			this.fingerprint,
		);

		return fetch(fullUrl, {
			...init,
			headers,
		});
	}
}

/** Build the POST /api/article request body shared by the Node and browser paths. */
export function buildAskRequestBody(
	payload: OpenEvidenceAskRequest,
): Record<string, unknown> {
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
	const fingerprintHeaders = new Map(fingerprint.headers);
	const fallbackHeaders = new Map(DEFAULT_BROWSER_FINGERPRINT.headers);
	const headers = new Map<string, string>();

	const setDefault = (name: string, value: string): void => {
		headers.set(name, overrides.get(name) ?? value);
		extras.delete(name);
	};
	const fingerprintDefault = (name: string): string => {
		const value = fingerprintHeaders.get(name) ?? fallbackHeaders.get(name);
		if (value === undefined) {
			throw new Error(`OpenEvidence browser fingerprint is missing ${name}.`);
		}
		return value;
	};

	setDefault("accept", fingerprintDefault("accept"));
	setDefault("accept-language", fingerprintDefault("accept-language"));
	if (method !== "GET" && method !== "HEAD") {
		setDefault("content-type", fingerprintDefault("content-type"));
	} else if (overrides.has("content-type")) {
		setDefault(
			"content-type",
			overrides.get("content-type") ?? fingerprintDefault("content-type"),
		);
	}
	setDefault("origin", fullUrl.origin);
	setDefault("priority", fingerprintDefault("priority"));
	setDefault("referer", defaultRefererFor(fullUrl, method));
	for (const name of BROWSER_FINGERPRINT_HEADER_NAMES) {
		if (
			name !== "accept" &&
			name !== "accept-language" &&
			name !== "content-type" &&
			name !== "origin" &&
			name !== "priority" &&
			name !== "referer"
		) {
			setDefault(name, fingerprintDefault(name));
		}
	}
	headers.set("cookie", cookie);
	extras.delete("cookie");

	const ordered: HeaderTuple[] = [];
	for (const name of orderedHeaderNames(fingerprint)) {
		const value = headers.get(name);
		if (value !== undefined) {
			ordered.push([name, value]);
		}
	}
	ordered.push(...extras);
	return ordered;
}

function orderedHeaderNames(fingerprint: BrowserFingerprint): string[] {
	const order: string[] = [];
	const seen = new Set<string>();
	const push = (name: string): void => {
		if (!seen.has(name)) {
			order.push(name);
			seen.add(name);
		}
	};

	for (const [name] of fingerprint.headers) {
		if (BROWSER_FINGERPRINT_HEADER_NAMES.has(name)) {
			push(name);
		}
	}
	for (const [name] of DEFAULT_BROWSER_FINGERPRINT.headers) {
		push(name);
	}
	push("cookie");
	return order;
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

	const articleMatch = fullUrl.pathname.match(
		/^\/api\/article\/([0-9a-f-]{36})(?:\/.*)?$/i,
	);
	if (articleMatch) {
		return `${fullUrl.origin}/ask/${articleMatch[1]}`;
	}

	if (fullUrl.pathname === "/api/article/list") {
		return `${fullUrl.origin}/history`;
	}

	return `${fullUrl.origin}/`;
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
export function isDataDomeChallenge(
	res: Pick<Response, "headers">,
	bodySnippet: string,
): boolean {
	const h = res.headers;
	if (h.has("x-datadome") || h.has("x-dd-b")) return true;
	if (/datadome/i.test(h.get("set-cookie") ?? "")) return true;
	return /captcha-delivery\.com|datadome|"interstitial"/i.test(bodySnippet);
}

async function assertSuccessResponse(
	res: Response,
	method: string,
	url: string,
): Promise<void> {
	const status = res.status;
	if (status >= 200 && status < 300) {
		return;
	}
	const text = await res.text();
	throw new Error(
		`${method} ${url} failed with status ${status}: ${text.slice(0, 400)}`,
	);
}

async function safeReadSnippet(res: Response): Promise<string> {
	try {
		const text = await res.clone().text();
		return text.slice(0, 200);
	} catch {
		return "";
	}
}

export function extractAnswerText(
	article: Record<string, unknown>,
): string | null {
	const output = article.output as Record<string, unknown> | undefined;
	const structuredArticle = output?.structured_article as
		| Record<string, unknown>
		| undefined;
	if (
		typeof structuredArticle?.raw_text === "string" &&
		structuredArticle.raw_text.length > 0
	) {
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

const PUBLICATION_FIGURE_RE =
	/REACTCOMPONENT!:!PublicationFigure!:!(\{[\s\S]*?\})\n*/g;

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

export function resolveVisualTags(
	text: string,
	figures: FigureRecord[],
): string {
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
