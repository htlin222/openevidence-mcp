# Relay observability + self-diagnosis — design

Date: 2026-09-25 · Branch: `fix/relay-observability` · Plan: `2026-09-25-relay-observability.md`

## Incident that motivated this

The relay looked dead for two weeks. `relay-8780.log` showed only `listening → reap:idle` cycles, `/health` said `connected:false`, and nobody could tell whether the extension was absent or being refused. Two stacked causes:

1. **Stale service worker.** `make extension` rebuilt `extension/dist` to 0.4.0 (v2 protocol), but Brave kept the 0.3.0 service worker it had registered — MV3 caches the SW script at registration; changing files on disk does nothing until Reload. The old worker polled without the v2 capability header and was refused.
2. **Wrong assumption in v2.** After Reload, the 0.4.0 worker was *still* refused: relay-server required a `chrome-extension://` `Origin` header, but Chromium omits `Origin` on fetches an extension makes to hosts it holds `host_permissions` for (`sec-fetch-site: none`). Unit tests only ever used fake clients that set `Origin`. Fixed in commit `10f731c`.

Both failures were silent on every surface: the daemon logs nothing on 403, the badge shows the same grey for "unreachable" and "rejected", `oe_health` could only say "extension is not polling".

## Goals

- A refused extension is visible in the daemon log (rate-limited), on `/health`, in `oe_health`, in `doctor`, and on the toolbar badge.
- The most common cause (stale service worker after a rebuild) is named explicitly, with the exact action ("Reload in brave://extensions").
- Tooling that kills processes by port only ever targets the LISTEN socket.

## Non-goals

- Auto-reloading the extension (Chrome offers no API for unpacked reload from outside).
- Changing the pairing/lease model or the capability header.
- Logging every rejected request (rate-limit per reason to one line a minute).

## Components

| Layer | Change |
| --- | --- |
| `src/relay-server.ts` | `reject()` helper counts + timestamps rejections, logs once/min per reason; `/health` adds `rejected`, `lastRejectAt`, `lastRejectPath`, `lastRejectReason`, `extensionVersion`; new optional header `x-openevidence-relay-extension`. |
| `src/relay-diagnosis.ts` (new, pure) | `diagnoseRelay(health, {distVersion, now}) → {state, hint}` with states `down / connected / stale-extension / rejected / silent`. |
| `src/server.ts` `oe_health` | Emits `diagnosis`, `hint`, `extension_version`, `extension_dist_version`, `relay_rejected`, `last_reject_*`. |
| `src/doctor.ts` | New check `relay-extension` built on the same function. |
| `extension/src/background.ts` | Sends manifest version; 403/409 → orange "rejected" badge with reason + activity row; 5 s backoff when rejected. |
| `extension/readme.js` | Status page prints the last rejection and the Reload instruction. |
| `Makefile` | `lsof … -sTCP:LISTEN` in `kill-all`/`reap`; `make extension` prints the Reload reminder. |

## Data flow

extension poll → relay-server: accepted → lease + `extensionVersion`; refused → `reject()` → counters + log → `/health` → `fetchRelayHealth` → `diagnoseRelay` → `oe_health` / `doctor` hint. Extension side: 403 → `RelayRejectedError` → badge + activity feed.

## Testing

- relay-server: rejection counters/paths/reasons on `/health`; rate-limited logger using the injected `now`; version header surfaced.
- relay-diagnosis: one test per state, plus "unknown versions never trigger stale".
- Extension and Makefile: manual verification steps in the plan (Task 5/6).

## Addendum: cross-agent ask queue in the daemon

**Problem.** Every Claude session runs its own MCP server, and all of them funnel through one daemon and one browser tab. Today the daemon hands requests to the extension strictly FIFO with no spacing: two agents asking at once produce back-to-back `POST /api/article`, and N agents polling `GET /api/article/<id>` produce N× the poll rate through a single DataDome-watched tab. The existing `reserveAsk` DB pacing only spaces *submissions* per account; it does not see polls and cannot see what is actually in flight.

**Design.** The daemon becomes the single scheduler (`src/relay-server.ts` `flush()`):

- **Ask lane** — `POST /api/article` is serialized: at most one ask in flight (delivered, no `/result` yet), and the next ask is dispatched no earlier than `lastAskDoneAt + askSpacingMs` (default `OE_MCP_ASK_MIN_INTERVAL_MS`, 1000 ms). Asks keep FIFO order among themselves.
- **Global gap** — any two deliveries to the extension are at least `minGapMs` apart (default 250 ms, env `OE_MCP_RELAY_MIN_GAP_MS`), so five sessions polling at 1.5 s cannot exceed ~4 req/s through the tab.
- Non-ask requests are never blocked behind an in-flight ask; they only respect the global gap.
- Timers: when nothing is eligible yet, `flush()` arms one re-flush timer for the earliest eligibility time; `/poll` no longer bypasses the scheduler.
- `/health` adds `askWaiting`, `askInFlight`, `lastAskAt`; `oe_health` surfaces `ask_queue_waiting`.
- Timeouts are unchanged: a queued ask still counts its `timeoutMs` from submission, so an agent that waits too long gets the existing "extension did not respond" error rather than a silent stall.

**Not doing:** collapsing identical polls from different sessions; priority classes; per-account lanes (one tab = one account by construction).
