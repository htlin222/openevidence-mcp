[![MCP Toplist](https://mcptoplist.com/badge/glama%2Fhtlin222%2Fopenevidence-mcp.svg)](https://mcptoplist.com/server/glama%2Fhtlin222%2Fopenevidence-mcp)

<h1 align="center">OpenEvidence MCP</h1>

<p align="center">
  Query OpenEvidence from Claude Code, Codex CLI, Antigravity CLI, Claude Desktop, Cursor, Cline, Continue, and any MCP client —
  authenticated through your own logged-in browser tab. No API key.
</p>

<p align="center">
  <a href="https://www.apache.org/licenses/LICENSE-2.0"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-2d72d9"></a>
  <a href="https://github.com/bakhtiersizhaev/openevidence-mcp"><img alt="Based on upstream" src="https://img.shields.io/badge/upstream-bakhtiersizhaev%2Fopenevidence--mcp-181717?logo=github"></a>
  <a href="https://modelcontextprotocol.io"><img alt="MCP" src="https://img.shields.io/badge/MCP-stdio-1d9a5a"></a>
  <a href="https://www.typescriptlang.org"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.9.3-3178c6"></a>
  <img alt="Node" src="https://img.shields.io/badge/Node-%3E%3D20-339933?logo=node.js&logoColor=white">
  <img alt="Auth" src="https://img.shields.io/badge/auth-your%20browser%20tab-E23C1F">
  <img alt="DataDome-free" src="https://img.shields.io/badge/DataDome-bypassed-16a34a">
  <img alt="Fire and forget" src="https://img.shields.io/badge/oe__ask-fire--and--forget-0ea5e9">
  <img alt="BibTeX" src="https://img.shields.io/badge/citations-BibTeX-0f766e">
  <img alt="Crossref" src="https://img.shields.io/badge/validation-Crossref-f97316">
  <img alt="Unofficial" src="https://img.shields.io/badge/OpenEvidence-unofficial-yellow">
</p>

## What it does

OpenEvidence protects its API with bot detection that blocks plain server requests. This project removes that problem: when your AI tool asks OpenEvidence a question, the request is run **inside your own logged-in OpenEvidence browser tab** — so it carries your genuine browser session and is never challenged.

A small **Chromium browser extension** lends its session to a localhost relay; the MCP server speaks to that relay. The extension is a generic authenticated fetch proxy — all the OpenEvidence logic stays in the local server, and **your browser login is the only credential**. No API key, no cookie file, no Playwright, no headless browser.

It is designed for local personal workflows where you already have lawful access to OpenEvidence. It does not bypass authentication, remove access controls, redistribute OpenEvidence content, or include any OpenEvidence data in this repository.

## How it works

```
  Claude / Codex / any MCP client
            │  asks a question (oe_ask)
            ▼
     openevidence-mcp  ──▶  relay daemon  ──▶  browser extension  ──▶  your logged-in
       (stdio server)      127.0.0.1:8787       (runs the fetch)        OpenEvidence tab
            ▲              shared · auto-spawned                              │
            └──────────────────────── answer ◀───────────────────────────────┘
```

Nothing navigates or pops up — the tab stays where it is. The extension only ever talks to `openevidence.com` and your local relay (`127.0.0.1`). The relay runs as a **shared daemon** that owns port 8787 and outlives every session, so any number of Claude/Codex sessions funnel through the **one** logged-in tab.

## Quick start

```bash
git clone https://github.com/htlin222/openevidence-mcp.git
cd openevidence-mcp
make all      # installs deps · builds the MCP server + relay extension ·
              # registers the server into Claude and Codex (whichever CLI you have)
```

Then the one manual step `make all` prints (a browser action that can't be scripted):

1. **Load the extension** — open `chrome://extensions` (Chrome / Edge / Brave / Arc / Vivaldi / Opera) → turn on **Developer mode** → **Load unpacked** → select `extension/dist`.
2. **Stay logged in to [openevidence.com](https://www.openevidence.com)** in that browser, and keep a tab open. That login *is* your authentication.
3. **Run your AI tool.** The server auto-starts the relay and connects to the extension.

Verify and go:

```bash
curl -s http://127.0.0.1:8787/health     # expect {"ok":true,"connected":true,"version":1,...}
```

Then just ask, in any MCP client: *“Use OpenEvidence to answer …”*. Re-run `make all` anytime to rebuild + re-register; `make help` lists every target; `make kill-all` stops all servers + the relay daemon.

**Already installed? Update in one line:**

```bash
make update    # git pull latest release · rebuild server + extension · re-register
```

Then **reload the browser extension** (`chrome://extensions` → Reload) and reconnect `/mcp`. `make status` shows versions + live health; `make uninstall` removes it. (Inside an AI session you can also just say *“update openevidence-mcp”* — the bundled **install skill** runs the right step and reminds you to reload the extension.)

> Clicking the extension's toolbar icon opens a built-in **how-it-works page** with a live connection check.

> `cookies.json` and a HAR are **optional** — needed only for the legacy `OE_MCP_RELAY_TRANSPORT=off` cookie read path, the Python collections tooling, and `npm run doctor` / `login` / `smoke`. See [Optional cookie path](#optional-cookie-path).

## One tab, many sessions

The relay is a standalone daemon (auto-spawned; run/inspect with `npm run relay`) that owns port 8787 and is shared by every MCP server. You can run OpenEvidence from **any number of Claude/Codex sessions at once** — they all flow through the single logged-in tab. The daemon:

- **outlives session restarts** and is respawned automatically if it dies (a crashed daemon is replaced and the in-flight request retried);
- is **idempotent** — a second daemon that loses the port race exits cleanly;
- reports `version` + `pid` on `/health`, so an upgrade replaces a stale daemon from an older build.

## Asking questions

After registration, ask your MCP client in plain English and mention OpenEvidence — the agent calls `oe_ask` automatically.

```text
Use OpenEvidence to answer: DLBCL frontline treatment landscape NCCN v3.2026. Include citations and BibTeX.
Use OpenEvidence to compare Pola-R-CHP vs R-CHOP in untreated DLBCL. Include trial citations and BibTeX.
Use OpenEvidence to review current evidence for SGLT2 inhibitors in HFpEF. Include citations and BibTeX.
Use OpenEvidence to find guideline-supported anticoagulation options for cancer-associated thrombosis.
```

### Fire-and-forget by default

`oe_ask` returns `{article_id, status:"pending"}` **the moment the question is submitted**, freeing the tab for other sessions instead of holding the call for the whole generation:

```jsonc
// oe_ask  →  returns instantly
{ "article_id": "…", "status": "pending" }

// oe_article_get(article_id)  →  the finished answer, when ready
{ "article_id": "…", "status": "success", "extracted_answer_raw": "…", "figures": […], "artifacts": { … } }
```

- Fetch the answer later with **`oe_article_get(article_id)`** — pass `wait_for_completion: true` there to block until it's ready.
- For one-shot blocking (submit and wait in a single call), pass `wait_for_completion: true` to **`oe_ask`** itself.

A completed article returns the OpenEvidence payload and `status`, the `article_id`, the answer markdown as `extracted_answer_raw`, any figures, inline BibTeX as `artifacts.bibtex`, and saved citation files. Pass `include_bibtex: false` to keep the response small while still writing `citations.bib` to disk. Pass `strip_citation_markers: true` to also get `extracted_answer_clean` with the `[1]` / `[1-3]` reference marks removed — handy when quoting the answer into notes.

### Question pacing — stay under your hourly ask limit

OpenEvidence caps how many **questions** you can ask per account over time. Only
`oe_ask` spends that budget — a new question *and* every follow-up is one ask.
Everything else (`oe_article_get`, `oe_answers_search`, `oe_history_list`,
`oe_public_get`, `oe_auth_status`, `oe_health`, collections) is free of it.

To avoid bursts that trip the limit, `oe_ask` **paces submissions**: it waits
(never errors) so consecutive asks are at least `OE_MCP_ASK_MIN_INTERVAL_MS`
apart (default 1000 ms ≈ 1 question/second). The wait is coordinated across all
MCP sessions through the shared SQLite `ask_log`, so several Claude/Codex windows
can't collectively exceed the rate. Every `oe_ask` reply carries
`ask_pacing: { waited_ms, asks_last_hour }`, and `oe_health` reports
`asks_last_hour` so you can see how many questions you've spent in the trailing
hour at a glance. Set `OE_MCP_ASK_MIN_INTERVAL_MS=0` to disable pacing.

The biggest saver, though, is **not re-asking**: `oe_answers_search` finds a past
answer and `oe_article_get` serves it from cache — both cost zero questions.

### Follow-up questions — continue the same conversation

Every completed answer carries **`follow_up_questions`** — the suggestions OpenEvidence renders under the answer (e.g. *"How does adjuvant therapy choice differ in elderly patients?"*). To ask any of them (or your own) **in the same conversation thread**, call `oe_ask` with `original_article_id` set to the answer's `article_id`:

```jsonc
// first answer → { article_id: "b752a1c1-…", follow_up_questions: ["How does adjuvant therapy choice differ in elderly patients?", …] }

// oe_ask({ question: "How does adjuvant therapy choice differ in elderly patients?",
//          original_article_id: "b752a1c1-…" })
// → a new article that threads on the prior turn — the answer opens
//   "Elderly patients with stage III colon cancer…", carrying the earlier context.
```

You only pass `original_article_id` + the new question — OpenEvidence rebuilds the conversation history server-side (the new article's `inputs.history` is populated for you). Each follow-up answer comes with its own fresh `follow_up_questions`, so you can keep drilling down. `original_article_id` accepts a bare UUID or a full `/ask/<id>` URL.

### Reading conversation pages by link

Someone sends you an OpenEvidence link? **`oe_public_get(url)`** fetches the server-rendered `/ask/<id>` page and parses it into Q&A turns (question, answer as markdown, references). Auth escalates automatically:

1. **Relay connected** → the fetch runs inside your logged-in tab, so **your own private conversations work too** (and DataDome never sees it).
2. **No relay, public link** → a plain anonymous fetch; conversations whose author pressed "make public" are fully server-rendered and need zero setup.
3. **No relay, private link** → falls back to `cookies.json` when present; otherwise reports clearly that the conversation is private.

Page fetches count against the same account budget as API calls, so they run through the same rate limiter (60 clinical queries/min, self-throttled at 80%). `oe_public_get` also accepts a bare article UUID, and `oe_article_get` / `oe_ask.original_article_id` accept full `/ask/` URLs too.

### Local answer store — search past answers offline, skip re-fetches

Every completed answer from `oe_ask` / `oe_article_get` is upserted into a local SQLite table (`answers`) in the same file the collections tooling already uses (`~/.openevidence-mcp/db/oe.sqlite`). This gives you two things for free:

- **Full-text search over what you've already asked** — **`oe_answers_search("query")`** runs an FTS5 query across questions, titles, and answer bodies and returns highlighted `»…«` snippets. It's fully offline: no OpenEvidence traffic, no rate-limit cost. Great for "did I already look this up?" before spending a query.

  ```jsonc
  // oe_answers_search({ query: "CAPEOX duration neurotoxicity" })
  // → { total_stored, match_count, matches: [{ article_id, title, question, snippet, url, … }] }
  ```

  The query is FTS5 syntax — plain words are ANDed, `"quoted phrases"` match verbatim, and `AND`/`OR`/`NOT` work. Malformed queries fall back to a literal token search instead of erroring.

- **Cache hits on `oe_article_get`** — fetching an article you've already stored returns instantly from disk with `from_cache: true` and **zero network round-trips** (it doesn't even touch the relay). Pass `refresh: true` to force a re-fetch from OpenEvidence and regenerate the on-disk citation artifacts.

This store persists across reboots (unlike the citation artifacts under the OS temp dir), and only ever holds answers *this MCP fetched*. For your complete server-side history, use `oe_history_list` or the collections sync. Point it elsewhere with `OE_MCP_DB_PATH`; it needs Node ≥ 22 for the built-in `node:sqlite` (no extra dependency).

### Is the pipeline up? `oe_health` vs `oe_auth_status`

Two health checks, two speeds:

- **`oe_health`** — a millisecond-fast, purely local check of the relay pipeline. It reads the daemon's `/health` and reports whether the daemon is up, whether the browser extension is actually polling (`extension_connected`), the version match, uptime, and served/errored counts — **without any OpenEvidence network call**. Use it to confirm the plumbing before an ask, or to diagnose a stuck relay. Each failure state carries a `hint`.
- **`oe_auth_status`** — the full round-trip: hits `/api/auth/me` through the relay to confirm your **login session** is still valid. Slower, but it's the one that answers "am I actually logged in?".

## Tools

| Tool                          | Purpose                                                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `oe_ask`                      | Ask a question — fire-and-forget by default (returns a pending `article_id`); `wait_for_completion:true` to block; `original_article_id` to follow up in the same thread |
| `oe_article_get`              | Fetch an article by id or `/ask/` URL (the fetch-later half of `oe_ask`); returns `follow_up_questions`; saves artifacts; `wait_for_completion` to block until ready |
| `oe_public_get`               | Read a conversation page from an `/ask/<id>` link as Q&A markdown turns — public links need zero setup; private ones use the relay tab or `cookies.json` |
| `oe_article_set_access`       | Toggle a conversation's share visibility — `public:true` → link-shareable (`ANYONE_WITH_LINK`), `public:false` → private (`CREATOR_ONLY`); returns the `/ask/<id>` URL (you must own it; relay required) |
| `oe_answers_search`           | Full-text search (SQLite FTS5) over every answer this MCP has fetched — offline, zero rate-limit cost; returns highlighted snippets |
| `oe_health`                   | Millisecond-fast local check of the relay pipeline (daemon + extension) — no network call, unlike `oe_auth_status`          |
| `oe_auth_status`              | Check `/api/auth/me` through the relay (full network round-trip)                                                             |
| `oe_history_list`             | Read your OpenEvidence question history                                                                                      |
| `oe_collections_list`         | List your collections                                                                                                       |
| `oe_collections_get`          | Get a collection (incl. nested `questions[]` = membership list)                                                              |
| `oe_collections_create`       | Create a collection (agent-managed names should start with `#`)                                                              |
| `oe_collections_add_article`  | Add a chat to a collection                                                                                                   |
| `oe_collections_db_init`      | Create the local SQLite mirror (idempotent)                                                                                  |
| `oe_collections_sync_history` | Pull `/api/article/list` into the local SQLite chats table                                                                   |
| `oe_collections_sync_db`      | Refresh collections + memberships into SQLite                                                                                |
| `oe_collections_unsorted`     | Chats with no `#`-collection membership; structured JSON                                                                     |
| `oe_collections_summary`      | Counts + last sync timestamps                                                                                                |
| `oe_collections_classify`     | Auto-classify unsorted chats using log-odds-ratio signatures learned from your memberships + curated keyword rules           |
| `oe_collections_bulk_apply`   | Mint missing `#`-collections + add memberships per `[{article_id, hashtags}]` plan                                           |

## Privacy & security

- The relay listens on **localhost only** (`127.0.0.1:8787`) — nothing is exposed to the network.
- The extension and server store **no credentials**. Your OpenEvidence session lives in your browser, as always.
- The extension only acts on requests from your own local relay, and only against `openevidence.com`.
- This repository contains **connector code only** — no OpenEvidence content, datasets, cookies, or account material.

## Troubleshooting

- **Extension badge not green / `connected:false`?** Make sure you're logged in to openevidence.com in that browser with a tab open, then reload the extension (`chrome://extensions` → ↻).
- **Tools fail with “relay not connected”?** Start your AI tool / MCP server so the daemon comes up, then `curl -s http://127.0.0.1:8787/health`. If a previous build is stuck, `make kill-all` and reconnect the MCP server.
- **Run the relay in one browser at a time** if you've loaded the extension in several — requests go to whichever polls first.
- **DataDome 403 on the legacy cookie path?** See [Doctor](#doctor-legacy-cookie-path) below — relevant only when `OE_MCP_RELAY_TRANSPORT=off`.

## Register with MCP clients

`make all` already registers Claude Code and Codex CLI. To do it à la carte (or for other clients), register the local stdio server `node /ABSOLUTE/PATH/openevidence-mcp/dist/server.js`. **No env is required** — the browser extension is the login.

```bash
make install-claude-global    # claude mcp add-json --scope user openevidence …
make install-codex-global     # codex mcp add openevidence -- node dist/server.js
make install-agy-global       # Antigravity CLI (agy-cli)
make install-all              # all three
```

For **Claude Desktop, Cursor, Cline, Continue**, use this `mcpServers` shape (see [`examples/`](examples/) for a full-knobs reference):

```json
{
  "mcpServers": {
    "openevidence": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/openevidence-mcp/dist/server.js"]
    }
  }
}
```

## Collections sync & auto-sort

`scripts/collection_sort.py` mirrors your chat history and collection memberships into a local SQLite (`~/.openevidence-mcp/db/oe.sqlite`; override with `OE_MCP_DB_PATH`). The routine [`routines/collection-sort.md`](routines/collection-sort.md) walks an MCP client through syncing, surfacing unsorted chats, and applying multi-membership hashtag tags. Convention: collections whose name starts with `#` are **agent-managed**; collections without a leading hash are human-curated and never touched.

The same pipeline is exposed as the `oe_collections_*` MCP tools (the TS server shells out to `scripts/collection_sort.py` via `python3`, overridable with `OE_MCP_PYTHON`).

```bash
python scripts/collection_sort.py init
python scripts/collection_sort.py sync-history --full   # first time
python scripts/collection_sort.py sync-collections
python scripts/collection_sort.py list-unsorted --json  # routine reads this
python scripts/collection_sort.py summary
```

**Account-scoped (schema v2).** Chats, collections, and memberships carry an `account` column (composite primary keys), so one DB can mirror multiple OpenEvidence logins without mixing them. The account is resolved from `/api/auth/me`; override with `--account EMAIL`. A v1 DB auto-migrates on first open — pre-v2 rows are tagged `--legacy-account` (default `legacy`; or `OE_MCP_LEGACY_ACCOUNT`).

### Schedule the sync (macOS)

The classification step needs the agent in the loop, but the sync side is pure I/O — install a daily launchd job that keeps the local mirror fresh:

```bash
bash scripts/install_launchd.sh                  # daily 02:00 (OE_MCP_SYNC_HOUR / OE_MCP_SYNC_MINUTE)
launchctl start com.htlin.openevidence-mcp.sync  # fire once to verify
tail -30 ~/.openevidence-mcp/logs/sync.log
bash scripts/install_launchd.sh --uninstall      # remove
```

The wrapper (`scripts/collection_sync_cron.sh`) appends one block per run to `~/.openevidence-mcp/logs/sync.log`. It takes an optional mode flag:

| Mode        | Behavior                                                             |
| ----------- | -------------------------------------------------------------------- |
| (default)   | sync only — chats accumulate as `unsorted` until you run the routine |
| `--dry-run` | sync + classify; writes `proposed-plan.json` for review, no apply    |
| `--auto`    | sync + classify + bulk-apply + reconcile; fully autonomous sort      |

`scripts/classify.py` runs offline (no API): a per-tag log-odds-ratio signature (Monroe et al. 2008) built from your memberships every run, OR'd with curated keyword rules. Validate with `python scripts/classify.py validate`. Tune headless use via `OE_MCP_AUTO_THRESHOLD` (default 12) and `OE_MCP_AUTO_TOP_K` (default 3); switch the job to autonomous mode with `OE_MCP_SYNC_MODE=--auto bash scripts/install_launchd.sh`.

## Citation artifacts

Completed `oe_ask` / `oe_article_get` calls save artifacts under `${OE_MCP_ARTIFACT_DIR}/<article_id>/` (default OS temp dir + `openevidence-mcp`; on macOS, `/tmp` may resolve under `/var/folders/.../T/`):

| File                       | Purpose                              |
| -------------------------- | ------------------------------------ |
| `answer.md`                | Extracted markdown answer            |
| `article.json`             | Full OpenEvidence article payload    |
| `citations.json`           | Parsed structured citations          |
| `citations.bib`            | BibTeX bibliography                  |
| `crossref-validation.json` | Post-hoc Crossref validation results |

Crossref validation: DOI citations are validated directly; non-DOI citations use a bibliographic query and are marked `candidate` / `not_found` / `error`. Low-similarity matches never overwrite BibTeX metadata, and sources like NCCN guidelines may stay as local OpenEvidence metadata when Crossref has no authoritative match.

These artifact files live under the OS temp dir and can be cleaned up by the system. The **answer body itself is also persisted** to the SQLite `answers` store (see [Local answer store](#local-answer-store--search-past-answers-offline-skip-re-fetches)), which survives reboots and powers `oe_answers_search` and the `oe_article_get` cache.

## Optional cookie path

The extension relay is the default and recommended path. For headless reads without the extension, set `OE_MCP_RELAY_TRANSPORT=off` to route reads (`oe_history_list`, `oe_article_get`, `oe_collections_*`) over a browser-exported `cookies.json` — asks still need the extension. This path also backs the Python collections tooling and the `npm run doctor` / `login` / `smoke` CLIs.

```bash
cp /path/to/browser-cookies.json ./cookies.json
make build HAR=/path/to/www.openevidence.com.har   # extracts the browser fingerprint, then compiles
npm run login && npm run smoke
```

`make build` extracts `openevidence-fingerprint.json` from the HAR when present. The fingerprint is **profile-faithful** — the client sends exactly the captured browser's header set, so a HAR from any browser (incl. Safari) stays coherent with the cookie that browser minted.

### Doctor (legacy cookie path)

When the cookie path fails with a DataDome 403 — most often **after moving to a different computer** — run the doctor:

```bash
npm run doctor              # static checks + a live read probe
npm run doctor -- --offline # static checks only (no network)
npm run doctor -- --json    # machine-readable output
```

It flags `datadome-missing` / `-expired` / `-session` (cookie absent / past expiry / session-scoped), `fingerprint-platform-mismatch` (cookie + fingerprint minted on a different OS — re-mint here), `fingerprint-default` (no fingerprint; built-in signature in use), and `datadome-live` (a live request was actually challenged). Non-zero exit on failure for CI/pre-flight.

## Make targets

Run `make help` for the grouped, always-current list.

| Target                                              | Purpose                                                                                                                     |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `make all` (or bare `make`)                         | **One-shot setup:** deps + build server + build extension + register into Claude & Codex (skips a CLI that isn't installed)  |
| `make update`                                       | **Update to the latest release:** `git pull` + rebuild + re-register (then reload the extension)                            |
| `make status`                                       | Versions, live relay `/health`, and CLI registration at a glance                                                            |
| `make cleanup`                                      | Reap orphan relay daemons + prune stale logs/temp — non-destructive (relay respawns on next use)                            |
| `make uninstall`                                    | Unregister from the CLIs, stop daemons, remove `dist/` (keeps `~/.openevidence-mcp` + the browser extension)                |
| `make help`                                         | Grouped reference of every target                                                                                           |
| `make kill-all`                                     | Stop all MCP servers + the relay daemon and free port 8787                                                                  |
| `make relay`                                        | Run the standalone relay daemon in the foreground (debug)                                                                   |
| `make deps` / `check` / `test` / `smoke`            | Force install · type-check · unit tests · auth+history smoke (cookie path)                                                  |
| `make build [HAR=…]`                                | Extract the fingerprint if a HAR is given, then compile TypeScript                                                          |
| `make fingerprint HAR=…`                            | Extract the working browser fingerprint from a HAR                                                                          |
| `make import-cookies COOKIES=…`                     | Import and verify cookies                                                                                                   |
| `make install-claude-global` / `-codex-global` / `-agy-global` / `install-all` | Register the server with the respective CLI(s)                                                  |

## Environment variables

| Variable                   | Default                                                                   | Purpose                                           |
| -------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------- |
| `OE_MCP_RELAY`             | `1`                                                                       | Set `0` to disable the relay entirely             |
| `OE_MCP_RELAY_TRANSPORT`   | `all`                                                                     | `all` = every request via the extension; `off` = reads over `cookies.json` |
| `OE_MCP_RELAY_PORT`        | `8787`                                                                     | Relay port (must match the extension)             |
| `OE_MCP_RELAY_PID_PATH`    | `~/.openevidence-mcp/relay.pid`                                           | Relay daemon pidfile                              |
| `OE_MCP_RELAY_LOG_PATH`    | `~/.openevidence-mcp/relay.log`                                           | Relay daemon log file                             |
| `OE_MCP_BASE_URL`          | `https://www.openevidence.com`                                            | OpenEvidence base URL                             |
| `OE_MCP_ARTIFACT_DIR`      | OS temp dir + `openevidence-mcp`                                          | Artifact output directory                         |
| `OE_MCP_CROSSREF_MAILTO`   | unset                                                                     | Optional Crossref polite-pool email               |
| `OE_MCP_CROSSREF_VALIDATE` | `1`                                                                       | Set `0` to skip Crossref validation               |
| `OE_MCP_ASK_MIN_INTERVAL_MS` | `1000`                                                                  | Minimum spacing between questions (`oe_ask`); waits, never errors; `0` disables |
| `OE_MCP_POLL_INTERVAL_MS`  | `1200`                                                                    | Poll interval when waiting for an answer          |
| `OE_MCP_POLL_TIMEOUT_MS`   | `180000`                                                                  | Default poll timeout                              |
| `OE_MCP_COOKIES_PATH`      | `./cookies.json` if present, else `~/.openevidence-mcp/auth/cookies.json` | Cookie file (legacy/optional path)                |
| `OE_MCP_FINGERPRINT_PATH`  | `./openevidence-fingerprint.json` if present                              | Browser signature fingerprint (legacy path)       |
| `OE_MCP_DB_PATH`           | `~/.openevidence-mcp/db/oe.sqlite`                                        | Local SQLite file: collections mirror + the `answers` store (`oe_answers_search`, `oe_article_get` cache) |
| `OE_MCP_PYTHON`            | `python3`                                                                 | Python interpreter the bridge tools spawn         |
| `OE_MCP_LEGACY_ACCOUNT`    | `legacy`                                                                  | Label for pre-v2 rows on DB account migration     |

## Project files

- [extension/README.md](extension/README.md) — the browser-extension relay (and its built-in [README.html](extension/README.html) how-it-works page)
- [README.AI.md](README.AI.md) — agent install playbook
- [src/server.ts](src/server.ts) — MCP tools
- [src/relay-server.ts](src/relay-server.ts) — the localhost relay (extension-facing + `/relay` bridge)
- [src/relay-client.ts](src/relay-client.ts) / [src/relay-daemon.ts](src/relay-daemon.ts) — shared-daemon client + standalone daemon
- [src/citations.ts](src/citations.ts) — citation extraction, BibTeX, Crossref validation
- [src/doctor.ts](src/doctor.ts) — stale DataDome cookie diagnostics (legacy path)
- [docs/plans/2026-06-04-shared-relay-daemon-design.md](docs/plans/2026-06-04-shared-relay-daemon-design.md) — relay daemon design doc
- [examples/](examples/) — MCP client config samples

## Copyright, trademark, and medical disclaimer

This project is unofficial and independent. It is not affiliated with, endorsed by, sponsored by, or approved by OpenEvidence or its owners. "OpenEvidence" and related names, logos, product names, and content remain the property of their respective owners.

This repository contains connector code only. It does not include OpenEvidence copyrighted content, proprietary datasets, model outputs, article payloads, session cookies, or account material. Your local use of this MCP server may create files such as `answer.md`, `article.json`, and `citations.bib`; those artifacts can contain content retrieved from or derived from your OpenEvidence account session. Treat those files as private unless you have the right to share them.

You are responsible for complying with OpenEvidence terms, institutional policies, copyright law, and any clinical data governance rules that apply to your use. Do not publish cookies, account tokens, saved article payloads, generated answers, screenshots, guideline text, or other protected/copyrighted content unless you have permission or another valid legal basis.

This software is not medical advice and is not a medical device. It is an integration tool for an MCP client. Clinicians and qualified users remain responsible for verifying outputs against authoritative sources and applying independent clinical judgment.

## License and attribution

Apache-2.0. Keep [LICENSE](LICENSE) and [NOTICE](NOTICE) when redistributing.

Based on OpenEvidence MCP by Bakhtier Sizhaev: `https://github.com/bakhtiersizhaev/openevidence-mcp`
