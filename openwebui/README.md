# Archestra + Open WebUI PoC

This PoC demonstrates how to run [Open WebUI](https://github.com/open-webui/open-webui) with [Archestra](https://archestra.ai) as an LLM Proxy and MCP Gateway, using Ollama running on your local machine.

## Architecture

```
┌─────────────┐     ┌──────────────────────────────────────────────┐     ┌────────────┐
│             │     │              Archestra                       │     │            │
│  Open WebUI │────▶│  LLM Proxy (/v1/ollama/:agentId/chat/...)   │────▶│   Ollama   │
│  :8005      │     │  MCP Gateway (/v1/mcp/:profileId)           │     │   :11434   │
│             │     │  UI (:3005) + API (:9005)                   │     │  (on host) │
└─────────────┘     └──────────────────────────────────────────────┘     └────────────┘
```

## Prerequisites

1. **Docker** and **Docker Compose**
2. **Ollama** running on your host machine with at least one model:
   ```bash
   # Install: https://ollama.ai
   ollama pull llama3.2
   ```

## Quick Start

```bash
docker compose up -d
```

Wait ~60 seconds for Archestra to initialize, then:

| Service       | URL                      |
|---------------|--------------------------|
| Archestra UI  | http://localhost:3005     |
| Archestra API | http://localhost:9005     |
| Open WebUI    | http://localhost:8005     |

## Setup Steps

### 1. Set Up Archestra

1. Open **http://localhost:3005**
2. Log in with `admin@example.com` / `password`
3. You should see Ollama listed as a configured provider (via `ARCHESTRA_OLLAMA_BASE_URL`)

### 2. Create an LLM Proxy (Profile) in Archestra

1. Go to the Archestra UI → **LLM Proxies** section
2. Create a new LLM Proxy (profile) — e.g., "OpenWebUI Proxy"
3. Note the **Profile ID** (UUID) — you'll use this in URLs

With the profile ID, Open WebUI's requests to Archestra will be scoped to this profile, enabling:
- Per-profile token usage limits
- Tool invocation policies
- Trusted data policies
- Cost tracking & optimization rules

### 3. Configure Open WebUI to Use a Specific LLM Proxy

Update `docker-compose.yml` to include the profile ID in the URL:

```yaml
# In the open-webui service environment:
- OPENAI_API_BASE_URL=http://archestra:9000/v1/ollama/<profile-id>
```

### 4. Set Up MCP Gateway (Optional)

Open WebUI supports MCP (Model Context Protocol) via **Streamable HTTP** transport. To connect Open WebUI to Archestra's MCP Gateway:

1. In Archestra UI, ensure MCP tools are assigned to your profile
2. In Open WebUI, go to **Admin Settings → External Tools → Add Server**
3. Configure:
   - **Type**: MCP (Streamable HTTP)
   - **URL**: `http://archestra:9000/v1/mcp/<profile-id>`
   - **Auth**: Bearer token (use an Archestra token — see [Token Auth](#token-authentication) below)

### 5. Use Open WebUI

1. Open **http://localhost:8005**
2. Create an account (first user becomes admin)
3. Select an Ollama model and start chatting
4. Requests flow through Archestra's LLM Proxy

---

## How Auth Works

### LLM Proxy Auth

Archestra's LLM Proxy routes (`/v1/ollama/...`, `/v1/openai/...`, etc.) **skip session-based authentication**. They are designed to accept requests from any client (like Open WebUI) and forward the `Authorization` header to the upstream LLM provider.

For Ollama, no API key is needed, so `OPENAI_API_KEY=not-needed` works fine.

The proxy does support optional user association via the `X-Archestra-User-Id` header — if a valid Archestra user ID is provided, the request is associated with that user for logging/analytics.

### MCP Gateway Auth

The MCP Gateway (`/v1/mcp/:profileId`) **requires authentication** via `Authorization: Bearer <token>`. This token is validated against the profile's organization.

### Token Authentication

Archestra tokens can be obtained via:
1. **API Keys**: Create in Archestra UI → Settings → Your Account → API Keys
2. **Session tokens**: Obtained after login (cookie-based, primarily for the UI)

### Open WebUI Auth

Open WebUI has its own independent authentication:
- Users create accounts on Open WebUI
- Open WebUI issues JWTs for its own session management
- When calling LLM backends, Open WebUI sends the configured `OPENAI_API_KEY` (not the user's JWT)

---

## User Mapping: Open WebUI → Archestra

This is the critical challenge for a production deployment where many users log into Open WebUI via SSO and need to be identified in Archestra.

### The Problem

Open WebUI and Archestra have **separate user databases**. When a user sends a chat message:

1. User authenticates to Open WebUI (via SSO/OIDC)
2. Open WebUI's backend calls Archestra's LLM Proxy
3. Archestra sees the request but **doesn't know which Open WebUI user sent it**

### Current Capabilities

#### Open WebUI → Archestra Headers

With `ENABLE_FORWARD_USER_INFO_HEADERS=true`, Open WebUI forwards these headers on every LLM request:

| Header | Content |
|--------|---------|
| `X-OpenWebUI-User-Name` | User's display name |
| `X-OpenWebUI-User-Id` | Open WebUI's internal user ID |
| `X-OpenWebUI-User-Email` | User's email address |
| `X-OpenWebUI-User-Role` | User's role (admin, user) |

#### Archestra's User Association

Archestra reads `X-Archestra-User-Id` to associate LLM requests with Archestra users. Note: **different header name** than what Open WebUI sends.

### Proposed Solutions

#### Option 1: Header Mapping Middleware (Recommended for PoC)

Add a lightweight reverse proxy (nginx/Caddy/custom) between Open WebUI and Archestra that:
1. Reads `X-OpenWebUI-User-Email` from Open WebUI
2. Looks up the corresponding Archestra user ID (via Archestra API or a mapping table)
3. Sets `X-Archestra-User-Id` header before forwarding to Archestra

```
Open WebUI → Header Mapper → Archestra LLM Proxy
```

#### Option 2: Shared SSO with Email Matching (Recommended for Production)

Both Open WebUI and Archestra authenticate against the **same OIDC provider**:
- Open WebUI: `OPENID_PROVIDER_URL`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`
- Archestra: SAML/OIDC SSO configuration

Users are matched by email address. Flow:
1. User logs into Open WebUI via SSO → email is `user@company.com`
2. Same user exists in Archestra (provisioned via SSO or invitation)
3. Open WebUI forwards `X-OpenWebUI-User-Email: user@company.com`
4. Archestra maps email → Archestra user ID → associates with request

**Requires**: Archestra to support email-based user lookup from the `X-OpenWebUI-User-Email` header (or a new header mapping feature).

#### Option 3: Per-User API Keys

Each Open WebUI user gets their own Archestra API key:
1. When a user is created in Open WebUI, also create them in Archestra
2. Generate an Archestra API key per user
3. Open WebUI sends the user-specific API key in the `Authorization` header

**Challenge**: Open WebUI sends a **single global** `OPENAI_API_KEY`, not per-user keys. This would require either:
- A custom Open WebUI pipe/function that injects per-user keys
- The `ENABLE_FORWARD_OAUTH_TOKEN` feature (sends the user's OAuth JWT instead of the static API key)

#### Option 4: OAuth Token Forwarding (Emerging)

Open WebUI recently added `ENABLE_FORWARD_OAUTH_TOKEN` support (commit `2b2d123`, ~Sep 2025):
- Forwards the user's original OAuth JWT to the downstream LLM service
- Archestra could validate this JWT and extract user identity
- Requires both systems to trust the same OAuth provider

**Status**: Relatively new feature, may not be in all stable Open WebUI releases.

#### Option 5: Trusted Header Authentication

Use a reverse proxy that handles SSO and injects trusted headers:

```
User → Reverse Proxy (SSO) → Open WebUI (WEBUI_AUTH_TRUSTED_EMAIL_HEADER)
                            → Archestra (similar trusted header)
```

Both systems see the same user identity from the reverse proxy.

### Recommendation for Your Client

For a production deployment with many SSO users:

1. **Short term**: Use **Option 1** (header mapping middleware) — fastest to implement
2. **Medium term**: Implement **Option 2** (shared SSO + email matching) in Archestra:
   - Add support for reading `X-OpenWebUI-User-Email` (or a configurable header)
   - Look up Archestra user by email
   - Associate the request with that user
3. **Long term**: Evaluate **Option 4** (OAuth token forwarding) once it stabilizes in Open WebUI

---

## Troubleshooting

### Models not showing in Open WebUI
- Verify Ollama is running: `curl http://localhost:11434/api/tags`
- Check Archestra logs: `docker compose logs archestra`
- The Ollama proxy in Archestra should proxy `/api/tags` requests

### Archestra not starting
- Check health: `curl http://localhost:9005/health`
- Database init takes ~30s on first boot
- View logs: `docker compose logs archestra -f`

### Chat not working through Archestra
- Test directly: `curl -X POST http://localhost:9005/v1/ollama/chat/completions -H "Content-Type: application/json" -d '{"model":"llama3.2","messages":[{"role":"user","content":"hello"}]}'`
- Check Archestra has a default profile or create one and add the profile ID to the URL
