# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.4.4] - 2026-07-23

### Changed
- **Maintenance release — publishes the accumulated 0.4.x work to npm.** No
  functional changes over 0.4.3; the npm registry had lagged at 0.2.1, so this
  bump ships the current server (including `oe_article_set_access`, the
  byte-for-byte `oe_ask` payload, and the local answer store) to the published
  package.

## [0.4.3] - 2026-07-13

### Added
- **`oe_article_set_access` — toggle a conversation's share visibility.**
  `public:true` makes a conversation link-shareable (`ANYONE_WITH_LINK` —
  anyone with the `/ask/<id>` URL can read it, no login); `public:false`
  reverts it to private (`CREATOR_ONLY`). Wraps `PATCH /api/article/<id>/access`
  through the relay (only the owning browser session may change access) with a
  body captured byte-for-byte from the site's Share dialog (2026-07-13); returns
  the shareable URL. The tool description warns against publishing PHI or
  medically sensitive patient information.
- **`OpenEvidenceClient.setArticleAccess` + a `PATCH` JSON helper** underpin the
  new tool.

## [0.4.2] - 2026-07-13

### Changed
- **`oe_ask` now submits a payload byte-identical to the official frontend.**
  A live CDP capture (2026-07-13) of the site's `POST /api/article` showed
  three drifts, all fixed in `buildAskBody`: the request now carries
  `inputs.component_config_version: "stable"`, omits `disable_caching`
  entirely unless explicitly set to `true` (the browser never sends it), and
  orders `original_article` before `personalization_enabled` so the serialized
  body matches the captured follow-up request byte-for-byte. The same capture
  confirmed the follow-up mechanism end-to-end: the frontend passes only
  `original_article` (no inline history) and the server assembles
  `inputs.history` itself — exactly what `oe_ask`'s `original_article_id`
  already does.

## [0.4.1] - 2026-07-12

### Added
- **Question pacing to respect the per-account hourly ask limit.** Only `oe_ask`
  (a new question or a follow-up) spends OpenEvidence's question budget; every
  other tool is free of it. `oe_ask` now paces submissions — it *waits* (never
  errors) so consecutive asks are at least `OE_MCP_ASK_MIN_INTERVAL_MS` apart
  (default 1000 ms ≈ 1 question/second), coordinated across all MCP sessions via
  a shared `ask_log` table in the SQLite store so multiple windows can't
  collectively exceed the rate. Each `oe_ask` reply carries
  `ask_pacing: { waited_ms, asks_last_hour }`, and `oe_health` surfaces
  `asks_last_hour` + `ask_min_interval_ms` for at-a-glance quota visibility. Set
  `OE_MCP_ASK_MIN_INTERVAL_MS=0` to disable. (The cheapest saver remains not
  re-asking: `oe_answers_search` + the `oe_article_get` cache cost zero
  questions.)
- **Lifecycle Make targets + an install skill.** New `make update` (git pull +
  rebuild + re-register), `make uninstall` (unregister from the CLIs, stop
  daemons, remove builds — keeps `~/.openevidence-mcp` and the browser
  extension), `make status` (versions + live relay health + registration), and
  `make cleanup` (reap orphan daemons, prune stale logs/temp — non-destructive,
  relay respawns on next use). A bundled Claude Code skill
  (`.claude/skills/install/`) wraps these behind a portable `oe-mcp.sh`
  dispatcher (`install` / `update` / `cleanup` / `uninstall` / `status`) so
  "update openevidence-mcp" in an AI session does the right thing and reminds you
  to reload the extension.

## [0.4.0] - 2026-07-12

### Added
- **Follow-up questions surfaced + threaded conversations.** `oe_ask` and
  `oe_article_get` now return **`follow_up_questions`** — the suggestions
  OpenEvidence renders under an answer (from
  `output.structured_article.follow_up_questions`), plus a `follow_up_hint`.
  To continue the same conversation, pass any of them (or your own) back as
  `oe_ask({ question, original_article_id })`: OpenEvidence rebuilds the
  conversation history server-side (you only send `original_article` + the new
  question), and the answer threads on the prior turn. The stored follow-ups are
  persisted in the answers table (`follow_up_json`) and returned on cache hits
  too. (The follow-up POST path already existed; this makes the suggestions
  visible and documents the threading.)
- **Local answer store — `oe_answers_search` + `oe_article_get` cache.** Every
  completed answer from `oe_ask` / `oe_article_get` is now upserted into an
  `answers` table in the shared SQLite file (`~/.openevidence-mcp/db/oe.sqlite`,
  `$OE_MCP_DB_PATH`), alongside the collections mirror. This unlocks two things:
  - **`oe_answers_search(query)`** — full-text search (SQLite FTS5) over the
    questions, titles, and answer bodies of everything this MCP has fetched.
    Fully offline: no OpenEvidence traffic, no rate-limit cost. Returns
    `bm25`-ranked hits with `»…«`-highlighted snippets and the `/ask/` URL.
    Query is FTS5 syntax (plain words ANDed, `"phrases"`, `AND`/`OR`/`NOT`);
    malformed queries fall back to a quoted-token literal search instead of
    erroring.
  - **`oe_article_get` cache hits** — an already-stored answer is served from
    disk with `from_cache: true` and **zero network round-trips** (it doesn't
    even touch the relay). Pass `refresh: true` to force a re-fetch and
    regenerate the on-disk citation artifacts.

  The store persists across reboots (unlike the OS-temp-dir artifacts), holds
  only answers this MCP fetched, and uses the built-in `node:sqlite` (Node ≥ 22,
  no new dependency). Writes are best-effort — a store failure never fails a
  tool call. New module `src/answers-db.ts`; keyed `(account, article_id)` on
  the login email so it joins the Python CLI's tables cleanly.
- **`oe_health` — millisecond-fast relay pipeline check.** Reads the relay
  daemon's `/health` locally (no OpenEvidence network call, unlike
  `oe_auth_status`) and reports whether the daemon is up, whether the browser
  extension is actually polling (`extension_connected`), the protocol-version
  match, uptime, and served/errored/pending counts. Each failure state carries
  a `hint`. Use it to confirm the plumbing before an ask or to diagnose a stuck
  relay; use `oe_auth_status` only when you need to verify the login session.
- **`oe_public_get` — read conversation pages by `/ask/` link.** Fetches an
  `https://www.openevidence.com/ask/<id>` page and parses it into Q&A turns:
  question, answer as clean markdown, references under a rebuilt
  `### References` heading. Auth escalates automatically: relay tab when
  connected (so **your own private conversations work**, DataDome-free) →
  anonymous fetch (public/shared conversations are fully server-rendered and
  need zero setup) → `cookies.json` (headless fallback for private pages).
  Page fetches run through the same rate limiter as API reads (60 clinical
  queries/min budget, self-throttled at 80%, burst-capped). Figure images
  survive with their captions (carried from the `Open figure` button's
  aria-label) and real URLs (the `/_next/image` proxy is resolved);
  status-stepper chrome, follow-up suggestions, and reference favicons are
  stripped; inline journal-name citation chips collapse to bare `[n]` markers
  that match the references list. Parsing anchors (`<article>`,
  `data-answer-end`, `ask--query-bar`) are ported from the battle-tested
  mcq-bank importer and verified against a saved-page fixture.
- **`strip_citation_markers` option** on `oe_ask`, `oe_article_get`, and
  `oe_public_get` — removes `[1]`, `[1-2]`, `[2,3]`, `[1–3]` reference marks
  (including markdown link targets like `[1](https://…)`) and the whitespace
  before them; non-numeric brackets like `[note]` survive. API tools return the
  cleaned text as `extracted_answer_clean` alongside the untouched raw answer.
- **`/ask/` URLs accepted everywhere an article id is.** `oe_article_get.article_id`
  and `oe_ask.original_article_id` now take a full conversation URL and extract
  the UUID themselves.
- **Shared relay daemon — many sessions, one tab.** The relay no longer runs
  in-process inside each MCP server (where only one session could bind port 8787;
  the rest silently failed with "relay not connected"). A standalone daemon
  (`src/relay-daemon.ts`, `npm run relay`) now owns the port and outlives every
  session; each MCP server connects as a client (`src/relay-client.ts`) via a new
  `POST /relay` bridge. The daemon is auto-spawned detached on first need,
  idempotent (a second daemon that loses the bind race exits 0), and self-healing
  (a crashed daemon is respawned + the in-flight request retried). `/health` now
  reports `version` + `pid`; a stale daemon from an older build is detected and
  replaced on upgrade. New env: `OE_MCP_RELAY_PID_PATH`, `OE_MCP_RELAY_LOG_PATH`
  (default `~/.openevidence-mcp/relay.pid` / `relay.log`).

### Changed
- **`oe_ask` is fire-and-forget by default.** It now returns
  `{article_id, status:"pending"}` immediately and frees the browser tab for other
  sessions; fetch the finished answer with `oe_article_get(article_id)` (which gained
  `wait_for_completion`/`timeout_sec`/`poll_interval_ms` and now reports `status`).
  Pass `oe_ask(..., wait_for_completion:true)` to keep the old one-shot blocking
  behavior. Concurrency works either way now that the relay is shared.
- **BREAKING:** `OE_MCP_RELAY_TRANSPORT=all` is now the **default**. The MCP server
  routes every request — `oe_ask` and all reads (`oe_history_list`,
  `oe_article_get`, `oe_collections_*`) — through the browser-extension relay and
  no longer falls back to `cookies.json`; when the extension isn't connected, tools
  fail fast with install guidance. Headless reads now require the extension — set
  `OE_MCP_RELAY_TRANSPORT=off` to restore the cookie read path. `cookies.json`
  remains the auth for the Python collections tooling and `npm run doctor` / `login`.
- `oe_ask` now submits via the shared client (`client.ask()`) over the relay rather
  than a bespoke relay call, so the POST and its follow-up reads share one browser
  session — a freshly-created article is always visible to the poller (no
  creator/account mismatch between a browser tab and `cookies.json`).

### Changed
- **Extension status page gains a live activity feed, and the toolbar icon a
  connection light (extension 0.3.0).** The how-it-works/status page now shows a
  vivid, live feed of what the relay is doing — "🔍 Asked a question", "📄
  Fetched answer", "🔑 Checked login" — each with a timestamp, duration, and
  HTTP status, updating in real time via `chrome.storage.onChanged`. Bursts of
  polling one article to completion collapse into a single row with a poll
  counter, so a whole `oe_ask` shows as ~3 lines, not thirty. The toolbar icon
  now carries a one-glance badge: green when the relay is connected and idle,
  blue while a request is in flight, grey when the relay is unreachable — so you
  can see the state without opening the page. Events are kept in a bounded
  (60-entry) `storage.local` ring buffer; a Clear button empties it.
- **Extension survives a Chrome-discarded parked tab.** Under memory pressure
  Chrome can discard the background relay tab (the id stays valid but the
  document is gone, so `executeScript` would fail). `ensureOeTab` now reloads a
  discarded tab before use, and `runProxy` retries once against a freshly-rebuilt
  tab if injection still fails — a discarded/killed tab is now self-healing
  rather than a failed request.
- **Relay tab parks on a lightweight page — ~100 MB less RAM, zero background
  OpenEvidence traffic.** The extension's pinned tab now sits on
  `openevidence.com/robots.txt` (text/plain, 0 scripts, 7 DOM nodes) instead of
  the full SPA at `/` (~118 MB JS heap, 229 scripts). The light page still
  carries the origin/cookies/TLS DataDome checks — a `POST /api/article` from it
  returns 201 (verified), and `chrome.scripting.executeScript` injects into it
  fine (isolated-world injection verified). Beyond the memory win, the SPA used
  to fire ~25 requests at OpenEvidence on every load (a 404 page fires ~60);
  the light page fires **one** GET and nothing in the background, so the parked
  tab no longer quietly eats into the account's rate-limit budget. Legacy tabs
  still parked on `/` are retired onto the light page on next use. Extension
  bumped to 0.2.0 — **reload the unpacked extension** to pick this up.

### Fixed
- **Extension no longer piles up pinned OpenEvidence tabs across browser
  restarts.** `chrome.storage.session` is wiped on restart but Chrome restores
  pinned tabs, so the relay's parked tab came back untracked and `ensureOeTab`
  opened a fresh sibling every launch. It now adopts the existing pinned
  `openevidence.com/` tab (and closes any extra orphans) before creating a new
  one. Reload the unpacked extension to pick this up.
- `waitForArticle` polls through the transient `404` a just-created article returns
  until OpenEvidence finishes provisioning it, instead of aborting the ask on the
  first poll.

## [0.3.0] - 2026-06-04

### Added
- Browser-extension relay (Brave/Chrome): `oe_ask` submits the `POST /api/article`
  inside your own real logged-in OpenEvidence tab over a localhost relay, so the
  request carries your genuine browser session. Standalone `extension/` sub-project,
  released as `extension-v0.1.0` (unpacked zip + signed `.crx`; CI builds + signs on
  `extension-v*` tags).
- `OE_MCP_RELAY_TRANSPORT=all` routes every request through the extension session
  (`cookies.json` becomes optional when the extension is connected).
- `npm run doctor` stale-DataDome-cookie diagnostics; per-account SQLite mirror
  (schema v2) with collections auto-sort tools and routine.

### Changed
- **BREAKING:** `oe_ask` is now extension-relay-only. The direct Node `POST
  /api/article` is deprecated and no longer attempted; without a connected relay,
  `oe_ask` fails fast with install guidance. Reads (`oe_history_list`,
  `oe_article_get`, collections) are unchanged.

### Removed
- **BREAKING:** the open-url `via_browser` ask path (`src/ask-browser.ts`,
  `via_browser*` flags), `OE_MCP_BROWSER_FALLBACK`, and `OE_MCP_BROWSER_APP`.

## [0.2.0] - 2026-05-09

### Changed
- Replaced Playwright-backed browser login with browser-exported `cookies.json` auth.
- Added Makefile targets for build, smoke testing, and user-scope Claude Code MCP install.
- Saved completed article artifacts to disk with citation extraction, BibTeX export, and Crossref validation.

## [0.1.0] - 2026-02-21

### Added
- MCP server with stdio transport (MCP SDK 1.26.0)
- `oe_auth_status` tool - validate session via `/api/auth/me`
- `oe_history_list` tool - read conversation history via `/api/article/list`
- `oe_article_get` tool - fetch full article payload by ID
- `oe_ask` tool - ask a question with optional completion polling
- Browser-session authentication via local storage state (no API key required)
- `npm run login` - interactive login flow with state persistence
- `npm run smoke` - smoke test for auth and connectivity
- Cross-platform support: macOS, Windows, Ubuntu/Linux
- Setup scripts for all three platforms
- MCP client config examples: Codex CLI, Claude Desktop
- GitHub Pages landing with i18n (EN, RU, ES, ZH, HI)
- `llms.txt` and `llms-full.txt` for AI parser discovery
- `SEMANTIC_CORE.md` for structured metadata
- Apache-2.0 license with NOTICE attribution
