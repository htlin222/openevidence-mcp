# OpenEvidence MCP Relay (Chromium extension)

Works on **any Chromium-based browser** — Chrome, Edge, Brave, Arc, Vivaldi,
Opera. It's a standard MV3 extension (`chrome.*` APIs only); the same unpacked
folder / `.crx` loads in all of them.

It lets the MCP server run OpenEvidence requests **from inside your own logged-in
tab**, so they carry the browser's genuine origin, cookies, and TLS — DataDome
sees a normal session. It is a **narrowly allowlisted authenticated fetch bridge**:
it runs only the OpenEvidence methods and paths accepted by the local daemon.
All OpenEvidence logic stays in Node.

It is **localhost-only**: the extension talks to `http://127.0.0.1:8787` (the
shared relay daemon the MCP server auto-spawns, which outlives every session) and
never to any third party.

## How it works

```
oe_ask ──► MCP server ── relay.request(POST /api/article) ──► relay (127.0.0.1:8787)
                                                                   │ GET /poll (long-poll;
                                                                   │ also keeps the worker alive)
                                                                   ▼
                                                       extension service worker
                                                                   │ runs the fetch INSIDE a
                                                                   │ pinned OpenEvidence tab
                                                                   ▼  (real origin/cookies/TLS)
                                                       reads {status, body} ─ POST /result ─► relay
MCP server ◄── article id ── relay ;  answer fetched later via oe_article_get
```

`oe_ask` is **fire-and-forget by default**: it returns `{article_id,
status:"pending"}` immediately (it does *not* block on the answer), and the answer
is fetched later via `oe_article_get(article_id)`.

The extension keeps **one pinned, background OpenEvidence tab** (tracked by tab
id, so it never touches a tab you opened yourself) and runs the request there.
No visible navigation — the tab just sits on openevidence.com.

That parked tab loads the lightest possible same-origin document —
`openevidence.com/robots.txt` (text/plain), **not** the full web app. It still
carries the openevidence.com origin, cookies, and TLS that DataDome checks (a
`POST /api/article` from it is accepted), while loading zero app scripts. This
keeps the tab's memory footprint tiny (~100 MB less than parking on the SPA) and
means the parked tab fires **no** background requests at OpenEvidence, so it
never quietly spends your account's rate-limit budget.

## Which browser handles a call

The daemon leases itself to the **first live installation** of this extension,
identified by a random per-install capability. It will not mix requests across
browser profiles. To switch profiles, stop the active extension and wait about
35 seconds with no pending request before connecting the intended profile.

- **Install it in the browser you're logged into OpenEvidence with.** The in-tab
  request uses *that* browser's session; if that browser isn't logged in, the call
  fails with a 401/403 (the server says so).
- **Keep one Chromium logged into openevidence.com with the extension loaded.**
  That single tab serves *all* concurrent Claude/Codex sessions through the shared
  relay daemon. The daemon leases itself to one extension installation and rejects
  other browser profiles instead of silently mixing their requests.

## Build

Standalone sub-project (own `package.json`; the root `openevidence-mcp` package
carries none of its build deps). Build the loadable artifact into `extension/dist/`:

```
make extension          # from the repo root (runs npm install + build here)
# or, inside extension/:
npm install && npm run build
```

`npm run check` typechecks. The relay port is baked in from `OE_MCP_RELAY_PORT`
(default `8787`) — rebuild if you change it.

## Install (one time)

1. Build it (above) so `extension/dist/` exists — or download the zip from the
   [extension release](https://github.com/htlin222/openevidence-mcp/releases/tag/extension-v0.1.0).
2. Open your browser's extensions page (`chrome://extensions`, `edge://extensions`,
   `brave://extensions`, …).
3. Toggle **Developer mode** on.
4. Click **Load unpacked** and select the **`extension/dist/`** folder.
5. Make sure you are **logged in to openevidence.com** in *this* browser.

The service worker auto-connects to the relay and reconnects on browser restart.
On its first in-tab request the browser may ask once to allow access to
openevidence.com — allow it.

## Use

- The MCP server auto-spawns the shared relay daemon on first use; it stays up
  across sessions, so no manual restart is needed.
- Ask as usual (`oe_ask`). The server submits the POST through this extension; if
  no extension is connected, `oe_ask` fails fast with this guidance.
- The first ask creates the pinned OE tab; leave it open (it's reused).

## Config

- Relay port: `OE_MCP_RELAY_PORT` on the server (default `8787`), baked into the
  extension at build time — set it before `make extension` and rebuild + reload if
  you change it.
- Disable the relay entirely: `OE_MCP_RELAY=0` on the server.
- Daemon PID file: `OE_MCP_RELAY_PID_PATH` (default `~/.openevidence-mcp/relay.pid`).
- Daemon log file: `OE_MCP_RELAY_LOG_PATH` (default `~/.openevidence-mcp/relay.log`).

## Checking it's connected

Three ways, quickest first:

- **Toolbar badge** — the extension icon carries a live connection light: **green**
  = relay connected and idle, **blue** = a request is in flight, **grey** = the
  relay isn't reachable. No clicking needed.
- **Status page** — click the toolbar icon. Beyond the green/red connection badge,
  it shows a **live activity feed** of what the relay is doing — "🔍 Asked a
  question", "📄 Fetched answer", "🔑 Checked login" — each with a timestamp,
  duration, and HTTP status, updating in real time. A whole `oe_ask` (submit +
  poll-to-completion) collapses into a couple of lines rather than flooding the
  feed. The activity history lives in a bounded `storage.local` ring buffer; the
  Clear button empties it.
- **curl** — with the server running: `curl http://127.0.0.1:8787/health` →
  `{"ok":true,"connected":true,"version":1,"pid":12345}` once the extension is
  polling. (This is the same endpoint the MCP server's `oe_health` tool reads.)
