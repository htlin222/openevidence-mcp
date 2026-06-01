import { existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	DEFAULT_RATE_LIMIT_CONFIG,
	type RateLimitConfig,
} from "./rate-limit.js";

export interface AppConfig {
	baseUrl: string;
	cookiesPath: string;
	fingerprintPath?: string;
	artifactDir: string;
	crossrefMailto?: string;
	crossrefValidate: boolean;
	pollIntervalMs: number;
	pollTimeoutMs: number;
	rateLimit: RateLimitConfig;
	/** CDP endpoint of a running browser used for the DataDome-passing ask path. */
	cdpUrl: string;
	/** Web origin the browser ask path drives (session + DataDome cookie live here). */
	webOrigin: string;
	/** Fall back to the browser ask path when POST /api/article hits DataDome (default on). */
	browserFallback: boolean;
	/** Skip the Node POST attempt and go straight to the browser ask path. */
	askViaBrowser: boolean;
}

const DEFAULT_BASE_URL = "https://www.openevidence.com";
const DEFAULT_ROOT = path.join(homedir(), ".openevidence-mcp");
const DEFAULT_ARTIFACT_DIR = path.join(tmpdir(), "openevidence-mcp");

export function resolveConfig(): AppConfig {
	const rootDir = process.env.OE_MCP_ROOT_DIR ?? DEFAULT_ROOT;
	const localCookiesPath = path.resolve(process.cwd(), "cookies.json");
	const cookiesPath =
		process.env.OE_MCP_COOKIES_PATH ??
		process.env.OE_MCP_AUTH_STATE_PATH ??
		(existsSync(localCookiesPath)
			? localCookiesPath
			: path.join(rootDir, "auth", "cookies.json"));
	const localFingerprintPath = path.resolve(
		process.cwd(),
		"openevidence-fingerprint.json",
	);
	const moduleFingerprintPath = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
		"openevidence-fingerprint.json",
	);
	const fingerprintPath =
		process.env.OE_MCP_FINGERPRINT_PATH ??
		firstExistingPath(localFingerprintPath, moduleFingerprintPath);

	const baseUrl = process.env.OE_MCP_BASE_URL ?? DEFAULT_BASE_URL;

	return {
		baseUrl,
		cookiesPath,
		fingerprintPath,
		artifactDir: process.env.OE_MCP_ARTIFACT_DIR ?? DEFAULT_ARTIFACT_DIR,
		crossrefMailto: process.env.OE_MCP_CROSSREF_MAILTO,
		crossrefValidate: process.env.OE_MCP_CROSSREF_VALIDATE !== "0",
		pollIntervalMs: parseInt(process.env.OE_MCP_POLL_INTERVAL_MS ?? "1200", 10),
		pollTimeoutMs: parseInt(process.env.OE_MCP_POLL_TIMEOUT_MS ?? "180000", 10),
		rateLimit: resolveRateLimitConfig(),
		cdpUrl: process.env.OE_MCP_CDP_URL ?? "http://localhost:9222",
		webOrigin: process.env.OE_MCP_WEB_ORIGIN ?? baseUrl,
		browserFallback: process.env.OE_MCP_BROWSER_FALLBACK !== "0",
		askViaBrowser: process.env.OE_MCP_ASK_VIA_BROWSER === "1",
	};
}

function firstExistingPath(...paths: string[]): string | undefined {
	return paths.find((candidate) => existsSync(candidate));
}

function resolveRateLimitConfig(): RateLimitConfig {
	const def = DEFAULT_RATE_LIMIT_CONFIG;
	const num = (key: string, fallback: number): number => {
		const raw = process.env[key];
		if (raw === undefined) return fallback;
		const n = parseInt(raw, 10);
		return Number.isFinite(n) && n >= 0 ? n : fallback;
	};
	return {
		windowMs: num("OE_MCP_RATE_WINDOW_MS", def.windowMs),
		maxRequestsPerWindow: num("OE_MCP_RPM", def.maxRequestsPerWindow),
		burstCap: num("OE_MCP_BURST", def.burstCap),
		targetUsagePercent: num("OE_MCP_RATE_TARGET", def.targetUsagePercent),
		maxConcurrent: num("OE_MCP_MAX_CONCURRENT", def.maxConcurrent),
		retry: {
			maxRetries: num("OE_MCP_MAX_RETRIES", def.retry.maxRetries),
			baseDelayMs: num("OE_MCP_RETRY_BASE_MS", def.retry.baseDelayMs),
			maxDelayMs: num("OE_MCP_RETRY_MAX_MS", def.retry.maxDelayMs),
			jitterMs: num("OE_MCP_RETRY_JITTER_MS", def.retry.jitterMs),
		},
	};
}

export function ensureConfigDirs(config: AppConfig): void {
	mkdirSync(path.dirname(config.cookiesPath), { recursive: true });
	mkdirSync(config.artifactDir, { recursive: true });
}
