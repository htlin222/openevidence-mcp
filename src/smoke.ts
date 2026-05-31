#!/usr/bin/env node
import "dotenv/config";

import { ensureConfigDirs, resolveConfig } from "./config.js";
import { DataDomeChallengeError, OpenEvidenceClient } from "./openevidence-client.js";

async function main() {
  const config = resolveConfig();
  ensureConfigDirs(config);
  const client = new OpenEvidenceClient(config);

  try {
    await client.init();

    // Stage 1: auth check (hits /api/auth/me, sits behind the login session).
    const auth = await client.getAuthStatus();
    if (!auth.authenticated) {
      report({ ok: false, stage: "auth", authenticated: false, statusCode: auth.statusCode });
      process.exit(1);
    }

    // Stage 2: a data endpoint that lives behind the DataDome bot layer.
    // This is the part that tells us whether the MCP can actually do work.
    try {
      const history = await client.listHistory(3, 0);
      report({
        ok: true,
        authenticated: true,
        endpoint_reachable: true,
        user: { email: auth.user?.email, name: auth.user?.name },
        history_preview: history,
      });
    } catch (error) {
      if (error instanceof DataDomeChallengeError) {
        report({
          ok: false,
          authenticated: true,
          endpoint_reachable: false,
          blocked_by: "datadome",
          user: { email: auth.user?.email, name: auth.user?.name },
          message: error.message,
          remedy:
            "Re-authenticate in a real browser, solve the DataDome challenge, then refresh cookies.json.",
        });
        process.exit(2);
      }
      throw error;
    }
  } finally {
    await client.close();
  }
}

function report(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[smoke] failed: ${message}\n`);
  process.exit(1);
});
