/**
 * Turn a relay `/health` payload into one actionable diagnosis. Pure, so
 * oe_health (server.ts) and `doctor` share the exact same wording.
 */
import { readFileSync } from "node:fs";

export type RelayState = "down" | "connected" | "stale-extension" | "rejected" | "silent";

export interface RelayDiagnosis {
  state: RelayState;
  hint: string | null;
}

export interface RelayHealthLike {
  connected?: unknown;
  extensionVersion?: unknown;
  lastRejectAt?: unknown;
  lastRejectReason?: unknown;
  lastRejectPath?: unknown;
}

/** A rejection older than this is history, not the reason the extension is absent now. */
const RECENT_REJECT_MS = 60_000;
/** Only rejections on the extension's own endpoints mean the extension is being refused. */
const EXTENSION_PATHS = new Set(["/poll", "/result"]);
const RELOAD = "reload the unpacked extension in brave://extensions (or chrome://extensions)";

export function diagnoseRelay(
  h: RelayHealthLike | null,
  ctx: { distVersion: string | null; now: number },
): RelayDiagnosis {
  if (!h) {
    return {
      state: "down",
      hint: "Relay daemon is not answering on this port. It respawns on the next oe_ask, or run `make doctor` to diagnose.",
    };
  }
  const extVersion = typeof h.extensionVersion === "string" ? h.extensionVersion : null;
  if (h.connected === true) {
    if (extVersion && ctx.distVersion && extVersion !== ctx.distVersion) {
      return {
        state: "stale-extension",
        hint: `Browser is running extension v${extVersion} but extension/dist is v${ctx.distVersion} — ${RELOAD}.`,
      };
    }
    return { state: "connected", hint: null };
  }
  const rejectAt = typeof h.lastRejectAt === "number" ? h.lastRejectAt : null;
  const path = typeof h.lastRejectPath === "string" ? h.lastRejectPath : null;
  const age = rejectAt !== null ? ctx.now - rejectAt : -1;
  if (path !== null && EXTENSION_PATHS.has(path) && age >= 0 && age <= RECENT_REJECT_MS) {
    const reason = typeof h.lastRejectReason === "string" ? h.lastRejectReason : "unknown reason";
    return {
      state: "rejected",
      hint: `The extension IS polling but the relay rejects it (${path}: ${reason}). Usually a stale service worker after a rebuild — Reload: ${RELOAD}.`,
    };
  }
  return {
    state: "silent",
    hint: "The extension is not polling the relay — is the browser running with the extension loaded from extension/dist?",
  };
}

/** Version string in extension/dist/manifest.json, or null when not built. */
export function readExtensionDistVersion(manifestPath: string): string | null {
  try {
    const m = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown };
    return typeof m.version === "string" ? m.version : null;
  } catch {
    return null;
  }
}
