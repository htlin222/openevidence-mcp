// Live relay connection check for README.html. Talks to the local relay's
// /health endpoint (host permission for 127.0.0.1 is granted in the manifest).
// __RELAY_PORT__ is replaced with the real port at build time.
//
// On failure this page is the first thing a user looks at, so it must say
// exactly WHAT failed and WHAT to do — not just "not reachable". It also
// auto-retries every 3s until green, so fixing the cause flips the badge
// without any clicking.
const PORT = "__RELAY_PORT__";
const HEALTH = `http://127.0.0.1:${PORT}/health`;
const RETRY_MS = 3000;

const statusEl = document.getElementById("status");
const detailEl = document.getElementById("detail");
const btnEl = document.getElementById("check");
const debugEl = document.getElementById("debug");
const debugLogEl = document.getElementById("debuglog");

let timer = null;
let attempts = 0;

function set(cls, text, detail) {
  statusEl.className = "badge " + cls;
  statusEl.innerHTML = '<span class="dot"></span>' + text;
  detailEl.textContent = detail || "";
}

function showDebug(lines) {
  if (!debugEl || !debugLogEl) return;
  debugEl.style.display = "";
  const stamp = new Date().toLocaleTimeString();
  debugLogEl.textContent = `[${stamp}] attempt ${attempts}\n` + lines.join("\n");
}

function hideDebug() {
  if (debugEl) debugEl.style.display = "none";
}

function scheduleRetry() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(check, RETRY_MS);
}

function fmtAgo(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const hours = Math.floor(m / 60);
  return `${hours}h ${m % 60}m`;
}

// One live status line for the green badge: what the relay has done and is doing.
function liveStats(h) {
  const parts = [];
  if (h.version != null) parts.push(`relay v${h.version} · pid ${h.pid}`);
  if (typeof h.startedAt === "number") parts.push(`up ${fmtAgo(Date.now() - h.startedAt)}`);
  if (typeof h.served === "number") {
    parts.push(`${h.served} request${h.served === 1 ? "" : "s"} served`);
    if (h.errored > 0) parts.push(`${h.errored} failed`);
  }
  if (typeof h.lastActivityAt === "number" && h.lastActivityAt > 0 && !(h.pending > 0)) {
    parts.push(`last activity ${fmtAgo(Date.now() - h.lastActivityAt)} ago`);
  }
  return parts.join(" · ");
}

async function check() {
  attempts += 1;
  set("wait", "Checking relay…", "");
  let res;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const relayHeaders = await chrome.runtime.sendMessage({ type: "oe-relay-client-headers" });
    res = await fetch(HEALTH, {
      signal: ctrl.signal,
      headers: relayHeaders,
    });
    clearTimeout(t);
  } catch (e) {
    const timedOut = e && e.name === "AbortError";
    set(
      "bad",
      timedOut ? "Relay timed out" : "Relay not reachable",
      `Nothing answered on 127.0.0.1:${PORT} — retrying every ${RETRY_MS / 1000}s.`,
    );
    showDebug([
      `GET ${HEALTH}`,
      `-> ${timedOut ? "timed out after 1.5s" : String(e)}`,
      "",
      "Most likely: no relay daemon is running on this port. Fix it with ONE of:",
      "  • run any OpenEvidence tool from your AI session (the MCP server auto-spawns the daemon)",
      "  • openevidence-mcp repo: node dist/relay-daemon.js   (or: npm run relay)",
      "",
      "If a daemon IS running, its port may differ from this page's:",
      `  • this extension was built for port ${PORT}`,
      "  • the daemon uses OE_MCP_RELAY_PORT from your MCP config (default 8787)",
      `  • if they differ: cd extension && OE_MCP_RELAY_PORT=<port> npm run build,`,
      "    then reload the extension (chrome://extensions or brave://extensions)",
      "",
      "npm run doctor -- --offline also checks the port sync for you.",
    ]);
    scheduleRetry();
    return;
  }

  let h = null;
  let rawBody = "";
  try {
    rawBody = await res.text();
    h = JSON.parse(rawBody);
  } catch {
    // fall through with h === null
  }

  if (!res.ok || !h || typeof h !== "object" || h.ok !== true) {
    set(
      "bad",
      "Port is not the relay",
      `Something else answers on 127.0.0.1:${PORT} — is another dev server using this port?`,
    );
    showDebug([
      `GET ${HEALTH}`,
      `-> HTTP ${res.status}`,
      `-> body: ${rawBody.slice(0, 200) || "(empty)"}`,
      "",
      "A different program (e.g. wrangler dev, a web app) is squatting this port.",
      "Either stop it, or move the relay: set OE_MCP_RELAY_PORT=<free port> in your MCP",
      `config AND rebuild this extension with the same value.`,
    ]);
    scheduleRetry();
    return;
  }

  if (h.connected) {
    const busy = typeof h.pending === "number" && h.pending > 0;
    set(
      "ok",
      busy ? `Connected · ${h.pending} in flight` : "Connected",
      liveStats(h),
    );
    hideDebug();
    scheduleRetry(); // keep monitoring — the badge stays live
    return;
  }

  // Daemon up, but no extension service worker is long-polling it.
  set(
    "bad",
    "Extension not attached",
    "The relay daemon is up, but this extension is not polling it yet.",
  );
  showDebug([
    `GET ${HEALTH}`,
    `-> ok, daemon pid ${h.pid ?? "?"}, version ${h.version ?? "(old build)"} — but connected:false`,
    "",
    "The extension's background worker is not connected. Usually one of:",
    "  • the worker just woke up — wait a few seconds (this page retries automatically)",
    "  • the extension was rebuilt — reload it (chrome://extensions or brave://extensions → ↻)",
    "  • the extension is loaded in ANOTHER browser that is polling a different port",
    "  • an old relay build — restart your MCP session so it spawns a fresh daemon",
  ]);
  scheduleRetry();
}

btnEl.addEventListener("click", check);
check();

// ---- live activity feed -------------------------------------------------------
// The background worker records each relayed request into chrome.storage.local
// (this page is an extension page, so storage is readable here). We render it and
// live-update via storage.onChanged — no polling.
const ACTIVITY_KEY = "oeRelayActivity";
const activityEl = document.getElementById("activity");
const clearBtn = document.getElementById("clearlog");
const EMPTY =
  '<li class="muted">No activity yet — ask OpenEvidence from your AI tool and watch it appear here.</li>';

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
}

function fmtClock(t) {
  try {
    return new Date(t).toLocaleTimeString();
  } catch {
    return "";
  }
}

function renderActivity(log) {
  if (!activityEl) return;
  if (!Array.isArray(log) || log.length === 0) {
    activityEl.innerHTML = EMPTY;
    return;
  }
  // Newest first.
  activityEl.innerHTML = log
    .slice()
    .reverse()
    .map((e) => {
      const done = e.phase === "done";
      const label = escapeHtml(e.label || "") + (e.count > 1 ? ` <span class="meta">×${e.count}</span>` : "");
      const dur = done && typeof e.ms === "number" ? ` · ${(e.ms / 1000).toFixed(1)}s` : "";
      const st = !done
        ? '<span class="spin">●</span>'
        : e.ok
          ? `<span class="pill okp">${e.status}</span>`
          : `<span class="pill errp">${e.status || "fail"}</span>`;
      return (
        `<li class="${done ? "" : "live"}">` +
        `<span class="ic">${escapeHtml(e.icon || "•")}</span>` +
        `<span class="lbl">${label}</span>` +
        `<span class="meta">${fmtClock(e.t)}${dur}</span>` +
        `<span class="st">${st}</span>` +
        `</li>`
      );
    })
    .join("");
}

async function loadActivity() {
  try {
    const store = await chrome.storage.local.get(ACTIVITY_KEY);
    renderActivity(store[ACTIVITY_KEY]);
  } catch {
    /* storage unavailable (e.g. opened outside the extension) */
  }
}

if (clearBtn) {
  clearBtn.addEventListener("click", async () => {
    try {
      await chrome.storage.local.remove(ACTIVITY_KEY);
    } catch {
      /* ignore */
    }
    renderActivity([]);
  });
}

if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[ACTIVITY_KEY]) {
      renderActivity(changes[ACTIVITY_KEY].newValue);
    }
  });
}

loadActivity();
