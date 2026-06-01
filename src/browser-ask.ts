/**
 * Browser-backed ask transport (DataDome-passing).
 *
 * OpenEvidence's `POST /api/article` (the ask submission) is scored by
 * DataDome's anti-bot layer on signals Node's `fetch` cannot reproduce — the
 * TLS/JA3 and HTTP-2 fingerprint — so it returns HTTP 403 even with a valid
 * login session and a fresh `datadome` cookie. (GET endpoints are scored far
 * more leniently and keep working from Node.) See `DataDomeChallengeError` in
 * `openevidence-client.ts`.
 *
 * This module issues the *same* POST from inside a real browser tab: it attaches
 * to a user-launched browser over the Chrome DevTools Protocol (CDP), opens a
 * page in the already-authenticated context, navigates to `/ask`, and runs the
 * request via `page.evaluate`. The request then rides the browser's real TLS
 * stack, HTTP-2 fingerprint, and live DataDome JS state.
 *
 * The browser is required ONLY for the blocked POST. Once an article id is
 * returned, the caller can poll for completion over Node `fetch` as usual; pass
 * `poll` here only if you want this module to wait for completion too (used by
 * the standalone CLI).
 *
 * Launch a CDP-enabled browser first, e.g. on macOS:
 *   open -a "Brave Browser" --args --remote-debugging-port=9222
 */
import type { Browser, Page } from "playwright-core";

export interface BrowserAskOptions {
  /** CDP endpoint of a running browser, e.g. http://localhost:9222 */
  cdpUrl: string;
  /** Web origin to drive (where the session + DataDome cookie live). */
  webOrigin: string;
  /** Prebuilt POST /api/article request body (see buildAskRequestBody). */
  body: Record<string, unknown>;
  /** If set, also poll GET /api/article/{id} in-page until terminal. */
  poll?: { intervalMs: number; timeoutMs: number };
  /** Optional progress sink (defaults to no-op). */
  log?: (message: string) => void;
}

export interface BrowserAskResult {
  /** The article record returned by POST /api/article. */
  created: Record<string, unknown>;
  /** Completed article if `poll` was provided; otherwise identical to created. */
  article: Record<string, unknown>;
}

/** Raised when the browser-backed ask cannot be completed. */
export class BrowserAskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserAskError";
  }
}

interface InPageOutcome {
  created?: Record<string, unknown>;
  article?: Record<string, unknown>;
  id?: string;
  error?: string;
  status?: number;
  snippet?: string;
}

interface InPageInput {
  body: unknown;
  pollIntervalMs: number;
  timeoutMs: number;
}

/**
 * Executes entirely inside the browser page. Mirrors OpenEvidenceClient.ask()
 * (+ waitForArticle when timeoutMs > 0): POST /api/article, then optionally poll
 * GET /api/article/{id} until the status leaves the pending set.
 */
async function runInPage(input: InPageInput): Promise<InPageOutcome> {
  const PENDING = new Set(["queued", "pending", "processing", "running", "in_progress"]);

  const postRes = await fetch("/api/article", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input.body),
  });
  if (!postRes.ok) {
    const text = await postRes.text().catch(() => "");
    return { error: "POST /api/article failed", status: postRes.status, snippet: text.slice(0, 300) };
  }

  const created = (await postRes.json()) as Record<string, unknown>;
  const id = typeof created.id === "string" ? created.id : undefined;
  if (!id) {
    return { error: "POST /api/article returned no article id", created };
  }
  if (!input.timeoutMs || input.timeoutMs <= 0) {
    return { created, article: created, id };
  }

  const started = Date.now();
  let article: Record<string, unknown> = created;
  for (;;) {
    const res = await fetch(`/api/article/${id}`, { headers: { accept: "application/json" } });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        error: `GET /api/article/${id} failed`,
        status: res.status,
        snippet: text.slice(0, 300),
        id,
        created,
      };
    }
    article = (await res.json()) as Record<string, unknown>;
    const status = String(article.status ?? "").toLowerCase();
    if (status.length > 0 && !PENDING.has(status)) {
      return { created, article, id };
    }
    if (Date.now() - started > input.timeoutMs) {
      return { error: "timed out waiting for article completion", id, created, article };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, input.pollIntervalMs || 1500));
  }
}

/**
 * Submit an ask through a real browser attached over CDP. Throws BrowserAskError
 * with an actionable message when the browser is unreachable or still blocked.
 */
export async function submitAskViaBrowser(opts: BrowserAskOptions): Promise<BrowserAskResult> {
  const log = opts.log ?? (() => {});

  let chromium: typeof import("playwright-core")["chromium"];
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    throw new BrowserAskError(
      "playwright-core is not installed. Run `npm install playwright-core` to enable the browser ask path.",
    );
  }

  const launchHint =
    `Launch a CDP-enabled browser first, e.g.:\n` +
    `  open -a "Brave Browser" --args --remote-debugging-port=9222\n` +
    `(use a profile that's logged into OpenEvidence), or set OE_MCP_CDP_URL.`;

  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(opts.cdpUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BrowserAskError(
      `Could not connect to a browser over CDP at ${opts.cdpUrl}: ${message}\n${launchHint}`,
    );
  }

  let page: Page | undefined;
  try {
    const context = browser.contexts()[0];
    if (!context) {
      throw new BrowserAskError(
        `CDP browser at ${opts.cdpUrl} exposed no contexts. Open a normal browser window first.`,
      );
    }

    // Open a fresh page in the *existing* (authenticated) context so it shares
    // the OpenEvidence session + DataDome cookie, then land on /ask so the
    // DataDome JS tag initializes and relative fetches resolve to the OE origin.
    page = await context.newPage();
    const askUrl = new URL("/ask", opts.webOrigin).toString();
    log(`navigating to ${askUrl}`);
    await page.goto(askUrl, { waitUntil: "domcontentloaded" });
    // Give DataDome's client tag a moment to initialize before the POST.
    await page.waitForTimeout(1500);

    log("submitting question via in-page fetch");
    const result = (await page.evaluate(runInPage, {
      body: opts.body,
      pollIntervalMs: opts.poll?.intervalMs ?? 0,
      timeoutMs: opts.poll?.timeoutMs ?? 0,
    })) as InPageOutcome;

    if (result.error || !result.created) {
      const detail = result.status ? ` (HTTP ${result.status})` : "";
      const snippet = result.snippet ? `\n${result.snippet}` : "";
      const ddHint =
        result.status === 403
          ? `\nEven the in-browser request was 403: the OpenEvidence session / DataDome` +
            ` cookie in this browser profile is stale. Log in and ask one question` +
            ` manually in that browser window, then retry.`
          : "";
      throw new BrowserAskError(`${result.error ?? "browser ask failed"}${detail}${snippet}${ddHint}`);
    }

    return { created: result.created, article: result.article ?? result.created };
  } finally {
    // Close only the page we created — never the user's browser/context.
    if (page) {
      await page.close().catch(() => {});
    }
    // Detach from CDP without killing the user's browser.
    await browser.close().catch(() => {});
  }
}
