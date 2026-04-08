<h1 align="center">OpenEvidence MCP - AI Agent Install Playbook</h1>

<p align="center">
  Runbook for Codex, Claude Code, and similar agents to install and validate OpenEvidence MCP end-to-end.
</p>

<p align="center">
  <a href="README.md">Human Guide</a> •
  <a href="https://github.com/htlin222/openevidence-mcp">Live Docs</a> •
  <a href="docs/SEMANTIC_CORE.md">Semantic Core</a>
</p>

## Goal

Install and validate OpenEvidence MCP on macOS, Windows, or Ubuntu, using a browser-exported OpenEvidence `cookies.json`.

## Scope

- Agent checks runtime and MCP availability
- Agent installs missing dependencies
- Agent sets up OpenEvidence MCP
- Human provides browser-exported OpenEvidence cookies
- Agent verifies MCP tools are live

## Step 0: Detect Environment

- OS: macOS, Windows, Ubuntu/Linux
- Host client:
  - Codex CLI
  - Claude Desktop / Claude Code
  - Other MCP client

## Step 1: Install OpenEvidence MCP Repo

### macOS

```bash
cd /path/where/repo/should/live
git clone https://github.com/htlin222/openevidence-mcp.git openevidence-mcp
cd openevidence-mcp
./scripts/setup-macos.sh
```

### Ubuntu/Linux

```bash
cd /path/where/repo/should/live
git clone https://github.com/htlin222/openevidence-mcp.git openevidence-mcp
cd openevidence-mcp
./scripts/setup-ubuntu.sh
```

### Windows (PowerShell)

```powershell
cd C:\path\where\repo\should\live
git clone https://github.com/htlin222/openevidence-mcp.git openevidence-mcp
cd openevidence-mcp
.\scripts\setup-windows.ps1
```

## Step 2: Register OpenEvidence MCP

### Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.openevidence]
command = "node"
args = ["/ABSOLUTE/PATH/openevidence-mcp/dist/server.js"]
startup_timeout_sec = 60
```

Windows path example:

```toml
[mcp_servers.openevidence]
command = "node"
args = ["C:\\Users\\<user>\\openevidence-mcp\\dist\\server.js"]
startup_timeout_sec = 60
```

### Claude Desktop

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

After config change:
- restart client session/app if MCP list does not refresh automatically

### Claude Code Global

```bash
cd /ABSOLUTE/PATH/openevidence-mcp
make install-claude-global
claude mcp get openevidence
```

## Step 3: Cookie Handoff

Ask the user to export cookies from a logged-in `https://www.openevidence.com` browser session and place them at:

```bash
/ABSOLUTE/PATH/openevidence-mcp/cookies.json
```

Then run:

```bash
cd /ABSOLUTE/PATH/openevidence-mcp
npm run login
```

Alternative import flow:

```bash
cd /ABSOLUTE/PATH/openevidence-mcp
npm run import-cookies -- --import /path/to/cookies.json
```

## Step 4: Validate

Run:

```bash
cd /ABSOLUTE/PATH/openevidence-mcp
npm run smoke
```

Then MCP-side checks:
- `oe_auth_status`
- `oe_history_list`
- `oe_ask`

`oe_ask` and `oe_article_get` include `artifacts.bibtex` in their MCP response by default when artifacts are saved. Use `include_bibtex: false` if the client needs a smaller response.

## Step 5: Recovery Paths

- If `oe_auth_status` is unauthenticated: export fresh cookies and rerun `npm run login`
- If MCP tool not visible: restart client session/app
- If dependencies break: rerun setup script

## Clean Repository Rules for Agents

- Do not commit user session files
- Do not commit `.env` with secrets
- Keep `.gitignore` intact
- Keep reusable examples in `examples/`
- Preserve parser files in `docs/`
- Preserve attribution: keep `LICENSE` and `NOTICE`
