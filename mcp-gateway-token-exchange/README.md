# MCP Gateway Token Exchange

Demonstrates how an MCP gateway can authenticate users via an enterprise IdP (Keycloak) and
transparently exchange their JWT for service-specific tokens (GitHub) before proxying requests
to upstream MCP servers. This enables a single-sign-on experience where:

- **Admins** configure upstream MCP servers once with service credentials
- **Users** authenticate with their org's IdP (Keycloak, Okta, Entra ID, etc.)
- The **gateway** handles the token exchange automatically

## Architecture

```
                                    Token Exchange
┌────────┐   Keycloak JWT     ┌─────────────────┐   GitHub Token    ┌──────────────┐
│        │ ────────────────▶  │                 │ ────────────────▶ │              │
│ Client │                    │     Gateway     │                   │ Mock GitHub  │
│ (curl) │ ◀──── MCP result   │                 │ ◀── MCP result    │  MCP Server  │
│        │                    │ 1. Validate JWT │                   │              │
└────────┘                    │ 2. Look up user │                   └──────────────┘
                              │ 3. Swap token   │
                              │ 4. Proxy to     │
                              │    upstream     │         ┌──────────────┐
                              └────────┬────────┘         │   Keycloak   │
                                       │ JWKS             │   (IdP)      │
                                       └─────────────────▶│              │
                                                          └──────────────┘
```

**Key insight**: The upstream MCP server never sees the Keycloak JWT. It receives a GitHub
token and operates as if the client authenticated directly with GitHub. The gateway is the
translation layer.

## Quick Start

```bash
# Start all services
docker compose up --build

# Wait ~30-60 seconds for Keycloak to boot, then run tests
chmod +x test.sh
./test.sh
```

## How It Works

1. **Client** obtains a JWT from Keycloak (e.g., via password grant or browser login)
2. **Client** sends an MCP request to the gateway with `Authorization: Bearer <keycloak-jwt>`
3. **Gateway** validates the JWT against Keycloak's JWKS endpoint
4. **Gateway** looks up the user's email in a token map to find their GitHub credentials
5. **Gateway** proxies the MCP request to the upstream server with `Authorization: Bearer <github-token>`
6. **Upstream** validates the GitHub token and returns tool results
7. **Gateway** forwards the response back to the client

## Services

| Service | Port | Description |
|---|---|---|
| Keycloak | 8080 | OIDC Identity Provider — issues JWTs for alice and bob |
| Gateway | 3456 | Token Exchange Gateway — validates JWTs, swaps tokens, proxies MCP |
| Mock GitHub MCP | 3457 | Simulates a GitHub MCP server that requires GitHub tokens |

## Test Users

| User | Keycloak Password | GitHub Login | Has GitHub Token? |
|---|---|---|---|
| alice@example.com | `password` | alice-gh | Yes |
| bob@example.com | `password` | bob-gh | Yes |

## Token Map

The gateway uses a simple JSON token map (passed via `TOKEN_MAP` env var) to resolve
service-specific tokens. In production, this would be replaced by:

- **Keycloak Token Exchange** (RFC 8693) — exchange IdP token for external IdP tokens
- **Archestra's credential store** — per-user credential resolution
- **External secrets vault** — HashiCorp Vault, AWS Secrets Manager, etc.

## Connection to Archestra Platform

This example demonstrates the concept standalone. In the Archestra platform, the same
behavior is achieved by:

1. Configuring an OIDC Identity Provider in **Settings > Identity Providers**
2. Creating an MCP Gateway linked to that IdP for JWKS auth
3. Installing upstream MCP servers (GitHub, Jira, etc.) with their own credentials
4. The gateway resolves upstream credentials instead of propagating the IdP JWT

See the [platform PR](https://github.com/archestra-ai/archestra/pull/XXX) for the
credential resolution priority change that enables this.
