NODE ?= node
NPM ?= npm
PYTHON ?= python3
CLAUDE ?= claude
CODEX ?= codex
AGY ?= agy-cli
MCP_NAME ?= openevidence
# Single source of truth for the relay port is .env (OE_MCP_RELAY_PORT); the
# extension build and the MCP client env read the same value. Hardcoding it
# here is what caused the 8787/8780 drift.
ENV_RELAY_PORT := $(shell awk -F= '/^[[:space:]]*OE_MCP_RELAY_PORT[[:space:]]*=/ {gsub(/[[:space:]"]/,"",$$2); print $$2}' $(CURDIR)/.env 2>/dev/null)
RELAY_PORT ?= $(if $(ENV_RELAY_PORT),$(ENV_RELAY_PORT),8787)
RELAY_PID ?= $(HOME)/.openevidence-mcp/relay-$(RELAY_PORT).pid
COOKIES ?= $(CURDIR)/cookies.json
HAR ?= $(CURDIR)/www.openevidence.com_dotflow.har
HAR_MINE ?= $(CURDIR)/www.openevidence.com_dotflow_mine.har
FINGERPRINT ?= $(CURDIR)/openevidence-fingerprint.json
ifeq ($(origin HAR), command line)
FINGERPRINT_HAR ?= $(HAR)
else
FINGERPRINT_HAR ?= $(CURDIR)/www.openevidence.com.har
endif
SERVER := $(CURDIR)/dist/server.js
VERSION := $(shell $(NODE) -p "require('$(CURDIR)/package.json').version")
EXT_VERSION := $(shell $(NODE) -p "require('$(CURDIR)/extension/package.json').version")

.PHONY: all help deps build extension rebuild reinstall check test smoke fingerprint import-cookies update-dotflows update-dotflows-from-har sync-mine sync-mine-from-har install-claude-global install-codex-global install-agy-global install-all remove-claude-global remove-codex-global remove-agy-global reinstall-claude-global reinstall-codex-global reinstall-agy-global release publish release-extension kill-all reap clean remove-all update cleanup uninstall status

# One command does the whole setup: install deps, build the MCP server
# (dist/server.js) + the relay extension (extension/dist), and register the
# server into Claude and Codex (whichever CLI is installed). Default goal, so a
# bare `make` is the full install. The ONLY manual step left is loading the
# browser extension (a chrome:// GUI action that can't be scripted) — printed
# at the end.
all: node_modules build extension install-claude-global install-codex-global
	@printf '\n\033[32m✅  Built and registered into your AI CLIs.\033[0m\n'
	@printf '\033[1m👉  Last step (one time): load the browser extension\033[0m\n'
	@printf '      1. open  chrome://extensions  (Chrome / Edge / Brave / Arc …)\n'
	@printf '      2. turn on  Developer mode  (top-right)\n'
	@printf '      3. Load unpacked  →  %s\n' "$(CURDIR)/extension/dist"
	@printf '      4. stay logged in to openevidence.com in that browser\n'
	@printf '   verify:  curl -s http://127.0.0.1:$(RELAY_PORT)/health   (expect connected:true)\n\n'

help:
	@printf '\033[1mOpenEvidence MCP — make targets\033[0m  (bare \`make\` == \`make all\`)\n\n'
	@printf '\033[1mSetup (start here):\033[0m\n'
	@printf '  make all            one-shot: deps + build server + build extension + register into Claude & Codex,\n'
	@printf '                      then load the extension (chrome://extensions -> Load unpacked -> extension/dist)\n'
	@printf '  make kill-all       stop all MCP servers + the relay daemon (free port %s)\n' "$(RELAY_PORT)"
	@printf '  make reap           garbage-collect orphaned relay daemons (keep the live one on :%s)\n' "$(RELAY_PORT)"
	@printf '\n\033[1mBuild & verify:\033[0m\n'
	@printf '  make build [HAR=…]  compile dist/server.js (wipes dist/ first; extracts fingerprint from HAR if given)\n'
	@printf '  make extension      build the browser relay extension (wipes extension/dist/ first)\n'
	@printf '  make rebuild        kill all running servers/daemons, then build fresh\n'
	@printf '  make reinstall      kill all, build fresh, then re-register into Claude & Codex\n'
	@printf '  make deps           force a fresh npm install\n'
	@printf '  make check / test / smoke    type-check / unit tests / auth+history smoke (cookie path)\n'
	@printf '\n\033[1mRegister / unregister an AI CLI (HAR optional):\033[0m\n'
	@printf '  make install-claude-global / install-codex-global / install-agy-global\n'
	@printf '  make install-all    register with all three\n'
	@printf '  make remove-claude-global / remove-codex-global / remove-agy-global\n'
	@printf '\n\033[1mAuth & data (cookie path / Python tooling — optional):\033[0m\n'
	@printf '  make import-cookies COOKIES=…   import + verify cookies\n'
	@printf '  make fingerprint HAR=…          extract the browser fingerprint from a HAR\n'
	@printf '  make update-dotflows / sync-mine    collections tooling\n'
	@printf '\n\033[1mRelease:\033[0m\n'
	@printf '  make release / publish / release-extension      make clean (remove dist/)\n\n'

# Install npm deps only when package.json changes — keeps repeat `make` fast.
node_modules: package.json
	$(NPM) install
	@touch node_modules

# Force a fresh dependency install.
deps:
	$(NPM) install

# Always start from a clean dist/ so stale artifacts can never survive a rebuild.
build:
	rm -rf "$(CURDIR)/dist"
	@if [ -f "$(FINGERPRINT_HAR)" ]; then \
		$(NPM) run fingerprint -- --har "$(FINGERPRINT_HAR)" --out "$(FINGERPRINT)"; \
	else \
		echo "[build] no HAR found at $(FINGERPRINT_HAR); using existing/default fingerprint"; \
	fi
	$(NPM) run build

# Wipe extension/dist/ first — build.mjs only mkdir's, so a stale .crx or
# renamed file would otherwise linger across rebuilds.
extension:
	rm -rf "$(CURDIR)/extension/dist"
	cd $(CURDIR)/extension && $(NPM) install && OE_MCP_RELAY_PORT="$(RELAY_PORT)" $(NPM) run build

# Stop every running server/daemon, then build the server fresh from a clean
# dist/. The everyday "I changed source, give me a clean running build" cycle.
rebuild:
	$(MAKE) kill-all
	$(MAKE) build

# Same as rebuild, then re-register the fresh server into Claude + Codex.
# Use after changing how the server is launched/registered, not just its code.
reinstall:
	$(MAKE) kill-all
	$(MAKE) extension install-claude-global install-codex-global

check:
	$(NPM) run check

test:
	$(NPM) test

smoke:
	OE_MCP_COOKIES_PATH="$(COOKIES)" $(NPM) run smoke

fingerprint:
	$(NPM) run fingerprint -- --har "$(FINGERPRINT_HAR)" --out "$(FINGERPRINT)"

import-cookies:
	OE_MCP_COOKIES_PATH="$(COOKIES)" $(NPM) run import-cookies -- --import "$(COOKIES)"

update-dotflows:
	$(PYTHON) $(CURDIR)/scripts/update_dotflows.py --cookies "$(COOKIES)" --from-har-fallback

update-dotflows-from-har:
	$(PYTHON) $(CURDIR)/scripts/update_dotflows.py --har "$(HAR)"

sync-mine:
	$(PYTHON) $(CURDIR)/scripts/dotflow_mine.py --cookies "$(COOKIES)" sync --from-har-fallback

sync-mine-from-har:
	$(PYTHON) $(CURDIR)/scripts/dotflow_mine.py sync --har "$(HAR_MINE)"

install-claude-global: build
	@if command -v $(CLAUDE) >/dev/null 2>&1; then \
		$(CLAUDE) mcp remove --scope user $(MCP_NAME) >/dev/null 2>&1 || true; \
		$(CLAUDE) mcp add-json --scope user $(MCP_NAME) "$$(node -e 'const [command, server, cookies, port] = process.argv.slice(1); process.stdout.write(JSON.stringify({ type: "stdio", command, args: [server], env: { OE_MCP_COOKIES_PATH: cookies, OE_MCP_RELAY_PORT: port } }));' "$(NODE)" "$(SERVER)" "$(COOKIES)" "$(RELAY_PORT)")"; \
		echo "[ok] registered '$(MCP_NAME)' with Claude (user scope)"; \
	else \
		echo "[skip] '$(CLAUDE)' CLI not found — skipping Claude registration"; \
	fi

install-codex-global: build
	@if command -v $(CODEX) >/dev/null 2>&1; then \
		$(CODEX) mcp remove $(MCP_NAME) >/dev/null 2>&1 || true; \
		$(CODEX) mcp add $(MCP_NAME) --env OE_MCP_COOKIES_PATH="$(COOKIES)" --env OE_MCP_RELAY_PORT="$(RELAY_PORT)" -- $(NODE) "$(SERVER)"; \
		echo "[ok] registered '$(MCP_NAME)' with Codex"; \
	else \
		echo "[skip] '$(CODEX)' CLI not found — skipping Codex registration"; \
	fi

install-agy-global: build
	$(AGY) mcp remove --scope user $(MCP_NAME) >/dev/null 2>&1 || true
	$(AGY) mcp add --scope user -e OE_MCP_COOKIES_PATH="$(COOKIES)" -e OE_MCP_RELAY_PORT="$(RELAY_PORT)" $(MCP_NAME) $(NODE) "$(SERVER)"

install-all: install-claude-global install-codex-global install-agy-global

remove-claude-global:
	$(CLAUDE) mcp remove --scope user $(MCP_NAME)

remove-codex-global:
	$(CODEX) mcp remove $(MCP_NAME)

remove-agy-global:
	$(AGY) mcp remove --scope user $(MCP_NAME)

reinstall-claude-global: install-claude-global

reinstall-codex-global: install-codex-global

reinstall-agy-global: install-agy-global

release: build check test
	@echo "==> release v$(VERSION)"
	git tag -a "v$(VERSION)" -m "Release v$(VERSION)"
	git push origin "v$(VERSION)"
	gh release create "v$(VERSION)" --title "v$(VERSION)" --generate-notes

publish: build check test
	$(NPM) publish

release-extension: extension
	@echo "==> tag extension-v$(EXT_VERSION) (CI builds + signs + attaches zip/crx)"
	git tag -a "extension-v$(EXT_VERSION)" -m "extension-v$(EXT_VERSION)"
	git push origin "extension-v$(EXT_VERSION)"

kill-all:
	@echo "==> stopping OpenEvidence MCP servers + relay daemon"
	@if pkill -f "$(CURDIR)/dist/server.js" 2>/dev/null; then echo "  killed MCP server(s)"; else echo "  no MCP server running"; fi
	@if pkill -f "$(CURDIR)/dist/relay-daemon.js" 2>/dev/null; then echo "  killed relay daemon"; else echo "  no relay daemon running"; fi
	@pid=$$(lsof -ti tcp:$(RELAY_PORT) 2>/dev/null); if [ -n "$$pid" ]; then kill $$pid 2>/dev/null && echo "  freed port $(RELAY_PORT) (pid $$pid)"; fi
	@rm -f "$(RELAY_PID)" 2>/dev/null || true
	@echo "  done. (reconnect /mcp in any open client session to respawn a fresh server)"

reap:
	@echo "==> reaping orphaned relay daemons (keeping the live one on :$(RELAY_PORT))"
	@keep=$$(lsof -ti tcp:$(RELAY_PORT) 2>/dev/null | head -1); \
	reaped=0; \
	for pid in $$(pgrep -f "$(CURDIR)/dist/relay-daemon.js" 2>/dev/null); do \
	  if [ "$$pid" != "$$keep" ]; then \
	    if kill $$pid 2>/dev/null; then echo "  reaped orphan daemon pid $$pid"; reaped=$$((reaped+1)); fi; \
	  fi; \
	done; \
	if [ "$$reaped" -eq 0 ]; then echo "  no orphan daemons found"; fi; \
	if [ -n "$$keep" ]; then echo "  kept canonical daemon pid $$keep on :$(RELAY_PORT)"; else echo "  (no daemon currently on :$(RELAY_PORT))"; fi

clean:
	rm -rf "$(CURDIR)/dist" "$(CURDIR)/extension/dist"

# ---- lifecycle convenience targets (wrapped by the install skill) -------------

# Unregister from every AI CLI that has it, skipping CLIs that aren't installed.
remove-all:
	@command -v $(CLAUDE) >/dev/null 2>&1 && { $(CLAUDE) mcp remove --scope user $(MCP_NAME) >/dev/null 2>&1 && echo "[ok] removed from Claude" || echo "[--] not registered in Claude"; } || true
	@command -v $(CODEX) >/dev/null 2>&1 && { $(CODEX) mcp remove $(MCP_NAME) >/dev/null 2>&1 && echo "[ok] removed from Codex" || echo "[--] not registered in Codex"; } || true
	@command -v $(AGY) >/dev/null 2>&1 && { $(AGY) mcp remove --scope user $(MCP_NAME) >/dev/null 2>&1 && echo "[ok] removed from agy" || true; } || true

# Pull the latest release, rebuild the server + extension, re-register. The one
# manual step left is reloading the browser extension (a chrome:// GUI action).
update:
	@echo "==> updating openevidence-mcp"
	git fetch --tags --quiet || true
	git pull --ff-only
	$(MAKE) kill-all
	$(MAKE) deps build extension install-claude-global install-codex-global
	@printf '\n\033[32m✅  Updated — server v%s · extension v%s\033[0m\n' \
		"$$($(NODE) -p "require('$(CURDIR)/package.json').version")" \
		"$$($(NODE) -p "require('$(CURDIR)/extension/package.json').version")"
	@printf '\033[1m👉  Reload the browser extension\033[0m to pick up the new relay build:\n'
	@printf '      chrome://extensions  →  Reload  on "OpenEvidence MCP Relay"\n'
	@printf '   then reconnect /mcp in your AI client.\n\n'

# Reap orphan daemons, free stale state — WITHOUT unregistering or touching data.
cleanup:
	@echo "==> cleaning transient relay state (install + your data are kept)"
	-$(MAKE) reap
	@find "$(HOME)/.openevidence-mcp" -name 'relay-*.log' -size +5M -delete 2>/dev/null && echo "  pruned large relay logs" || true
	@rm -rf "$${TMPDIR:-/tmp}/openevidence-mcp" 2>/dev/null && echo "  cleared temp answer artifacts" || true
	@echo "[ok] done."

# Remove the MCP everywhere: stop daemons, unregister from CLIs, delete builds.
# Deliberately leaves ~/.openevidence-mcp (your db + config) and the browser
# extension in place — a full wipe is a manual, explicit step (printed below).
uninstall: remove-all
	@echo "==> uninstalling openevidence-mcp"
	-$(MAKE) kill-all
	$(MAKE) clean
	@printf '[ok] unregistered from AI CLIs, stopped daemons, removed dist/.\n'
	@printf 'Kept (remove by hand for a full wipe):\n'
	@printf '  * data + answers db:  rm -rf ~/.openevidence-mcp\n'
	@printf '  * browser extension:  chrome://extensions -> Remove "OpenEvidence MCP Relay"\n'

# One-glance health: versions, live relay, registration.
status:
	@printf '==> openevidence-mcp status\n'
	@printf 'repo:      %s\n' "$(CURDIR)"
	@printf 'version:   server v%s  ·  extension v%s\n' "$(VERSION)" "$(EXT_VERSION)"
	@printf 'relay:     '; curl -s --max-time 2 http://127.0.0.1:$(RELAY_PORT)/health || printf '(not reachable on :%s)' "$(RELAY_PORT)"; printf '\n'
	@command -v $(CLAUDE) >/dev/null 2>&1 && { printf 'claude:    '; $(CLAUDE) mcp list 2>/dev/null | grep -qi $(MCP_NAME) && printf 'registered\n' || printf 'not registered\n'; } || true
	@command -v $(CODEX) >/dev/null 2>&1 && { printf 'codex:     '; $(CODEX) mcp list 2>/dev/null | grep -qi $(MCP_NAME) && printf 'registered\n' || printf 'not registered\n'; } || true
