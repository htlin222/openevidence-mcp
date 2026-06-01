NODE ?= node
NPM ?= npm
PYTHON ?= python3
CLAUDE ?= claude
CODEX ?= codex
AGY ?= agy-cli
MCP_NAME ?= openevidence
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
CDP_PORT ?= 9222
BRAVE ?= Brave Browser
QUESTION ?=

.PHONY: deps build check test smoke fingerprint brave-cdp pw-ask import-cookies update-dotflows update-dotflows-from-har sync-mine sync-mine-from-har install-claude-global install-codex-global install-agy-global install-all remove-claude-global remove-codex-global remove-agy-global reinstall-claude-global reinstall-codex-global reinstall-agy-global clean

deps:
	$(NPM) install

build:
	@if [ -f "$(FINGERPRINT_HAR)" ]; then \
		$(NPM) run fingerprint -- --har "$(FINGERPRINT_HAR)" --out "$(FINGERPRINT)"; \
	else \
		echo "[build] no HAR found at $(FINGERPRINT_HAR); using existing/default fingerprint"; \
	fi
	$(NPM) run build

check:
	$(NPM) run check

test:
	$(NPM) test

smoke:
	OE_MCP_COOKIES_PATH="$(COOKIES)" $(NPM) run smoke

fingerprint:
	$(NPM) run fingerprint -- --har "$(FINGERPRINT_HAR)" --out "$(FINGERPRINT)"

# Launch a CDP-enabled browser (logged into OpenEvidence) for the DataDome-passing
# ask path. POST /api/article is bot-gated and only succeeds from a real browser.
brave-cdp:
	open -a "$(BRAVE)" --args --remote-debugging-port=$(CDP_PORT)

# Run a one-off browser-backed ask: make pw-ask QUESTION="..."
pw-ask:
	$(NPM) run pw-ask -- --question "$(QUESTION)" --cdp "http://localhost:$(CDP_PORT)"

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
	$(CLAUDE) mcp remove --scope user $(MCP_NAME) >/dev/null 2>&1 || true
	$(CLAUDE) mcp add-json --scope user $(MCP_NAME) "$$(node -e 'const [command, server, cookies] = process.argv.slice(1); process.stdout.write(JSON.stringify({ type: "stdio", command, args: [server], env: { OE_MCP_COOKIES_PATH: cookies } }));' "$(NODE)" "$(SERVER)" "$(COOKIES)")"

install-codex-global: build
	$(CODEX) mcp remove $(MCP_NAME) >/dev/null 2>&1 || true
	$(CODEX) mcp add $(MCP_NAME) --env OE_MCP_COOKIES_PATH="$(COOKIES)" -- $(NODE) "$(SERVER)"

install-agy-global: build
	$(AGY) mcp remove --scope user $(MCP_NAME) >/dev/null 2>&1 || true
	$(AGY) mcp add --scope user -e OE_MCP_COOKIES_PATH="$(COOKIES)" $(MCP_NAME) $(NODE) "$(SERVER)"

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

clean:
	rm -rf dist
