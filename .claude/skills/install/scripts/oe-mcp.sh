#!/usr/bin/env bash
# oe-mcp.sh — install / update / cleanup / uninstall / status for openevidence-mcp.
# A thin, friendly wrapper over the repo Makefile. Safe to run standalone or via
# the install skill. Every action just composes existing `make` targets.
set -euo pipefail

REPO_URL="https://github.com/htlin222/openevidence-mcp.git"
CLONE_DIR="${OE_MCP_DIR:-$HOME/openevidence-mcp}"

c_grn=$'\033[32m'; c_bld=$'\033[1m'; c_red=$'\033[31m'; c_rst=$'\033[0m'
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✅  %s%s\n' "$c_grn" "$*" "$c_rst"; }
note() { printf '%s👉  %s%s\n' "$c_bld" "$*" "$c_rst"; }
die()  { printf '%s✗  %s%s\n' "$c_red" "$*" "$c_rst" >&2; exit 1; }

# Locate the repo root by walking up from this script; fall back to $CLONE_DIR.
find_repo() {
  local d
  d="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  while [ "$d" != "/" ]; do
    if [ -f "$d/Makefile" ] && grep -q '"name": *"openevidence-mcp"' "$d/package.json" 2>/dev/null; then
      printf '%s\n' "$d"; return 0
    fi
    d="$(dirname "$d")"
  done
  [ -f "$CLONE_DIR/Makefile" ] && { printf '%s\n' "$CLONE_DIR"; return 0; }
  return 1
}

reload_reminder() {
  note "Reload the browser extension to pick up the new relay build:"
  say  "      chrome://extensions  →  turn on Developer mode  →  Reload  on \"OpenEvidence MCP Relay\""
  say  "      (first-time load: Load unpacked → select  <repo>/extension/dist)"
  say  "   then reconnect /mcp in your AI client, and stay logged in to openevidence.com."
}

cmd_install() {
  local repo
  if repo="$(find_repo)"; then
    say "==> installing from existing checkout: $repo"
  else
    command -v git >/dev/null 2>&1 || die "git not found — install git first."
    say "==> cloning $REPO_URL -> $CLONE_DIR"
    git clone "$REPO_URL" "$CLONE_DIR"
    repo="$CLONE_DIR"
  fi
  make -C "$repo" all
  ok "Installed."
  reload_reminder
}

cmd_update() {
  local repo; repo="$(find_repo)" || die "no openevidence-mcp checkout found. Run: $0 install"
  make -C "$repo" update
}

cmd_cleanup() {
  local repo; repo="$(find_repo)" || die "no openevidence-mcp checkout found."
  make -C "$repo" cleanup
}

cmd_uninstall() {
  local repo; repo="$(find_repo)" || die "no openevidence-mcp checkout found."
  make -C "$repo" uninstall
}

cmd_autostart() {
  local repo; repo="$(find_repo)" || die "no openevidence-mcp checkout found. Run: $0 install"
  make -C "$repo" autostart
}

cmd_status() {
  local repo; repo="$(find_repo)" || die "no openevidence-mcp checkout found. Run: $0 install"
  make -C "$repo" status
}

usage() {
  cat <<EOF
oe-mcp.sh — manage openevidence-mcp

  install     clone (if needed), build server + extension, register into your AI CLIs
  update      git pull latest release, rebuild + re-register  (then reload the extension)
  status      show versions, live relay health, and CLI registration
  autostart   macOS: keep the relay daemon running across logins/reboots (launchd)
  cleanup     reap orphan relay daemons + prune stale logs/temp  (keeps install + data)
  uninstall   unregister from AI CLIs, stop daemons, remove builds  (keeps ~/.openevidence-mcp)

Env: OE_MCP_DIR overrides the clone/lookup dir (default: \$HOME/openevidence-mcp)
EOF
}

case "${1:-}" in
  install)   cmd_install ;;
  update)    cmd_update ;;
  cleanup)   cmd_cleanup ;;
  uninstall) cmd_uninstall ;;
  status)    cmd_status ;;
  autostart) cmd_autostart ;;
  ""|-h|--help|help) usage ;;
  *) usage; die "unknown command: $1" ;;
esac
