# OpenClaw + Archestra

Run [OpenClaw](https://docs.openclaw.ai/) with [Archestra](https://archestra.ai) as an LLM proxy for security guardrails, cost limits, and full observability.

Both OpenClaw and Archestra run in Docker via a single `docker compose up`. Archestra proxies all LLM traffic, giving you tool permissions, cost caps, and full request observability.

For a detailed walkthrough, see the blog post: [How to Run OpenClaw Securely](https://archestra.ai/blog/how-to-run-openclaw-securely).

## Prerequisites

- [Docker](https://docs.docker.com/get-started/introduction/get-docker-desktop/) installed and running
- An [Anthropic API key](https://console.anthropic.com/)

## Quick Start

### 1. Start Archestra

Start the Archestra platform first:

```bash
docker compose up -d platform
```

Open [http://localhost:3000](http://localhost:3000) and log in with the default credentials (`admin@example.com` / `password`).

> **Tip:** If `localhost` doesn't connect (common with OrbStack on macOS), use `http://127.0.0.1:3000` instead and uncomment the `ARCHESTRA_FRONTEND_URL` line in `docker-compose.yaml`.

### 2. Configure the LLM Proxy

1. Go to **Settings > LLM API Keys** and add your Anthropic API key
2. Navigate to **LLM Proxies** in the sidebar and click the **Connect** button on the "Default LLM Proxy"
3. Select the **Anthropic** tab and copy the **proxy UUID** from the connection URL (it looks like `http://localhost:9000/v1/anthropic/<uuid>`)

### 3. Configure OpenClaw

Edit `config/openclaw.json` and replace `<your-proxy-uuid>` with the UUID you copied in step 2.

> **Note:** The `baseUrl` uses `http://platform:9000/...` (the Docker service name) because OpenClaw reaches Archestra over the Docker network, not `localhost`.

### 4. Start OpenClaw

```bash
export ANTHROPIC_API_KEY="your-api-key-here"
docker compose up -d
```

This starts the OpenClaw gateway alongside Archestra. Access the OpenClaw dashboard using the tokenized URL (the default gateway token is `changeme`):

[http://localhost:18789/?token=changeme](http://localhost:18789/?token=changeme)

On the first connection, you'll need to **approve the device pairing**:

```bash
./approve-devices.sh
```

Once paired, you'll see "Health OK" in the dashboard. All LLM traffic now flows through Archestra, where you can set tool permissions, cost limits, and monitor every request.

### Stopping

```bash
docker compose down
```
