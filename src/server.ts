#!/usr/bin/env node
import "dotenv/config";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { saveArticleArtifacts } from "./citations.js";
import { ensureConfigDirs, resolveConfig } from "./config.js";
import { extractAnswerText, OpenEvidenceClient } from "./openevidence-client.js";
import type { OpenEvidenceAskRequest } from "./types.js";

const config = resolveConfig();
ensureConfigDirs(config);

const server = new McpServer({
  name: "openevidence-mcp",
  version: "1.0.0",
});

server.registerTool(
  "oe_auth_status",
  {
    title: "OpenEvidence Auth Status",
    description: "Check if the local OpenEvidence session is valid.",
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
      const data = await client.listHistory(args.limit ?? 20, args.offset ?? 0, args.search);
      return ok(data);
    }),
);

server.registerTool(
  "oe_article_get",
  {
    title: "OpenEvidence Article Get",
    description: "Fetch article payload by article id.",
    inputSchema: z.object({
      article_id: z.string().uuid(),
      save_artifacts: z.boolean().default(true).optional(),
      crossref_validate: z.boolean().default(true).optional(),
      include_bibtex: z.boolean().default(true).optional(),
    }),
  },
  async (args) =>
    withClient(async (client) => {
      const article = await client.getArticle(args.article_id);
      const artifacts =
        args.save_artifacts ?? true
          ? await saveArticleArtifacts(article, config, {
              validateWithCrossref: args.crossref_validate ?? config.crossrefValidate,
            })
          : null;
      return ok({
        article,
        extracted_answer_raw: extractAnswerText(article),
        artifacts: formatArtifactsForResponse(artifacts, args.include_bibtex ?? true),
      });
    }),
);

server.registerTool(
  "oe_ask",
  {
    title: "OpenEvidence Ask",
    description:
      "Create a question and optionally wait for completion. For follow-up question pass original_article_id.",
    inputSchema: z.object({
      question: z.string().min(3).max(6000),
      original_article_id: z.string().uuid().optional(),
      wait_for_completion: z.boolean().default(true).optional(),
      timeout_sec: z.number().int().min(5).max(600).default(120).optional(),
      poll_interval_ms: z.number().int().min(300).max(10000).default(1200).optional(),
      disable_caching: z.boolean().default(false).optional(),
      personalization_enabled: z.boolean().default(false).optional(),
      article_type: z.string().default("Ask OpenEvidence Light with citations").optional(),
      variant_configuration_file: z.string().default("prod").optional(),
      save_artifacts: z.boolean().default(true).optional(),
      crossref_validate: z.boolean().default(true).optional(),
      include_bibtex: z.boolean().default(true).optional(),
    }),
  },
  async (args) =>
    withClient(async (client) => {
      const askPayload: OpenEvidenceAskRequest = {
        question: args.question,
        originalArticleId: args.original_article_id,
        disableCaching: args.disable_caching ?? false,
        personalizationEnabled: args.personalization_enabled ?? false,
        articleType: args.article_type,
        variantConfigurationFile: args.variant_configuration_file,
      };

      const created = await client.ask(askPayload);
      const articleId = String(created.id ?? "");
      if (!articleId) {
        return fail("OpenEvidence returned no article id.");
      }

      const waitForCompletion = args.wait_for_completion ?? true;
      if (!waitForCompletion) {
        return ok({
          created,
          article_id: articleId,
          note: "Article created. Poll with oe_article_get.",
        });
      }

      const article = await client.waitForArticle(articleId, {
        timeoutMs: (args.timeout_sec ?? 120) * 1000,
        intervalMs: args.poll_interval_ms ?? config.pollIntervalMs,
      });
      const artifacts =
        args.save_artifacts ?? true
          ? await saveArticleArtifacts(article, config, {
              validateWithCrossref: args.crossref_validate ?? config.crossrefValidate,
            })
          : null;

      return ok({
        created,
        article,
        article_id: articleId,
        extracted_answer_raw: extractAnswerText(article),
        artifacts: formatArtifactsForResponse(artifacts, args.include_bibtex ?? true),
      });
    }),
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
  fn: (client: OpenEvidenceClient) => Promise<{
    content: { type: "text"; text: string }[];
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  }>,
) {
  const client = new OpenEvidenceClient(config);
  try {
    await client.init();
    const auth = await client.getAuthStatus();
    if (!auth.authenticated) {
      return fail(
        `Session is not authenticated (status ${auth.statusCode}). Paste fresh browser cookies into ${config.cookiesPath} and run: npm run login`,
      );
    }
    return await fn(client);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(message);
  } finally {
    await client.close();
  }
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
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[openevidence-mcp] fatal: ${message}\n`);
  process.exit(1);
});
