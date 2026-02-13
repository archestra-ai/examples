# MCP Server with Keycloak JWKS Authentication

A self-contained example demonstrating **Pattern 1: Third-Party IdP JWT Validation** from [Building Enterprise-Ready MCP Servers with JWKS and Identity Providers](https://archestra.ai/blog/enterprise-mcp-servers-jwks).

The MCP server validates JWTs issued by Keycloak using JWKS (JSON Web Key Set) for stateless, cryptographic token verification. Role-based access control restricts which tools each user can use.

## Architecture

```
  Client              Keycloak (IdP)         MCP Server
    |                      |                     |
    |  1. Get token        |                     |
    |--------------------->|                     |
    |  2. JWT              |                     |
    |<---------------------|                     |
    |                      |                     |
    |  3. MCP request + Bearer JWT               |
    |-------------------------------------------->|
    |                      |                     |
    |                      |  4. Fetch JWKS      |
    |                      |<--------------------|
    |                      |  5. Public keys     |
    |                      |-------------------->|
    |                      |                     |
    |  6. Verified response (role-checked)       |
    |<--------------------------------------------|
```

- **Keycloak** issues JWTs with `mcp-server` audience and `realm_roles` claims
- **MCP Server** validates tokens via JWKS (cached, auto-rotated by `jose`)
- **Role-based tools**: `query-database` requires `db-reader` role; `get-server-info` is open to all authenticated users

## Prerequisites

- Docker and Docker Compose

## Quick Start

```bash
# Start Keycloak + MCP server
docker compose up --build

# Wait for both services to be healthy (~30-60 seconds for Keycloak)

# Run the end-to-end test
chmod +x test.sh
./test.sh
```

## Pre-configured Users

| User  | Password   | Roles       | `query-database` |
|-------|------------|-------------|-------------------|
| alice | `password` | `db-reader` | Allowed           |
| bob   | `password` | _(none)_    | Denied            |

## Manual Testing

### 1. Get an access token

```bash
# Alice (has db-reader role)
ALICE_TOKEN=$(curl -s -X POST "http://localhost:8080/realms/mcp-demo/protocol/openid-connect/token" \
  -d "grant_type=password" \
  -d "client_id=mcp-test-client" \
  -d "client_secret=mcp-test-secret" \
  -d "username=alice" \
  -d "password=password" | jq -r '.access_token')

# Inspect the token (optional)
echo "$ALICE_TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | jq .
```

### 2. Check resource metadata

```bash
curl -s http://localhost:3456/.well-known/oauth-protected-resource | jq .
```

### 3. Call MCP tools

MCP uses JSON-RPC over HTTP. In stateless mode, each request is self-contained:

```bash
# List available tools
curl -s -X POST http://localhost:3456/mcp \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

```bash
# Call a tool
curl -s -X POST http://localhost:3456/mcp \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"query-database","arguments":{"query":"SELECT * FROM widgets"}}}'
```

## How JWT Validation Works

1. Client sends `Authorization: Bearer <jwt>` with each MCP request
2. The `requireAuth` middleware extracts the token
3. `jose.jwtVerify()` fetches Keycloak's JWKS (cached), finds the matching key by `kid`, and verifies the signature
4. Claims are validated: `iss` (issuer), `aud` (audience), `exp` (expiry)
5. User identity and roles are extracted from the JWT payload
6. Tool handlers check `auth.roles` for role-based access control

## Key Files

| File | Description |
|------|-------------|
| `docker-compose.yml` | Keycloak + MCP server orchestration |
| `keycloak-realm.json` | Pre-configured realm with users, roles, and clients |
| `mcp-server/src/auth.ts` | JWKS client, JWT verification, auth middleware |
| `mcp-server/src/tools.ts` | MCP tool definitions with role-based access |
| `mcp-server/src/server.ts` | Express app, MCP transport, discovery endpoints |
| `test.sh` | End-to-end test script (10 steps) |

## Using with Archestra MCP Gateway

This server works both standalone (as shown above) and behind [Archestra's MCP Gateway](https://archestra.ai/docs/platform-mcp-gateway) with end-to-end JWT propagation.

When configured with [External IdP JWKS](https://archestra.ai/docs/mcp-authentication#external-idp-jwks), the Archestra gateway:

1. Validates the caller's JWT against Keycloak's JWKS
2. Matches the JWT's email claim to an Archestra user
3. Enforces team-based access control
4. **Propagates the original JWT** to this MCP server as an `Authorization: Bearer` header

The MCP server then validates the same JWT independently — no Archestra-specific code needed. This enables end-to-end identity verification where both the gateway and the upstream server can prove who made each request.

This pattern works with any OIDC-compliant identity provider (Okta, Auth0, Microsoft Entra ID, Keycloak, etc.).

## Key Design Decisions

- **Stateless MCP transport**: new `McpServer` instance per request, no session tracking
- **Separate issuer vs JWKS URLs**: `JWT_ISSUER=http://localhost:8080/...` matches the `iss` claim in tokens; `JWKS_URL=http://keycloak:8080/...` uses Docker-internal DNS for key fetching
- **Direct Access Grants** for token acquisition: simplest flow for curl-based testing (in production, use Authorization Code + PKCE)
- **`jose` library** for JWKS: handles caching, key rotation, and `kid` matching automatically
