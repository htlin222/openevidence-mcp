#!/usr/bin/env node
import "dotenv/config";

import { tmpdir } from "node:os";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { connectSharedRelay, fetchRelayHealth, type RelayClient } from "./relay-client.js";
import { RELAY_VERSION } from "./relay-server.js";
import { AnswersDb } from "./answers-db.js";
import { extractCitations, extractFigures, saveArticleArtifacts } from "./citations.js";
import { ensureConfigDirs, resolveConfig } from "./config.js";
import {
	extractAnswerText,
	extractFollowUpQuestions,
	fetchHtmlWithCookies,
	OpenEvidenceClient,
	resolveVisualTags,
} from "./openevidence-client.js";
import {
	extractArticleId,
	fetchConversationHtml,
	parsePublicConversation,
	PublicPageError,
	stripCitationMarkers,
} from "./public-page.js";
import { RateLimitController } from "./rate-limit.js";
import {
	parseStdoutJson,
	runClassify,
	runCollectionSort,
	withTempPlan,
} from "./python-bridge.js";
import type { ArticleAccessLevel, OpenEvidenceAskRequest } from "./types.js";

const config = resolveConfig();
ensureConfigDirs(config);

// Connect to the shared relay daemon (spawning it if needed). The daemon owns
// the relay port and outlives every session, so any number of MCP servers can
// funnel through one browser tab. See relay-client.ts / relay-daemon.ts.
let relayClientPromise: Promise<RelayClient | null> | null = null;
function getRelay(): Promise<RelayClient | null> {
	if (!config.relayEnabled) return Promise.resolve(null);
	if (!relayClientPromise) {
		relayClientPromise = connectSharedRelay(config).catch((err) => {
			process.stderr.write(`[relay] failed to connect: ${String(err)}\n`);
			return null;
		});
	}
	return relayClientPromise;
}

// Connect eagerly so the daemon is up by the time the first tool call lands.
void getRelay();

// Exit cleanly when the host (Claude/Codex) goes away. The stdio transport ends
// our stdin on disconnect; without this the process can linger as an orphan and
// pile up across sessions. Closing the relay client stops its health-poll timer
// (the shared daemon keeps running for other sessions — we never kill it here).
let shuttingDown = false;
function shutdownServer(signal: string): void {
	if (shuttingDown) return;
	shuttingDown = true;
	if (relayClientPromise) {
		void relayClientPromise.then((c) => c?.close()).catch(() => {});
	}
	process.stderr.write(`[openevidence-mcp] ${signal} — exiting\n`);
	process.exit(0);
}
process.on("SIGTERM", () => shutdownServer("SIGTERM"));
process.on("SIGINT", () => shutdownServer("SIGINT"));
process.stdin.on("end", () => shutdownServer("stdin end"));
process.stdin.on("close", () => shutdownServer("stdin close"));

const server = new McpServer({
	name: "openevidence-mcp",
	version: "1.0.0",
});

// ---- local answers store (SQLite, shared file with the Python collections CLI) ----

// Lazy so a failed open (unwritable dir, exotic Node build without node:sqlite)
// degrades to "store disabled" instead of killing the server or any tool call.
let answersDbHandle: AnswersDb | null | undefined;
function getAnswersDb(): AnswersDb | null {
	if (answersDbHandle === undefined) {
		try {
			answersDbHandle = AnswersDb.open(config.dbPath);
		} catch (err) {
			answersDbHandle = null;
			process.stderr.write(`[answers-db] disabled (${config.dbPath}): ${String(err)}\n`);
		}
	}
	return answersDbHandle;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Space question submissions to respect OpenEvidence's per-account question rate
 * (~1/sec). Waits — never errors — for the remainder of askMinIntervalMs since
 * the last recorded ask, coordinated across sessions via the shared ask_log.
 * Atomically reserves this ask and returns how long it waited plus the
 * trailing-hour count.
 */
async function paceAsk(account: string): Promise<{
	waitedMs: number;
	asksLastHour: number;
	reservedAt?: number;
}> {
	const db = getAnswersDb();
	if (!db) {
		return { waitedMs: 0, asksLastHour: 0 };
	}
	let waitedMs = 0;
	let reservedAt: number | undefined;
	try {
		const now = Date.now();
		reservedAt = db.reserveAsk(account, now, config.askMinIntervalMs);
		waitedMs = Math.max(0, reservedAt - now);
		if (waitedMs > 0) await sleep(waitedMs);
	} catch (err) {
		process.stderr.write(`[ask-pacing] ${String(err)}\n`);
	}
	const asksLastHour = (() => {
		try {
			return db.asksSince(account, Date.now() - 3_600_000);
		} catch {
			return 0;
		}
	})();
	return { waitedMs, asksLastHour, reservedAt };
}

/** Best-effort upsert of a fetched answer; storage must never fail the tool. */
function persistAnswer(
	account: string,
	article: Record<string, unknown>,
	resolvedAnswer: string | null,
	figures: ReturnType<typeof extractFigures>,
): void {
	try {
		const db = getAnswersDb();
		const articleId = String(article.id ?? "");
		const status = String(article.status ?? "");
		if (!db || !articleId || status === "" || resolvedAnswer == null) return;
		const inputs = article.inputs as { question?: unknown } | undefined;
		db.upsert({
			account,
			articleId,
			title: typeof article.title === "string" ? article.title : null,
			question: typeof inputs?.question === "string" ? inputs.question : null,
			answerMarkdown: resolvedAnswer,
			citationsJson: JSON.stringify(extractCitations(article, resolvedAnswer)),
			figuresJson: JSON.stringify(figures),
			followUpJson: JSON.stringify(extractFollowUpQuestions(article)),
			articleType: typeof article.article_type === "string" ? article.article_type : null,
			status,
			datetimeCreated:
				typeof article.datetime_created === "string" ? article.datetime_created : null,
			fetchedAt: new Date().toISOString(),
		});
	} catch (err) {
		process.stderr.write(`[answers-db] upsert failed: ${String(err)}\n`);
	}
}

server.registerTool(
	"oe_health",
	{
		title: "OpenEvidence Relay Health",
		description:
			"Millisecond-fast local check of the relay pipeline (daemon + browser extension) — no OpenEvidence network call. " +
			"Use this to confirm the pipeline is up before oe_ask; use oe_auth_status only when you need to verify the login session itself.",
	},
	async () => {
		if (!config.relayEnabled) {
			return ok({ healthy: false, relay_enabled: false, port: config.relayPort });
		}
		const h = await fetchRelayHealth(config.relayPort);
		if (!h) {
			return ok({
				healthy: false,
				relay_enabled: true,
				port: config.relayPort,
				daemon: "down",
				hint: "Relay daemon is not answering on this port. It respawns on the next oe_ask, or run `make doctor` to diagnose.",
			});
		}
		const versionMatch = h.version === RELAY_VERSION;
		const startedAt = typeof h.startedAt === "number" ? h.startedAt : null;
		const lastActivityAt = typeof h.lastActivityAt === "number" ? h.lastActivityAt : null;
		return ok({
			healthy: h.connected === true && versionMatch,
			relay_enabled: true,
			port: config.relayPort,
			daemon: "up",
			extension_connected: h.connected === true,
			version: h.version,
			version_expected: RELAY_VERSION,
			version_match: versionMatch,
			pid: h.pid,
			uptime_sec: startedAt != null ? Math.round((Date.now() - startedAt) / 1000) : null,
			requests_served: h.served,
			requests_errored: h.errored,
			requests_pending: h.pending,
			last_activity: lastActivityAt ? new Date(lastActivityAt).toISOString() : null,
			asks_last_hour: (() => {
				try {
					return getAnswersDb()?.asksSinceAny(Date.now() - 3_600_000) ?? null;
				} catch {
					return null;
				}
			})(),
			ask_min_interval_ms: config.askMinIntervalMs,
			...(h.connected !== true && {
				hint: "Daemon is up but the browser extension is not polling — check the extension is loaded and the browser is running.",
			}),
		});
	},
);

server.registerTool(
	"oe_auth_status",
	{
		title: "OpenEvidence Auth Status",
		description:
			"Check if the local OpenEvidence session is valid (full network round-trip). For a fast pipeline-connectivity check use oe_health instead.",
	},
	async () =>
		withClient(async (client) => {
			const status = await client.getAuthStatus();
			return ok(status);
		}),
);

server.registerTool(
	"oe_history_list",
	{
		title: "OpenEvidence History List",
		description: "List question history from OpenEvidence account.",
		inputSchema: z.object({
			limit: z.number().int().min(1).max(100).default(20).optional(),
			offset: z.number().int().min(0).default(0).optional(),
			search: z.string().max(200).optional(),
		}),
	},
	async (args) =>
		withClient(async (client) => {
			const data = await client.listHistory(
				args.limit ?? 20,
				args.offset ?? 0,
				args.search,
			);
			return ok(data);
		}),
);

server.registerTool(
	"oe_article_get",
	{
		title: "OpenEvidence Article Get",
		description:
			"Fetch an article (answer) by id or /ask/ URL — the fetch-later half of fire-and-forget oe_ask. " +
			"Returns the current status; if it is still 'pending' either retry later or pass wait_for_completion:true to block until the answer is ready. " +
			"After verifying the active account, completed answers are served from that account's local SQLite cache when available (from_cache:true) — pass refresh:true to force a re-fetch from OpenEvidence.",
		inputSchema: z.object({
			article_id: z
				.string()
				.describe("Article UUID, or any openevidence.com/ask/<id> URL."),
			wait_for_completion: z.boolean().default(false).optional(),
			timeout_sec: z.number().int().min(5).max(600).default(120).optional(),
			poll_interval_ms: z.number().int().min(300).max(10000).default(1200).optional(),
			save_artifacts: z.boolean().default(true).optional(),
			crossref_validate: z.boolean().default(true).optional(),
			include_bibtex: z.boolean().default(true).optional(),
			strip_citation_markers: z.boolean().default(false).optional(),
			refresh: z
				.boolean()
				.default(false)
				.optional()
				.describe("Bypass the local answers cache and re-fetch from OpenEvidence."),
		}),
	},
	async (args) => {
		const requestedArticleId = extractArticleId(args.article_id);
		if (!requestedArticleId) {
			return fail(
				`Could not find an article UUID in "${args.article_id}". Pass a UUID or an openevidence.com/ask/<id> URL.`,
			);
		}
		return withClient(async (client, account) => {
			const articleId = requestedArticleId;
			if (!(args.refresh ?? false)) {
				const rec = getAnswersDb()?.getByArticleId(account, articleId);
				if (rec && rec.status === "success" && rec.answerMarkdown != null) {
					return ok({
						article_id: articleId,
						status: rec.status,
						extracted_answer_raw: rec.answerMarkdown,
						...(args.strip_citation_markers ?? false
							? { extracted_answer_clean: stripCitationMarkers(rec.answerMarkdown) }
							: {}),
						figures: safeJsonParse(rec.figuresJson) ?? [],
						citations: safeJsonParse(rec.citationsJson) ?? [],
						follow_up_questions: safeJsonParse(rec.followUpJson) ?? [],
						artifacts: null,
						from_cache: true,
						fetched_at: rec.fetchedAt,
						note: `Served from the account-scoped local answers store (${config.dbPath}). Pass refresh:true to re-fetch from OpenEvidence and regenerate artifacts.`,
					});
				}
			}
			const article = (args.wait_for_completion ?? false)
				? await client.waitForArticle(articleId, {
						timeoutMs: (args.timeout_sec ?? 120) * 1000,
						intervalMs: args.poll_interval_ms ?? config.pollIntervalMs,
					})
				: await client.getArticle(articleId);
			const figures = extractFigures(article);
			const answerRaw = extractAnswerText(article);
			const artifacts =
				(args.save_artifacts ?? true)
					? await saveArticleArtifacts(article, config, {
							validateWithCrossref:
								args.crossref_validate ?? config.crossrefValidate,
						})
					: null;
			const answer = answerRaw ? resolveVisualTags(answerRaw, figures) : null;
			persistAnswer(account, article, answer, figures);
			return ok({
				article_id: articleId,
				status: String(article.status ?? ""),
				extracted_answer_raw: answer,
				...(answer && (args.strip_citation_markers ?? false)
					? { extracted_answer_clean: stripCitationMarkers(answer) }
					: {}),
				figures,
				follow_up_questions: extractFollowUpQuestions(article),
				follow_up_hint:
					"To continue this thread, call oe_ask with one of follow_up_questions (or your own) and original_article_id set to this article_id.",
				artifacts: formatArtifactsForResponse(
					artifacts,
					args.include_bibtex ?? true,
				),
			});
		});
	},
);

server.registerTool(
	"oe_answers_search",
	{
		title: "Search Stored Answers (local FTS)",
		description:
			"Account-scoped full-text search (SQLite FTS5) over answers previously fetched by oe_ask/oe_article_get — questions, titles, and answer bodies. " +
			"The active browser login is verified first, then only that account's answers are searched; results are never mixed across logins. " +
			"Covers only answers this MCP has fetched and stored locally; for your complete server-side history use oe_history_list. " +
			"Snippets mark matches with »…«.",
		inputSchema: z.object({
			query: z
				.string()
				.min(1)
				.max(500)
				.describe("FTS5 query — plain words, \"quoted phrases\", AND/OR/NOT."),
			limit: z.number().int().min(1).max(50).default(10).optional(),
		}),
	},
	async (args) =>
		withClient(async (_client, account) => {
			const db = getAnswersDb();
			if (!db) {
				return fail(`Local answers store is unavailable (could not open ${config.dbPath}).`);
			}
			const matches = db.search(account, args.query, args.limit ?? 10);
			return ok({
				account,
				total_stored: db.count(account),
				match_count: matches.length,
				matches: matches.map((m) => ({
					article_id: m.articleId,
					title: m.title,
					question: m.question,
					snippet: m.snippet,
					datetime_created: m.datetimeCreated,
					fetched_at: m.fetchedAt,
					url: `https://www.openevidence.com/ask/${m.articleId}`,
				})),
			});
		}),
);

server.registerTool(
	"oe_ask",
	{
		title: "OpenEvidence Ask",
		description:
			"Create a question. Fire-and-forget by default: returns {article_id, status:'pending'} immediately so the browser tab is free for other sessions — fetch the finished answer later with oe_article_get (optionally wait_for_completion:true). Pass wait_for_completion:true here to block and return the answer in one call. For a follow-up question pass original_article_id. " +
			"Submits POST /api/article through the connected browser-extension relay (runs in your real logged-in tab, DataDome-free); the direct Node POST is deprecated and no longer attempted. " +
			"Requires the relay extension to be connected (see extension/README.md).",
		inputSchema: z.object({
			question: z.string().min(3).max(6000),
			original_article_id: z
				.string()
				.optional()
				.describe(
					"Article UUID or openevidence.com/ask/<id> URL of the conversation to follow up on.",
				),
			wait_for_completion: z.boolean().default(false).optional(),
			timeout_sec: z.number().int().min(5).max(600).default(120).optional(),
			poll_interval_ms: z
				.number()
				.int()
				.min(300)
				.max(10000)
				.default(1200)
				.optional(),
			disable_caching: z.boolean().default(false).optional(),
			personalization_enabled: z.boolean().default(false).optional(),
			article_type: z
				.string()
				.default("Ask OpenEvidence Light with citations")
				.optional(),
			variant_configuration_file: z.string().default("prod").optional(),
			save_artifacts: z.boolean().default(true).optional(),
			crossref_validate: z.boolean().default(true).optional(),
			include_bibtex: z.boolean().default(true).optional(),
			strip_citation_markers: z.boolean().default(false).optional(),
		}),
	},
	async (args) =>
		withClient(async (client, account) => {
			const timeoutMs = (args.timeout_sec ?? 120) * 1000;
			const intervalMs = args.poll_interval_ms ?? config.pollIntervalMs;

			let originalArticleId: string | undefined;
			if (args.original_article_id) {
				originalArticleId = extractArticleId(args.original_article_id) ?? undefined;
				if (!originalArticleId) {
					return fail(
						`Could not find an article UUID in original_article_id "${args.original_article_id}".`,
					);
				}
			}

			// The whole client is routed through the browser-extension relay (see
			// withClient): POST /api/article runs inside your logged-in tab and the
			// follow-up reads use that same session, so a freshly-created article is
			// always visible to the poller (no creator/account mismatch).
			const askPayload: OpenEvidenceAskRequest = {
				question: args.question,
				originalArticleId,
				disableCaching: args.disable_caching ?? false,
				personalizationEnabled: args.personalization_enabled ?? false,
				articleType: args.article_type,
				variantConfigurationFile: args.variant_configuration_file,
			};

			// Respect the per-account question rate before firing the POST.
			const pacing = await paceAsk(account);
			if (pacing.waitedMs > 0) {
				const rechecked = await client.getAuthStatus();
				const currentAccount = authenticatedAccount(rechecked);
				if (!rechecked.authenticated || currentAccount !== account) {
					if (pacing.reservedAt !== undefined) {
						try {
							getAnswersDb()?.cancelAskReservation(account, pacing.reservedAt);
						} catch (error) {
							process.stderr.write(`[ask-pacing] could not release reservation: ${String(error)}\n`);
						}
					}
					return fail(
						"The active OpenEvidence account changed while this ask was waiting for its rate-limit slot; the question was not submitted.",
					);
				}
			}

			const created = await client.ask(askPayload);
			const articleId = String((created as { id?: string }).id ?? "");
			if (!articleId) {
				return fail("ask POST returned no article id.");
			}

			const askPacing = {
				waited_ms: pacing.waitedMs,
				asks_last_hour: pacing.asksLastHour,
			};

			const waitForCompletion = args.wait_for_completion ?? false;
			if (!waitForCompletion) {
				return ok({
					article_id: articleId,
					status: "pending",
					note: "Fire-and-forget: article submitted. Fetch the answer with oe_article_get(article_id) — pass wait_for_completion:true there to block until it is ready.",
					ask_pacing: askPacing,
					created,
				});
			}

			const article = await client.waitForArticle(articleId, { timeoutMs, intervalMs });
			const figures = extractFigures(article);
			const answerRaw = extractAnswerText(article);
			const artifacts =
				(args.save_artifacts ?? true)
					? await saveArticleArtifacts(article, config, {
							validateWithCrossref: args.crossref_validate ?? config.crossrefValidate,
						})
					: null;

			const answer = answerRaw ? resolveVisualTags(answerRaw, figures) : null;
			persistAnswer(account, article, answer, figures);
			return ok({
				article_id: articleId,
				status: String(article.status ?? ""),
				extracted_answer_raw: answer,
				...(answer && (args.strip_citation_markers ?? false)
					? { extracted_answer_clean: stripCitationMarkers(answer) }
					: {}),
				figures,
				follow_up_questions: extractFollowUpQuestions(article),
				follow_up_hint:
					"To continue this thread, call oe_ask with one of follow_up_questions (or your own) and original_article_id set to this article_id.",
				ask_pacing: askPacing,
				artifacts: formatArtifactsForResponse(artifacts, args.include_bibtex ?? true),
			});
		}),
);

// Page fetches in oe_public_get bypass OpenEvidenceClient, so they get their
// own controller against the same account budget (60 clinical queries/min) —
// one page GET per tool call, throttled exactly like the API reads.
const pageLimiter = new RateLimitController(config.rateLimit);

server.registerTool(
	"oe_public_get",
	{
		title: "OpenEvidence Conversation Page Get",
		description:
			"Read an OpenEvidence conversation from an /ask/<id> link and parse the page into Q&A turns (question, answer as markdown, references). " +
			"Public (shared) conversations need no setup at all; your own private ones work when the relay extension is connected (your logged-in tab) or cookies.json exists. " +
			"Use oe_article_get when you want the raw API payload + saved artifacts instead.",
		inputSchema: z.object({
			url: z
				.string()
				.min(8)
				.describe("A https://www.openevidence.com/ask/<id> URL, or the bare article UUID."),
			strip_citation_markers: z.boolean().default(false).optional(),
		}),
	},
	async (args) => {
		const articleId = extractArticleId(args.url);
		if (!articleId) {
			return fail(
				`Could not find an article UUID in "${args.url}". Pass an openevidence.com/ask/<id> URL or a bare UUID.`,
			);
		}
		try {
			// Auth escalation: relay (logged-in tab; reads private conversations,
			// DataDome-free) → anonymous fetch (public pages, zero setup) →
			// cookies.json (headless fallback for private pages).
			const relay = await getRelay();
			await pageLimiter.acquire("routine");
			let html: string;
			try {
				html = await fetchConversationHtml(articleId, {
					relay,
					cookieAuth: { fetchHtml: (path) => fetchHtmlWithCookies(config, path) },
				});
			} finally {
				pageLimiter.release();
			}
			const conversation = parsePublicConversation(html);
			if (conversation.turns.length === 0) {
				return fail(
					"No conversation turns found — the conversation may be deleted, or the fetch landed on a signed-out page. " +
						"If it is yours, make sure the relay's openevidence.com tab is logged in (or refresh cookies.json), or fetch it with oe_article_get.",
				);
			}
			const strip = args.strip_citation_markers ?? false;
			return ok({
				article_id: articleId,
				source_url: `https://www.openevidence.com/ask/${articleId}`,
				title: conversation.title,
				turn_count: conversation.turns.length,
				turns: conversation.turns.map((turn) => ({
					question: turn.question,
					answer_markdown: strip
						? stripCitationMarkers(turn.answerMarkdown)
						: turn.answerMarkdown,
					references_markdown: turn.referencesMarkdown,
				})),
			});
		} catch (error) {
			if (error instanceof PublicPageError) return fail(error.message);
			return fail(error instanceof Error ? error.message : String(error));
		}
	},
);

server.registerTool(
	"oe_article_set_access",
	{
		title: "OpenEvidence Article Share Access",
		description:
			"Set a conversation's share visibility (PATCH /api/article/<id>/access). " +
			"public:true makes it link-shareable (ANYONE_WITH_LINK — anyone with the URL can read it, no login); " +
			"public:false makes it private again (CREATOR_ONLY). Returns the shareable /ask/<id> URL. " +
			"You must own the conversation, and the relay extension must be connected (only the owning browser session may change access). " +
			"⚠️ Publishing exposes the conversation to anyone on the internet with the link — do not publish anything containing PHI or medically sensitive patient information.",
		inputSchema: z.object({
			article_id: z
				.string()
				.min(8)
				.describe("Article UUID or openevidence.com/ask/<id> URL of the conversation."),
			public: z
				.boolean()
				.describe("true → ANYONE_WITH_LINK (public); false → CREATOR_ONLY (private)."),
		}),
	},
	async (args) =>
		withClient(async (client) => {
			const articleId = extractArticleId(args.article_id);
			if (!articleId) {
				return fail(
					`Could not find an article UUID in "${args.article_id}". Pass an openevidence.com/ask/<id> URL or a bare UUID.`,
				);
			}
			const accessLevel: ArticleAccessLevel = args.public
				? "ANYONE_WITH_LINK"
				: "CREATOR_ONLY";
			const data = await client.setArticleAccess(articleId, accessLevel);
			const resolved = String(
				(data as { resolved_access_level?: string; access_level?: string })
					.resolved_access_level ??
					(data as { access_level?: string }).access_level ??
					accessLevel,
			);
			return ok({
				article_id: articleId,
				public: resolved === "ANYONE_WITH_LINK",
				access_level: resolved,
				share_url: `https://www.openevidence.com/ask/${articleId}`,
				result: data,
			});
		}),
);

server.registerTool(
	"oe_collections_list",
	{
		title: "OpenEvidence Collections List",
		description: "List all collections owned by the authenticated user.",
	},
	async () =>
		withClient(async (client) => {
			const data = await client.listCollections();
			return ok({ collections: data, count: data.length });
		}),
);

server.registerTool(
	"oe_collections_get",
	{
		title: "OpenEvidence Collection Get",
		description:
			"Fetch a collection (incl. nested questions[] = membership list) by id.",
		inputSchema: z.object({
			collection_id: z.string().uuid(),
		}),
	},
	async (args) =>
		withClient(async (client) => {
			const data = await client.getCollection(args.collection_id);
			return ok(data);
		}),
);

server.registerTool(
	"oe_collections_create",
	{
		title: "OpenEvidence Collection Create",
		description:
			"Create a new collection. By convention, agent-managed names start with '#'.",
		inputSchema: z.object({
			name: z.string().min(1).max(120),
			description: z.string().max(500).optional(),
		}),
	},
	async (args) =>
		withClient(async (client) => {
			const data = await client.createCollection(args.name, args.description);
			return ok(data);
		}),
);

server.registerTool(
	"oe_collections_add_article",
	{
		title: "OpenEvidence Collection Add Article",
		description:
			"Add a chat (article) to a collection. Idempotent in practice.",
		inputSchema: z.object({
			collection_id: z.string().uuid(),
			article_id: z.string().uuid(),
		}),
	},
	async (args) =>
		withClient(async (client) => {
			const data = await client.addArticleToCollection(
				args.collection_id,
				args.article_id,
			);
			return ok(data);
		}),
);

server.registerTool(
	"oe_collections_db_init",
	{
		title: "Init Collections SQLite Mirror",
		description:
			"Create the local SQLite mirror at $OE_MCP_DB_PATH (default ~/.openevidence-mcp/db/oe.sqlite). Idempotent.",
	},
	async () => {
		const r = await runCollectionSort(config, ["init"]);
		if (r.code !== 0) return fail(`init failed: ${r.stderr || r.stdout}`);
		return ok({ message: r.stdout.trim() });
	},
);

server.registerTool(
	"oe_collections_sync_history",
	{
		title: "Sync Chat History to SQLite",
		description:
			"Paginate /api/article/list and upsert chats. Incremental by default (stops on the first all-known page).",
		inputSchema: z.object({
			full: z.boolean().default(false).optional(),
			pages: z.number().int().min(1).max(200).optional(),
			page_size: z.number().int().min(1).max(50).default(20).optional(),
			rate_seconds: z.number().min(0.1).max(10).default(1.0).optional(),
		}),
	},
	async (args) => {
		const cliArgs: string[] = ["sync-history"];
		if (args.full) cliArgs.push("--full");
		if (args.pages !== undefined) cliArgs.push("--pages", String(args.pages));
		if (args.page_size !== undefined)
			cliArgs.push("--page-size", String(args.page_size));
		const r = await runCollectionSort(config, cliArgs, {
			rateSeconds: args.rate_seconds,
		});
		if (r.code !== 0)
			return fail(`sync-history failed: ${r.stderr || r.stdout}`);
		return ok({ message: r.stdout.trim() });
	},
);

server.registerTool(
	"oe_collections_sync_db",
	{
		title: "Sync Collections + Memberships to SQLite",
		description:
			"Refresh collections and memberships from the API into local SQLite. Prunes collections + memberships the server no longer reports.",
		inputSchema: z.object({
			rate_seconds: z.number().min(0.1).max(10).default(1.0).optional(),
		}),
	},
	async (args) => {
		const r = await runCollectionSort(config, ["sync-collections"], {
			rateSeconds: args.rate_seconds,
		});
		if (r.code !== 0)
			return fail(`sync-collections failed: ${r.stderr || r.stdout}`);
		return ok({ message: r.stdout.trim() });
	},
);

server.registerTool(
	"oe_collections_unsorted",
	{
		title: "List Unsorted Chats",
		description:
			"Chats with no membership in any '#'-prefixed collection. Returns {unsorted_count, shown, items[]}.",
		inputSchema: z.object({
			limit: z.number().int().min(1).max(2000).default(200).optional(),
			preview_chars: z.number().int().min(20).max(2000).default(240).optional(),
		}),
	},
	async (args) => {
		const cliArgs: string[] = ["list-unsorted", "--json"];
		if (args.limit !== undefined) cliArgs.push("--limit", String(args.limit));
		if (args.preview_chars !== undefined)
			cliArgs.push("--preview-chars", String(args.preview_chars));
		const r = await runCollectionSort(config, cliArgs);
		if (r.code !== 0)
			return fail(`list-unsorted failed: ${r.stderr || r.stdout}`);
		return ok(parseStdoutJson(r.stdout));
	},
);

server.registerTool(
	"oe_collections_summary",
	{
		title: "Collections Summary",
		description:
			"Counts (chats, collections, hashtag, memberships, unsorted) + last sync timestamps.",
	},
	async () => {
		const r = await runCollectionSort(config, ["summary"]);
		if (r.code !== 0) return fail(`summary failed: ${r.stderr || r.stdout}`);
		return ok(parseStdoutJson(r.stdout));
	},
);

server.registerTool(
	"oe_collections_classify",
	{
		title: "Auto-Classify Unsorted Chats",
		description:
			"Predict hashtags for every unsorted chat (or all chats with reclassify_all). Combines curated keyword rules with a per-tag log-odds-ratio signature trained from your existing memberships. Returns the proposed plan as JSON; use oe_collections_bulk_apply to actually write.",
		inputSchema: z.object({
			reclassify_all: z.boolean().default(false).optional(),
			threshold: z.number().min(0).max(50).default(8).optional(),
			top_k: z.number().int().min(1).max(10).default(3).optional(),
			top_n_terms: z.number().int().min(5).max(100).default(20).optional(),
			rules_only: z.boolean().default(false).optional(),
			no_rules: z.boolean().default(false).optional(),
		}),
	},
	async (args) => {
		const tmp = path.join(tmpdir(), `oe-classify-${Date.now()}.json`);
		const cliArgs: string[] = [
			"--threshold",
			String(args.threshold ?? 8),
			"--top-k",
			String(args.top_k ?? 3),
			"--top-n-terms",
			String(args.top_n_terms ?? 20),
		];
		if (args.rules_only) cliArgs.push("--rules-only");
		if (args.no_rules) cliArgs.push("--no-rules");
		cliArgs.push("classify", "--output", tmp, "--quiet");
		if (args.reclassify_all) cliArgs.push("--reclassify-all");
		const r = await runClassify(cliArgs);
		if (r.code !== 0) return fail(`classify failed: ${r.stderr || r.stdout}`);
		const fs = await import("node:fs/promises");
		const plan = JSON.parse(await fs.readFile(tmp, "utf8"));
		await fs.unlink(tmp).catch(() => {});
		const counts: Record<string, number> = {};
		for (const e of plan as { hashtags: string[] }[]) {
			for (const t of e.hashtags) counts[t] = (counts[t] ?? 0) + 1;
		}
		return ok({ plan, count: plan.length, tag_distribution: counts });
	},
);

server.registerTool(
	"oe_collections_bulk_apply",
	{
		title: "Bulk-Apply Hashtag Plan",
		description:
			"For each {article_id, hashtags[]} entry: ensure each '#'-prefixed collection exists, then add the article to it. Idempotent. Refuses non-'#' tags.",
		inputSchema: z.object({
			plan: z.array(
				z.object({
					article_id: z.string().uuid(),
					hashtags: z.array(z.string().regex(/^#/)).min(1),
				}),
			),
			descriptions: z.record(z.string(), z.string()).optional(),
			rate_seconds: z.number().min(0.1).max(10).default(0.5).optional(),
		}),
	},
	async (args) => {
		return await withTempPlan(
			args.plan,
			args.descriptions,
			async ({ planPath, descriptionsPath }) => {
				const cliArgs: string[] = ["bulk-apply", planPath];
				if (descriptionsPath) cliArgs.push("--descriptions", descriptionsPath);
				const r = await runCollectionSort(config, cliArgs, {
					rateSeconds: args.rate_seconds,
				});
				if (r.code !== 0)
					return fail(`bulk-apply failed: ${r.stderr || r.stdout}`);
				return ok({ message: r.stdout.trim() });
			},
		);
	},
);

function formatArtifactsForResponse(
	artifacts: Awaited<ReturnType<typeof saveArticleArtifacts>> | null,
	includeBibtex: boolean,
) {
	if (!artifacts) {
		return null;
	}
	if (includeBibtex) {
		return artifacts;
	}
	const { bibtex, ...rest } = artifacts;
	return rest;
}

async function withClient(
	fn: (client: OpenEvidenceClient, account: string) => Promise<{
		content: { type: "text"; text: string }[];
		isError?: boolean;
		structuredContent?: Record<string, unknown>;
	}>,
) {
	const client = new OpenEvidenceClient(config);
	if (config.relayTransport === "all") {
		const relay = await getRelay();
		const relaySession = relay ? await relay.openSession() : null;
		if (!relaySession) {
			return fail(
				"OpenEvidence MCP runs entirely through the browser-extension relay. " +
					"Load extension/dist in your browser (chrome://extensions → Load unpacked), " +
					"keep a logged-in openevidence.com tab open, then retry. " +
					"(Set OE_MCP_RELAY_TRANSPORT=off to fall back to the legacy cookie path.)",
			);
		}
		client.useRelay(relaySession);
	}
	try {
		await client.init();
		const auth = await client.getAuthStatus();
		if (!auth.authenticated) {
			return fail(
				config.relayTransport === "all"
					? `Session is not authenticated (status ${auth.statusCode}). The relay's openevidence.com tab is not logged in — sign in there, then retry.`
					: `Session is not authenticated (status ${auth.statusCode}). Paste fresh browser cookies into ${config.cookiesPath} and run: npm run login`,
				);
		}
		const account = authenticatedAccount(auth);
		if (!account) {
			return fail(
				"OpenEvidence authenticated successfully but /api/auth/me returned no stable email/sub account identifier; refusing to mix account-scoped local data.",
			);
		}
		return await fn(client, account);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return fail(message);
	} finally {
		await client.close();
	}
}

function authenticatedAccount(auth: unknown): string | null {
	const user = (auth as { user?: { email?: string; sub?: string } } | undefined)?.user;
	return user?.email ?? user?.sub ?? null;
}

function ok(data: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
		structuredContent: toStructured(data),
	};
}

function fail(message: string) {
	return {
		isError: true,
		content: [{ type: "text" as const, text: message }],
	};
}

function safeJsonParse(raw: string | null): unknown[] | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function toStructured(data: unknown): Record<string, unknown> {
	if (data && typeof data === "object" && !Array.isArray(data)) {
		return data as Record<string, unknown>;
	}
	return { value: data };
}

async function main() {
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

main().catch((error) => {
	const message =
		error instanceof Error ? (error.stack ?? error.message) : String(error);
	process.stderr.write(`[openevidence-mcp] fatal: ${message}\n`);
	process.exit(1);
});
