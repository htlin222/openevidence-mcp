#!/usr/bin/env bash
# Keep the relay daemon running across logins, reboots, and crashes (macOS).
#
# Without this the daemon is spawned on demand by the first MCP call and reaps
# itself after 10 idle minutes — fine for sessions, but the browser extension
# shows "Relay not reachable" in between. This installs a launchd LaunchAgent
# that starts the daemon at login, restarts it if it dies, and disables idle
# reaping (OE_MCP_RELAY_IDLE_TTL_MS=0) so launchd is the only lifecycle owner.
#
# Run from anywhere:
#   bash scripts/install_relay_launchd.sh              install / re-install
#   bash scripts/install_relay_launchd.sh --restart    restart onto the current build (no-op if not installed)
#   bash scripts/install_relay_launchd.sh --status     show state
#   bash scripts/install_relay_launchd.sh --uninstall  remove
set -euo pipefail

LABEL="com.htlin.openevidence-mcp.relay"
LEGACY_LABELS=("com.openevidence-mcp.relay")
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DAEMON="$REPO_DIR/dist/relay-daemon.js"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/$LABEL.plist"
DATA_DIR="$HOME/.openevidence-mcp"
LOG="$DATA_DIR/relay-launchd.log"

if [ "$(uname -s)" != "Darwin" ]; then
  # Lifecycle hooks from the Makefile must be harmless where launchd is absent.
  case "${1:-}" in --restart|--status|--uninstall) exit 0 ;; esac
  echo "relay autostart uses launchd and is macOS-only; on other systems run \`npm run relay\` from your own service manager (set OE_MCP_RELAY_IDLE_TTL_MS=0)." >&2
  exit 1
fi

DOMAIN="gui/$(id -u)"

# Port: explicit env wins, then the repo .env (same precedence the daemon uses).
port() {
  local p="${OE_MCP_RELAY_PORT:-}"
  if [ -z "$p" ] && [ -f "$REPO_DIR/.env" ]; then
    p="$(sed -n 's/^[[:space:]]*OE_MCP_RELAY_PORT[[:space:]]*=[[:space:]]*//p' "$REPO_DIR/.env" | tail -1 | tr -d "\"' ")"
  fi
  printf '%s' "${p:-8787}"
}

loaded() { launchctl print "$DOMAIN/$1" >/dev/null 2>&1; }

remove_label() {
  local label="$1" plist="$PLIST_DIR/$1.plist"
  if loaded "$label"; then launchctl bootout "$DOMAIN/$label" 2>/dev/null || true; fi
  if [ -f "$plist" ]; then rm -f "$plist"; echo "removed $plist"; fi
}

wait_health() {
  local p; p="$(port)"
  for _ in $(seq 1 40); do
    if curl -s --max-time 1 "http://127.0.0.1:$p/health" >/dev/null 2>&1; then return 0; fi
    sleep 0.25
  done
  return 1
}

status() {
  if loaded "$LABEL"; then
    local pid
    pid="$(launchctl print "$DOMAIN/$LABEL" | sed -n 's/^[[:space:]]*pid = //p' | head -1)"
    if [ -n "$pid" ]; then
      echo "autostart: installed (launchd $LABEL, pid $pid)"
    else
      echo "autostart: installed (launchd $LABEL, not running — launchd will retry)"
    fi
  elif [ -f "$PLIST" ]; then
    echo "autostart: plist present but not loaded — re-run: bash scripts/install_relay_launchd.sh"
  else
    echo "autostart: not installed (make autostart)"
  fi
}

restart() {
  if ! loaded "$LABEL"; then return 0; fi
  launchctl kickstart -k "$DOMAIN/$LABEL" >/dev/null
  if wait_health; then echo "relay restarted under launchd on :$(port)"; else
    echo "relay did not come back on :$(port) — see $LOG" >&2; return 1
  fi
}

case "${1:-}" in
  --uninstall)
    remove_label "$LABEL"
    for l in "${LEGACY_LABELS[@]}"; do remove_label "$l"; done
    echo "relay autostart removed (the daemon is spawned on demand again)."
    exit 0 ;;
  --status) status; exit 0 ;;
  --restart) restart; exit $? ;;
  "") ;;
  *) echo "unknown option: $1" >&2; exit 2 ;;
esac

[ -f "$DAEMON" ] || { echo "missing $DAEMON — build first (make build)." >&2; exit 1; }
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "node not found on PATH." >&2; exit 1; }
PORT="$(port)"

mkdir -p "$PLIST_DIR" "$DATA_DIR"
for l in "${LEGACY_LABELS[@]}"; do remove_label "$l"; done
if loaded "$LABEL"; then launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true; fi

# Hand the port over cleanly: an on-demand daemon still holding it would make
# the launchd one lose the bind race and exit.
pkill -f "$DAEMON" 2>/dev/null || true
for _ in $(seq 1 20); do
  lsof -ti "tcp:$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break
  sleep 0.25
done

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$DAEMON</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$REPO_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OE_MCP_RELAY_PORT</key>
    <string>$PORT</string>
    <key>OE_MCP_RELAY_IDLE_TTL_MS</key>
    <string>0</string>
    <key>PATH</key>
    <string>$(dirname "$NODE_BIN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>
</dict>
</plist>
EOF
plutil -lint "$PLIST" >/dev/null

: > "$LOG"
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl enable "$DOMAIN/$LABEL"

if wait_health; then
  echo "relay autostart installed: launchd keeps the daemon on :$PORT (starts at login, restarts on crash)."
  echo "  log:     $LOG"
  echo "  remove:  bash scripts/install_relay_launchd.sh --uninstall"
else
  echo "installed, but the relay did not answer on :$PORT — see $LOG" >&2
  exit 1
fi
