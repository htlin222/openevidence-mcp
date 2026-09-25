// dotenv first: when launched by hand (npm run relay) from the repo, .env must
// yield the same OE_MCP_RELAY_PORT the MCP server and the extension use —
// otherwise the daemon binds a port nobody talks to. (When spawned by the
// server, the env is inherited and this import is a no-op.)
import "dotenv/config";

import { readFileSync, unlinkSync, writeFileSync } from "node:fs";

import { ensureConfigDirs, resolveConfig } from "./config.js";
import { evaluateReap } from "./relay-reaper.js";
import { RELAY_VERSION, startRelayServer, type RelayServer } from "./relay-server.js";

/**
 * Standalone relay daemon. Owns the relay port and outlives every Claude session
 * so any number of MCP servers can funnel requests through the one browser tab
 * (see relay-client.ts). Idempotent: if the port is already held (another daemon
 * won the race) it logs and exits 0.
 *
 * Self-reaping: once bound, a daemon would otherwise live forever (nothing sends
 * it SIGTERM). A watchdog ticks {@link evaluateReap} so it exits when superseded
 * by a newer daemon or left idle past the TTL — that is the garbage collection
 * that keeps orphaned daemons from piling up. See relay-reaper.ts.
 */

const WATCHDOG_INTERVAL_MS = 30_000;

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function idleTtlMs(): number {
  return envMs("OE_MCP_RELAY_IDLE_TTL_MS", 600_000); // 10 min: long enough to survive a tab reload
}

/** Pid recorded in the pidfile and whether it refers to a live *other* process. */
function pidfileState(pidPath: string): { pid: number | null; alive: boolean } {
  let pid: number | null = null;
  try {
    const parsed = parseInt(readFileSync(pidPath, "utf8").trim(), 10);
    pid = Number.isInteger(parsed) ? parsed : null;
  } catch {
    pid = null;
  }
  let alive = false;
  if (pid !== null && pid !== process.pid) {
    try {
      process.kill(pid, 0); // signal 0 = liveness probe, kills nothing
      alive = true;
    } catch {
      alive = false; // ESRCH (gone) or EPERM (alive but not ours) — treat as not-superseding
    }
  }
  return { pid, alive };
}

async function main(): Promise<void> {
  const config = resolveConfig();
  ensureConfigDirs(config);

  // Cross-session pacing lives here, not in each MCP server: the daemon is the
  // only process that sees every session's traffic through the one tab.
  const askSpacingMs = envMs("OE_MCP_ASK_MIN_INTERVAL_MS", 1000);
  const minGapMs = envMs("OE_MCP_RELAY_MIN_GAP_MS", 250);

  let server: RelayServer;
  try {
    server = await startRelayServer({
      port: config.relayPort,
      logger: (m) => console.error(`[relay-daemon] ${m}`),
      askSpacingMs,
      minGapMs,
    });
  } catch (err) {
    // Lost the bind race (EADDRINUSE) — another daemon already owns the port.
    console.error(`[relay-daemon] not starting: ${String(err)}`);
    process.exit(0);
  }

  try {
    writeFileSync(config.relayPidPath, String(process.pid));
  } catch (err) {
    console.error(`[relay-daemon] could not write pidfile: ${String(err)}`);
  }
  console.error(
    `[relay-daemon] listening on :${config.relayPort} v${RELAY_VERSION} pid ${process.pid} ` +
      `askSpacing=${askSpacingMs}ms gap=${minGapMs}ms`,
  );

  let shuttingDown = false;
  let watchdog: ReturnType<typeof setInterval> | null = null;

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (watchdog) clearInterval(watchdog);
    console.error(`[relay-daemon] ${signal} — shutting down`);
    try {
      // Only remove the pidfile if it is still *ours* — never clobber a newer
      // daemon's registration when stepping aside after being superseded.
      const onDisk = parseInt(readFileSync(config.relayPidPath, "utf8").trim(), 10);
      if (onDisk === process.pid) unlinkSync(config.relayPidPath);
    } catch {
      /* nothing to clean up */
    }
    server.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Garbage collection: self-terminate when superseded or idle past the TTL.
  const ttl = idleTtlMs();
  let idleSince: number | null = null;
  watchdog = setInterval(() => {
    const { pid, alive } = pidfileState(config.relayPidPath);
    const decision = evaluateReap({
      connected: server.isConnected(),
      pending: server.pending(),
      now: Date.now(),
      idleSince,
      idleTtlMs: ttl,
      pidfilePid: pid,
      pidfileAlive: alive,
      myPid: process.pid,
    });
    idleSince = decision.idleSince;
    if (decision.reap) shutdown(`reap:${decision.reason}`);
  }, WATCHDOG_INTERVAL_MS);
  watchdog.unref(); // never keep the process alive on the watchdog's account
}

void main();
