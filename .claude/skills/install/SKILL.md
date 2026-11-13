---
name: install
description: Install, update, clean up, uninstall, or check the status of openevidence-mcp on this machine. Use when the user wants to set up openevidence-mcp, update to the latest release, register/unregister the MCP server with Claude/Codex, reap stray relay daemons, or verify the install. Trigger phrases include "install openevidence-mcp", "update openevidence-mcp", "uninstall openevidence-mcp", "openevidence-mcp 更新 / 安裝 / 移除 / 清理", "reap relay daemon", "is openevidence-mcp registered".
allowed-tools: Bash, Read
version: 1.0.0
license: MIT
---

# openevidence-mcp — install / update / cleanup / uninstall

One skill to set up, update, and tear down [openevidence-mcp](https://github.com/htlin222/openevidence-mcp)
on this machine. Everything here wraps the repo `Makefile`, so it stays in sync with
the canonical install flow — the skill never reimplements it.

The single entry point is `scripts/oe-mcp.sh` (a thin dispatcher over `make`).
Run the subcommand that matches the user's intent, then read the printed guidance
back to them — especially the **reload the browser extension** step, which is a
`chrome://` GUI action that cannot be scripted.

## Pick the action

| User wants…                                            | Run                           |
| ------------------------------------------------------ | ----------------------------- |
| First-time setup                                       | `scripts/oe-mcp.sh install`   |
| **Update to the latest release**                       | `scripts/oe-mcp.sh update`    |
| Check it's working                                     | `scripts/oe-mcp.sh status`    |
| Relay should survive reboots / "start at boot" (macOS) | `scripts/oe-mcp.sh autostart` |
| Reap stray daemons / free stale state                  | `scripts/oe-mcp.sh cleanup`   |
| Remove it                                              | `scripts/oe-mcp.sh uninstall` |

Invoke the script by its path from the skill directory, e.g.:

```bash
bash "$CLAUDE_SKILL_DIR/scripts/oe-mcp.sh" update
```

If `$CLAUDE_SKILL_DIR` is not set, use the repo path directly:
`.claude/skills/install/scripts/oe-mcp.sh <command>`.

## What each action does (all via `make`)

- **install** — `make all`: installs deps, builds the MCP server (`dist/server.js`)
  and the relay extension (`extension/dist`), and registers the server into Claude
  and Codex (whichever CLI is present). If run outside a checkout, it clones the
  repo to `$HOME/openevidence-mcp` first (override with `OE_MCP_DIR`).
- **update** — `make update`: `git pull` the latest release, rebuild server +
  extension, re-register. Prints the extension-reload reminder.
- **status** — `make status`: server + extension versions, live relay `/health`,
  and whether the CLIs have it registered.
- **autostart** — `make autostart`: installs a launchd LaunchAgent so the relay
  daemon starts at login, restarts on crash and never idle-reaps. Undo with
  `make autostart-remove`. The browser (extension + logged-in tab) must still be
  running — suggest adding it to macOS Login Items.
- **cleanup** — `make cleanup`: reaps orphan relay daemons (keeps the live one),
  prunes oversized relay logs and temp answer artifacts. **Non-destructive** —
  your install, registration, and `~/.openevidence-mcp` data are untouched. The
  relay auto-respawns on the next MCP call.
- **uninstall** — `make uninstall`: unregisters from the AI CLIs, stops daemons,
  removes `dist/`. Deliberately **keeps** `~/.openevidence-mcp` (your SQLite db +
  config) and the loaded browser extension — the skill should tell the user the
  two manual commands to fully wipe those, and only run them if explicitly asked.

## The one manual step (install & update)

Loading/reloading the browser extension is a `chrome://extensions` GUI action —
you cannot do it for the user. After install/update, tell them exactly:

1. Open `chrome://extensions` (Chrome / Edge / Brave / Arc / Vivaldi / Opera).
2. Turn on **Developer mode**. First time: **Load unpacked** → select
   `<repo>/extension/dist`. After an update: click **Reload** on
   "OpenEvidence MCP Relay".
3. Stay logged in to [openevidence.com](https://www.openevidence.com) in that browser.
4. Reconnect `/mcp` in the AI client.

Then verify: `curl -s http://127.0.0.1:8787/health` → expect `"connected":true`.

## Notes

- These are host-level, reversible operations; run the matching command directly.
  Only the full-wipe commands printed by `uninstall` are destructive — get
  explicit confirmation before running those.
- The skill is host-specific: it acts on the machine it runs on. Nothing here
  touches the user's OpenEvidence account or data on the server side.
