# Claude Desktop + Archestra

Proxy [Claude Desktop](https://claude.ai/download) through [Archestra](https://archestra.ai) for tool-level security policies, cost limits, prompt injection defense, and full observability.

This example uses [mitmproxy](https://mitmproxy.org/) to intercept Claude Desktop's API traffic and redirect it through Archestra's LLM proxy — giving you control over every tool call and LLM request.

For the full security walkthrough, see the blog post: [How to Secure Claude Desktop Extensions](https://archestra.ai/blog/how-to-secure-claude-desktop-extensions).

## Why?

Claude Desktop Extensions (DXT) run MCP servers with **full system privileges** — no sandbox, no permission boundaries. Security researchers at LayerX discovered a [CVSS 10/10 zero-click RCE vulnerability](https://layerxsecurity.com/blog/claude-desktop-extensions-rce/) where a malicious Google Calendar event can trigger arbitrary code execution via Desktop Commander, and Anthropic declined to fix it.

By proxying Claude Desktop through Archestra, you get:

- **Tool invocation policies** — block or constrain dangerous tools like Desktop Commander
- **Dual LLM pattern** — detect prompt injection at the proxy level, before it reaches the model
- **Cost limits** — prevent runaway API spend from agentic loops
- **Full observability** — see every tool call and LLM request in the Archestra dashboard

## Prerequisites

- **macOS** (Claude Desktop is a native macOS/Windows app; this script supports macOS)
- [Docker](https://docs.docker.com/get-started/introduction/get-docker-desktop/) installed and running
- [Homebrew](https://brew.sh/) installed

## Quick Start

### 1. Start Archestra

```bash
docker compose up -d platform
```

Open [http://localhost:3000](http://localhost:3000) and log in with the default credentials (`admin@example.com` / `password`). Add your Anthropic API key under **Settings > LLM API Keys**.

> **Tip:** If `localhost` doesn't connect (common with OrbStack on macOS), use `http://127.0.0.1:3000` instead and uncomment the `ARCHESTRA_FRONTEND_URL` line in `docker-compose.yaml`.

### 2. Run the Setup Script

```bash
./setup.sh
```

The script handles everything automatically:

1. Checks and installs prerequisites (mitmproxy, jq)
2. Trusts the mitmproxy CA certificate (one-time, requires sudo)
3. Signs in to Archestra and creates a "Claude Desktop" LLM Proxy (idempotent — safe to re-run)
4. Starts mitmproxy with the redirect addon
5. Launches Claude Desktop with proxy settings

No manual URL copying needed — the script provisions the LLM Proxy via the Archestra API.

### 3. Use Claude Desktop

Use Claude Desktop normally. All LLM traffic now flows through Archestra.

- **Archestra UI**: [http://localhost:3000](http://localhost:3000) — view logs, set tool policies
- **mitmproxy Web UI**: [http://localhost:8081](http://localhost:8081) — inspect intercepted traffic

### Stopping

```bash
./stop.sh
```

## Configuration

The script uses these defaults, all overridable via environment variables:

| Variable | Default | Description |
|---|---|---|
| `ARCHESTRA_URL` | `http://localhost:9000` | Archestra backend URL |
| `ARCHESTRA_FRONTEND_URL` | `http://localhost:3000` | Archestra frontend URL |
| `ARCHESTRA_EMAIL` | `admin@example.com` | Login email |
| `ARCHESTRA_PASSWORD` | `password` | Login password |

Example with custom credentials:

```bash
ARCHESTRA_EMAIL="me@company.com" ARCHESTRA_PASSWORD="secret" ./setup.sh
```

## How It Works

```
Claude Desktop
  → POST https://api.anthropic.com/v1/messages
  → mitmproxy intercepts (port 8080)
  → Rewrites to POST http://localhost:9000/v1/anthropic/<profileId>/v1/messages
  → Archestra enforces tool policies, Dual LLM, cost limits
  → Archestra forwards to Anthropic
  → Response flows back to Claude Desktop
```

Claude Desktop is an Electron app, so it respects Chromium's `--proxy-server` flag. The setup script launches it with `--proxy-server=http://127.0.0.1:8080`, routing all HTTPS traffic through mitmproxy. A mitmproxy addon script rewrites requests to `api.anthropic.com` and redirects them to your local Archestra instance.
