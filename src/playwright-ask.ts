#!/usr/bin/env node
/**
 * Standalone CLI for the DataDome-passing, browser-backed ask.
 *
 * The MCP server uses this same path automatically as a fallback when
 * POST /api/article hits DataDome (see openevidence-client.ts → askViaBrowser).
 * This CLI is for ad-hoc use and debugging; it drives the ask end-to-end
 * (submit + poll to completion) and prints the answer.
 *
 * Prereq: a browser running with CDP enabled on a profile logged into
 * OpenEvidence. On macOS:
 *   open -a "Brave Browser" --args --remote-debugging-port=9222
 *   # or: make brave-cdp
 *
 * Usage:
 *   npm run pw-ask -- --question "..." [--cdp http://localhost:9222]
 *                     [--type "Ask OpenEvidence Light with citations"]
 *                     [--origin https://www.openevidence.com]
 *                     [--timeout 300] [--poll-ms 1500] [--json]
 */
import { stderr, stdout } from "node:process";

import { submitAskViaBrowser } from "./browser-ask.js";
import {
  buildAskRequestBody,
  extractAnswerText,
  extractFiguresFromText,
  resolveVisualTags,
} from "./openevidence-client.js";

const DEFAULT_CDP_URL = "http://localhost:9222";
const DEFAULT_WEB_ORIGIN = "https://www.openevidence.com";
const DEFAULT_ARTICLE_TYPE = "Ask OpenEvidence Light with citations";

async function main(): Promise<void> {
  const question = getArgValue("--question");
  if (!question) {
    throw new Error(
      'Usage: npm run pw-ask -- --question "..." [--cdp URL] [--type "..."] ' +
        "[--origin URL] [--timeout 300] [--poll-ms 1500] [--json]",
    );
  }

  const cdpUrl = getArgValue("--cdp") ?? process.env.OE_MCP_CDP_URL ?? DEFAULT_CDP_URL;
  const webOrigin = getArgValue("--origin") ?? process.env.OE_MCP_WEB_ORIGIN ?? DEFAULT_WEB_ORIGIN;
  const articleType = getArgValue("--type") ?? DEFAULT_ARTICLE_TYPE;
  const timeoutSec = Number.parseInt(getArgValue("--timeout") ?? "300", 10);
  const pollMs = Number.parseInt(getArgValue("--poll-ms") ?? "1500", 10);
  const asJson = process.argv.includes("--json");

  const body = buildAskRequestBody({
    question,
    articleType,
    variantConfigurationFile: getArgValue("--variant") ?? "prod",
    originalArticleId: getArgValue("--original-article-id"),
  });

  const { article } = await submitAskViaBrowser({
    cdpUrl,
    webOrigin,
    body,
    poll: { intervalMs: pollMs, timeoutMs: timeoutSec * 1000 },
    log: (message) => stderr.write(`[pw-ask] ${message}\n`),
  });

  if (asJson) {
    stdout.write(`${JSON.stringify(article, null, 2)}\n`);
    return;
  }

  const rawText = extractAnswerText(article);
  const figures = rawText ? extractFiguresFromText(rawText) : [];
  const answer = rawText ? resolveVisualTags(rawText, figures) : null;

  stdout.write(`[pw-ask] article id: ${String(article.id ?? "unknown")}\n`);
  stdout.write(`[pw-ask] status: ${String(article.status ?? "unknown")}\n\n`);
  stdout.write(answer ?? "[pw-ask] no answer text could be extracted (use --json to inspect).\n");
  stdout.write("\n");
}

function getArgValue(flag: string): string | undefined {
  const idx = process.argv.findIndex((value) => value === flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(`[pw-ask] failed: ${message}\n`);
  process.exit(1);
});
