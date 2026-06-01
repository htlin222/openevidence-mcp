<h1 align="center">OpenEvidence MCP (Cookie Auth Fork)</h1>

<p align="center">
  Use OpenEvidence from Claude Code, Codex CLI, Antigravity CLI, Claude Desktop, Cursor, Cline, Continue, and any MCP-compatible client.
</p>

<p align="center">
  <a href="https://www.apache.org/licenses/LICENSE-2.0"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-2d72d9"></a>
  <a href="https://github.com/bakhtiersizhaev/openevidence-mcp"><img alt="Based on upstream" src="https://img.shields.io/badge/upstream-bakhtiersizhaev%2Fopenevidence--mcp-181717?logo=github"></a>
  <a href="https://modelcontextprotocol.io"><img alt="MCP" src="https://img.shields.io/badge/MCP-stdio-1d9a5a"></a>
  <a href="https://www.npmjs.com/package/@modelcontextprotocol/sdk"><img alt="MCP SDK" src="https://img.shields.io/badge/MCP%20SDK-1.26.0-1d9a5a"></a>
  <a href="https://www.typescriptlang.org"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.9.3-3178c6"></a>
  <img alt="Node" src="https://img.shields.io/badge/Node-%3E%3D20-339933?logo=node.js&logoColor=white">
  <img alt="Auth" src="https://img.shields.io/badge/auth-cookies.json-4f46e5">
  <img alt="Reads" src="https://img.shields.io/badge/reads-Node%20fetch-339933">
  <img alt="Ask" src="https://img.shields.io/badge/ask-CDP%20browser%20bridge-ef4444">
  <img alt="Unofficial" src="https://img.shields.io/badge/OpenEvidence-unofficial-yellow">
  <img alt="BibTeX" src="https://img.shields.io/badge/citations-BibTeX-0f766e">
  <img alt="Crossref" src="https://img.shields.io/badge/validation-Crossref-f97316">
  <img alt="Claude Code" src="https://img.shields.io/badge/Claude%20Code-ready-6b7280">
  <img alt="Codex CLI" src="https://img.shields.io/badge/Codex%20CLI-ready-111827">
  <img alt="Antigravity CLI" src="https://img.shields.io/badge/Antigravity%20CLI-ready-8b5cf6">
</p>

## What It Does

This is an unofficial OpenEvidence MCP server that reuses cookies exported from your own logged-in OpenEvidence browser session. It does not need an official OpenEvidence API key, and it never downloads or bundles a browser engine.

**How it talks to OpenEvidence — and why.** Read endpoints (auth, history, article fetch, collections) run over plain Node `fetch` with your cookie file — no browser involved. The one exception is the **ask submission** (`POST /api/article`): OpenEvidence guards it with DataDome's anti-bot layer, which scores the request's TLS/JA3 + HTTP-2 fingerprint — signals a Node HTTP client cannot reproduce — and returns HTTP 403 even with a valid session and a fresh `datadome` cookie. We confirmed this exhaustively: refreshing cookies, regenerating the header fingerprint, and restarting the process all still 403 on the POST while GET endpoints keep working.

The only reliable fix is to issue that single POST from a **real browser**. So `oe_ask` tries Node first and, on a DataDome challenge, falls back to issuing the POST inside a browser **you** launch, attached over the Chrome DevTools Protocol (CDP); the answer is then polled over normal Node requests. `playwright-core` attaches to your existing browser — it does **not** download Chromium, and a headless browser would itself be flagged, so this uses your real, headed session. See [DataDome And The Browser-Backed Ask](#datadome-and-the-browser-backed-ask) for setup. If you only use the read tools, no browser is ever launched.

It is designed for local personal workflows where you already have lawful access to OpenEvidence. It does not bypass authentication, remove access controls, redistribute OpenEvidence content, or include OpenEvidence data in this repository. The browser bridge does not defeat DataDome programmatically — it routes the request through a genuine browser session you control.

Tools:

| Tool                          | Purpose                                                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `oe_auth_status`              | Check `/api/auth/me` with your cookie file                                                                                  |
| `oe_history_list`             | Read OpenEvidence history                                                                                                   |
| `oe_article_get`              | Fetch an article by id and save artifacts                                                                                   |
| `oe_ask`                      | Ask a question, optionally wait, and save artifacts                                                                         |
| `oe_collections_list`         | List your collections                                                                                                       |
| `oe_collections_get`          | Get a collection (incl. nested questions[] = membership list)                                                               |
| `oe_collections_create`       | Create a collection (agent-managed names should start with `#`)                                                             |
| `oe_collections_add_article`  | Add a chat to a collection                                                                                                  |
| `oe_collections_db_init`      | Create the local SQLite mirror (idempotent)                                                                                 |
| `oe_collections_sync_history` | Pull /api/article/list into local SQLite chats table                                                                        |
| `oe_collections_sync_db`      | Refresh collections + memberships into SQLite                                                                               |
| `oe_collections_unsorted`     | Chats with no `#`-collection membership; structured JSON                                                                    |
| `oe_collections_summary`      | Counts + last sync timestamps                                                                                               |
| `oe_collections_classify`     | Auto-classify unsorted chats using log-odds-ratio signatures learned from your existing memberships + curated keyword rules |
| `oe_collections_bulk_apply`   | Mint missing `#`-collections + add memberships per `[{article_id, hashtags}]` plan                                          |

`oe_ask` and `oe_article_get` return BibTeX in the MCP response by default when artifacts are saved. Pass `include_bibtex: false` to keep the response smaller while still writing `citations.bib` to disk.

### Collections sync & auto-sort routine

`scripts/collection_sort.py` mirrors your chat history and collection memberships into a local SQLite (`~/.openevidence-mcp/db/oe.sqlite` by default; override with `OE_MCP_DB_PATH`). The companion routine `routines/collection-sort.md` walks an MCP client through syncing, surfacing unsorted chats, and applying multi-membership hashtag tags. The convention: collections whose name starts with `#` are agent-managed; collections without a leading hash are human-curated and the routine never touches them.

The same pipeline is exposed as MCP tools (`oe_collections_db_init`, `oe_collections_sync_history`, `oe_collections_sync_db`, `oe_collections_unsorted`, `oe_collections_summary`, `oe_collections_bulk_apply`) — the TS server shells out to `scripts/collection_sort.py` via `python3` (override with `OE_MCP_PYTHON`) so the DataDome-safe HTTP path stays canonical.

```bash
python scripts/collection_sort.py init
python scripts/collection_sort.py sync-history --full   # first time
python scripts/collection_sort.py sync-collections
python scripts/collection_sort.py list-unsorted --json  # routine reads this
python scripts/collection_sort.py summary
```

#### Schedule the sync (macOS)

The classification step needs the agent in the loop, but the sync side is pure I/O — install a daily launchd job that keeps the local SQLite mirror fresh so the next agent run has zero lag:

```bash
bash scripts/install_launchd.sh                  # daily 02:00 (override via OE_MCP_SYNC_HOUR / OE_MCP_SYNC_MINUTE)
launchctl start com.htlin.openevidence-mcp.sync  # fire once now to verify
tail -30 ~/.openevidence-mcp/logs/sync.log
bash scripts/install_launchd.sh --uninstall      # remove
```

The wrapper (`scripts/collection_sync_cron.sh`) appends one block per run to `~/.openevidence-mcp/logs/sync.log` containing the sync-history / sync-collections / summary output. Override the log dir with `OE_MCP_LOG_DIR`.

The wrapper takes an optional mode flag:

| Mode        | Behavior                                                             |
| ----------- | -------------------------------------------------------------------- |
| (default)   | sync only — chats accumulate as `unsorted` until you run the routine |
| `--dry-run` | sync + classify; writes `proposed-plan.json` for review, no apply    |
| `--auto`    | sync + classify + bulk-apply + reconcile; fully autonomous sort      |

`scripts/classify.py` runs offline, no API. It builds a per-tag log-odds-ratio signature (Monroe et al. 2008) from your existing memberships every run, OR'd with curated keyword rules. Validate quality on your data with `python scripts/classify.py validate` (held-out cross-validation; on the first 603 memberships I verified, hit-rate = 99.4% with recall ≈1.0; precision varies by tag — raise `--threshold` for tighter precision in `--auto` mode). Tune for headless use via `OE_MCP_AUTO_THRESHOLD` (default 12) and `OE_MCP_AUTO_TOP_K` (default 3). Switch the launchd job to autonomous mode with `OE_MCP_SYNC_MODE=--auto bash scripts/install_launchd.sh`.

Saved artifacts:

| File                       | Purpose                              |
| -------------------------- | ------------------------------------ |
| `article.json`             | Full OpenEvidence article payload    |
| `answer.md`                | Extracted markdown answer            |
| `citations.json`           | Parsed structured citations          |
| `citations.bib`            | BibTeX bibliography                  |
| `crossref-validation.json` | Post-hoc Crossref validation results |

## Fast Install

You need two private browser exports from the same logged-in OpenEvidence browser session:

| File                       | Purpose                                                | Where to put it                        |
| -------------------------- | ------------------------------------------------------ | -------------------------------------- |
| `cookies.json`             | Authenticates your OpenEvidence account session        | `./cookies.json`                       |
| `www.openevidence.com.har` | Teaches the client the browser fingerprint that worked | Any private path; pass it as `HAR=...` |

Both files are credentials. Keep them local, do not commit them, and do not share them. The HAR extractor only saves the browser signature headers into `openevidence-fingerprint.json`; it does not copy cookies or authorization headers from the HAR.

```bash
git clone https://github.com/htlin222/openevidence-mcp.git
cd openevidence-mcp
npm install
```

Export cookies from a logged-in `https://www.openevidence.com` browser session and put them here:

```bash
cp /path/to/browser-cookies.json ./cookies.json
```

Export a HAR that contains a successful OpenEvidence ask request (`POST /api/article`, usually status `201`), then build:

```bash
make build HAR=/path/to/www.openevidence.com.har
npm run login
npm run smoke
```

`make build` extracts `openevidence-fingerprint.json` from the HAR when the HAR exists, then compiles `dist/server.js`. The cookie file can be a browser-exported cookies array or a storage-state object with a `cookies` array.

For a private battery-included portable skill, also copy the same cookie file into the skill folder:

```bash
cp ./cookies.json ./openevidence-skill/cookies.json
```

That lets `openevidence-skill/scripts/oe.py` run standalone without MCP config. This is local-only; `openevidence-skill/cookies.json` is gitignored and should never be published in a public skill bundle.

## Register With MCP Clients

Use one of these.

### Claude Code

```bash
make install-claude-global HAR=/path/to/www.openevidence.com.har
claude mcp get openevidence
```

What it registers:

```text
node /ABSOLUTE/PATH/openevidence-mcp/dist/server.js
OE_MCP_COOKIES_PATH=/ABSOLUTE/PATH/openevidence-mcp/cookies.json
```

### Codex CLI

```bash
make install-codex-global HAR=/path/to/www.openevidence.com.har
codex mcp get openevidence
```

Equivalent manual command:

```bash
codex mcp add openevidence \
  --env OE_MCP_COOKIES_PATH="$PWD/cookies.json" \
  -- node "$PWD/dist/server.js"
```

Manual `~/.codex/config.toml`:

```toml
[mcp_servers.openevidence]
command = "node"
args = ["/ABSOLUTE/PATH/openevidence-mcp/dist/server.js"]
startup_timeout_sec = 60

[mcp_servers.openevidence.env]
OE_MCP_COOKIES_PATH = "/ABSOLUTE/PATH/openevidence-mcp/cookies.json"
```

### Antigravity CLI (agy-cli)

```bash
make install-agy-global HAR=/path/to/www.openevidence.com.har
agy-cli mcp list
```

Equivalent manual command:

```bash
agy-cli mcp add --scope user \
  -e OE_MCP_COOKIES_PATH="$PWD/cookies.json" \
  openevidence node "$PWD/dist/server.js"
```

### Claude Desktop, Cursor, Cline, Continue

Use this `mcpServers` shape:

```json
{
  "mcpServers": {
    "openevidence": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/openevidence-mcp/dist/server.js"],
      "env": {
        "OE_MCP_COOKIES_PATH": "/ABSOLUTE/PATH/openevidence-mcp/cookies.json"
      }
    }
  }
}
```

### Install Everywhere

```bash
make install-all HAR=/path/to/www.openevidence.com.har
```

This registers the same local stdio server with Claude Code, Codex CLI, and Antigravity CLI.

## Verify

```bash
npm run check
npm test
npm run build
npm run smoke
```

Expected smoke result:

```json
{
  "ok": true,
  "authenticated": true
}
```

MCP stdio servers normally start on demand when the client checks or uses them. They do not need to run as a separate daemon.

## How To Ask Questions

After registration, ask your MCP client in plain English and mention OpenEvidence. The agent should call `oe_ask` automatically.

Example prompts:

```text
Use OpenEvidence to answer: DLBCL frontline treatment landscape NCCN v3.2026. Include citations and BibTeX.
```

```text
Use OpenEvidence to compare Pola-R-CHP vs R-CHOP in untreated DLBCL. Include trial citations and BibTeX.
```

```text
Use OpenEvidence to review current evidence for SGLT2 inhibitors in HFpEF. Include citations and BibTeX.
```

```text
Use OpenEvidence to find guideline-supported anticoagulation options for cancer-associated thrombosis.
```

The underlying MCP call looks like this:

```json
{
  "tool": "oe_ask",
  "arguments": {
    "question": "DLBCL frontline treatment landscape NCCN v3.2026",
    "wait_for_completion": true,
    "include_bibtex": true
  }
}
```

`oe_ask` returns:

- the OpenEvidence article payload
- `article_id`
- extracted answer markdown as `extracted_answer_raw`
- artifact file paths
- inline BibTeX as `artifacts.bibtex`
- saved citation files under the artifact directory

To fetch BibTeX for a prior answer, ask:

```text
Use OpenEvidence to fetch article <ARTICLE_ID> and show the BibTeX.
```

That maps to `oe_article_get`:

```json
{
  "article_id": "<ARTICLE_ID>",
  "include_bibtex": true
}
```

If the response is too large, use `include_bibtex: false`; the server will still write `citations.bib` to disk.

### DataDome And The Browser-Backed Ask

OpenEvidence protects the ask submission (`POST /api/article`) with DataDome's
anti-bot layer. It scores the request's **TLS/JA3 + HTTP-2 fingerprint** — signals
Node's `fetch` cannot reproduce — so the POST returns **HTTP 403** even with a
valid login session and a fresh `datadome` cookie. (Read endpoints like history
and article fetch are scored leniently and keep working from Node.)

To make `oe_ask` work end-to-end, the server issues that one POST from inside a
**real browser** attached over the Chrome DevTools Protocol (CDP), then polls for
completion over normal Node requests. `ask()` tries Node first and falls back to
the browser automatically on a DataDome challenge.

**Setup (once per machine):** run a browser with CDP enabled, on a profile that
is logged into OpenEvidence:

```bash
make brave-cdp                 # open -a "Brave Browser" --args --remote-debugging-port=9222
# or any Chromium browser:
#   open -a "Google Chrome" --args --remote-debugging-port=9222
```

Leave it running (normal browsing is fine). Then `oe_ask` works as usual. You can
also run a one-off ask without an MCP client:

```bash
make pw-ask QUESTION="first-line treatment for community-acquired pneumonia"
# or: npm run pw-ask -- --question "..." [--json]
```

If even the in-browser POST returns 403, the OpenEvidence session in that browser
profile is stale — log in and ask one question manually in that window, then retry.
The non-working pure-Node approach (and the full investigation) is preserved in
[archive/](archive/README.md).

## Citation Artifacts

Completed `oe_ask` and `oe_article_get` calls save artifacts under:

```text
/tmp/openevidence-mcp/<article_id>/
```

On macOS, Node may resolve `/tmp` to a path under `/var/folders/.../T/`.

Example output:

```text
answer.md
article.json
citations.json
citations.bib
crossref-validation.json
```

Crossref validation behavior:

- DOI citations are validated directly with Crossref.
- Non-DOI citations use a bibliographic query and are marked as `candidate`, `not_found`, or `error`.
- Low-similarity Crossref matches are not used to overwrite BibTeX metadata.
- Sources like NCCN guidelines may stay as local OpenEvidence metadata because Crossref often has no authoritative match.

## Copyright, Trademark, And Medical Disclaimer

This project is unofficial and independent. It is not affiliated with, endorsed by, sponsored by, or approved by OpenEvidence or its owners. "OpenEvidence" and related names, logos, product names, and content remain the property of their respective owners.

This repository contains connector code only. It does not include OpenEvidence copyrighted content, proprietary datasets, model outputs, article payloads, session cookies, or account material. Your local use of this MCP server may create files such as `answer.md`, `article.json`, and `citations.bib`; those artifacts can contain content retrieved from or derived from your OpenEvidence account session. Treat those files as private unless you have the right to share them.

You are responsible for complying with OpenEvidence terms, institutional policies, copyright law, and any clinical data governance rules that apply to your use. Do not publish cookies, account tokens, saved article payloads, generated answers, screenshots, guideline text, or other protected/copyrighted content unless you have permission or another valid legal basis.

This software is not medical advice and is not a medical device. It is an integration tool for an MCP client. Clinicians and qualified users remain responsible for verifying outputs against authoritative sources and applying independent clinical judgment.

## Cookie Refresh

If auth stops working:

```bash
cp /path/to/fresh-browser-cookies.json ./cookies.json
npm run login
```

Then restart or open a fresh MCP client session if the old stdio server process is still alive.

## Make Targets

| Target                                              | Purpose                                                                           |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| `make deps`                                         | Run `npm install`                                                                 |
| `make build HAR=/path/to/file.har`                  | Extract fingerprint if the HAR exists, then compile TypeScript                    |
| `make check`                                        | Type-check                                                                        |
| `make test`                                         | Run unit tests                                                                    |
| `make smoke`                                        | Validate auth and history access                                                  |
| `make fingerprint HAR=/path/to/file.har`            | Extract the working browser fingerprint from a HAR                                |
| `make brave-cdp`                                    | Launch Brave with CDP (`--remote-debugging-port=9222`) for the browser-backed ask |
| `make pw-ask QUESTION="..."`                        | Run a one-off browser-backed ask via CDP                                          |
| `make import-cookies COOKIES=/path/to/cookies.json` | Import and verify cookies                                                         |
| `make install-claude-global HAR=/path/to/file.har`  | Build, then register with Claude Code user config                                 |
| `make install-codex-global HAR=/path/to/file.har`   | Build, then register with Codex CLI                                               |
| `make install-agy-global HAR=/path/to/file.har`     | Build, then register with Antigravity CLI user config                             |
| `make install-all HAR=/path/to/file.har`            | Build, then register with Claude Code, Codex CLI, and Antigravity CLI             |

## Environment Variables

| Variable                   | Default                                                                   | Purpose                                                               |
| -------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `OE_MCP_BASE_URL`          | `https://www.openevidence.com`                                            | OpenEvidence base URL                                                 |
| `OE_MCP_ROOT_DIR`          | `~/.openevidence-mcp`                                                     | Root for default auth paths                                           |
| `OE_MCP_COOKIES_PATH`      | `./cookies.json` if present, else `~/.openevidence-mcp/auth/cookies.json` | Cookie file                                                           |
| `OE_MCP_AUTH_STATE_PATH`   | unset                                                                     | Legacy alias for `OE_MCP_COOKIES_PATH`                                |
| `OE_MCP_FINGERPRINT_PATH`  | `./openevidence-fingerprint.json` if present                              | Browser signature header fingerprint                                  |
| `OE_MCP_ARTIFACT_DIR`      | OS temp dir + `openevidence-mcp`                                          | Artifact output directory                                             |
| `OE_MCP_CROSSREF_MAILTO`   | unset                                                                     | Optional Crossref polite-pool email                                   |
| `OE_MCP_CROSSREF_VALIDATE` | `1`                                                                       | Set `0` to skip Crossref validation                                   |
| `OE_MCP_POLL_INTERVAL_MS`  | `1200`                                                                    | Poll interval for `oe_ask`                                            |
| `OE_MCP_POLL_TIMEOUT_MS`   | `180000`                                                                  | Default poll timeout                                                  |
| `OE_MCP_CDP_URL`           | `http://localhost:9222`                                                   | CDP endpoint of the browser used for the DataDome-passing ask         |
| `OE_MCP_WEB_ORIGIN`        | same as `OE_MCP_BASE_URL`                                                 | Web origin the browser ask path drives                                |
| `OE_MCP_BROWSER_FALLBACK`  | `1`                                                                       | Set `0` to disable the browser fallback (POST then fails on DataDome) |
| `OE_MCP_ASK_VIA_BROWSER`   | `0`                                                                       | Set `1` to skip the Node POST attempt and go straight to the browser  |
| `OE_MCP_DB_PATH`           | `~/.openevidence-mcp/db/oe.sqlite`                                        | Local SQLite mirror used by the collections tools                     |
| `OE_MCP_PYTHON`            | `python3`                                                                 | Python interpreter the bridge tools spawn                             |

## Project Files

- [README.AI.md](README.AI.md) - agent install playbook
- [examples/codex-config.toml](examples/codex-config.toml) - Codex MCP config
- [examples/claude-desktop-config.json](examples/claude-desktop-config.json) - JSON MCP config
- [src/citations.ts](src/citations.ts) - citation extraction, BibTeX, Crossref validation
- [src/cookies.ts](src/cookies.ts) - cookie file parsing
- [src/server.ts](src/server.ts) - MCP tools
- [src/browser-ask.ts](src/browser-ask.ts) - DataDome-passing ask over CDP (`submitAskViaBrowser`)
- [src/playwright-ask.ts](src/playwright-ask.ts) - standalone `pw-ask` CLI for the browser-backed ask
- [archive/](archive/README.md) - superseded pure-Node ask path + DataDome investigation
- [test/citations.test.ts](test/citations.test.ts) - unit tests

## License And Attribution

Apache-2.0. Keep [LICENSE](LICENSE) and [NOTICE](NOTICE) when redistributing.

Based on OpenEvidence MCP by Bakhtier Sizhaev: `https://github.com/bakhtiersizhaev/openevidence-mcp`
