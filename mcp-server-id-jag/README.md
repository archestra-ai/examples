# MCP Server with ID-JAG Exchange

A self-contained example demonstrating the enterprise-managed authorization pattern where an MCP server's authorization server accepts an **ID-JAG** assertion at `/token`, validates it, and mints a resource-specific bearer access token for the MCP server.

This is the example to use when you want:

- an auth server that accepts `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`
- an assertion JWT with `typ=oauth-id-jag+jwt`
- a resource server that issues its own bearer token after validating the enterprise assertion

This is **not** the same as the JWKS example. The JWKS example validates and forwards an enterprise JWT directly. This example exchanges an enterprise assertion for an MCP-native access token.

## What it exposes

- `/.well-known/oauth-protected-resource` - MCP protected resource metadata
- `/.well-known/oauth-authorization-server` - auth server metadata advertising ID-JAG support
- `POST /token` - validates an ID-JAG and mints a bearer access token
- `POST /mcp` - stateless MCP endpoint protected by the minted bearer token
- `POST /demo-idp/mint` - helper endpoint that mints a demo ID-JAG so you can exercise the exchange locally
- `GET /demo-idp/jwks` - the demo IdP's signing keys

## Quick start

```bash
cd mcp-server-id-jag
npm install
npm test
npm run dev
```

By default the server listens on `http://localhost:3458`.

## Manual flow

### 1. Mint a demo ID-JAG

```bash
ASSERTION=$(curl -s http://localhost:3458/demo-idp/mint \
  -X POST \
  -H 'content-type: application/json' \
  -d '{
    "sub": "user-123",
    "email": "alice@example.com",
    "name": "Alice Example"
  }' | jq -r '.assertion')
```

### 2. Exchange the ID-JAG for an MCP bearer token

```bash
ACCESS_TOKEN=$(curl -s http://localhost:3458/token \
  -X POST \
  -u demo-client:demo-secret \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer' \
  --data-urlencode "assertion=${ASSERTION}" | jq -r '.access_token')
```

### 3. Call the `whoami` tool

```bash
curl -s http://localhost:3458/mcp \
  -X POST \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "whoami",
      "arguments": {}
    }
  }' | jq .
```

## Default credentials

- `client_id`: `demo-client`
- `client_secret`: `demo-secret`

## Important validation rules in this demo

- The client authenticates to `/token` with HTTP Basic auth.
- The request must use `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`.
- The JWT header `typ` must be `oauth-id-jag+jwt`.
- The ID-JAG `aud` must match the resource authorization server issuer.
- The ID-JAG `client_id` claim must match the authenticated OAuth client.

## Environment variables

- `PORT` - listen port, default `3458`
- `BASE_URL` - public base URL, default `http://localhost:3458`
- `CLIENT_ID` - OAuth client id for the demo token endpoint, default `demo-client`
- `CLIENT_SECRET` - OAuth client secret for the demo token endpoint, default `demo-secret`

## Notes

- This keeps access tokens in memory and issues opaque bearer tokens for simplicity.
- The `/demo-idp/*` endpoints are a testing convenience so the example is runnable without an external enterprise IdP.
- Production deployments should add replay protection, persistent token storage, client registration, stricter scope policy, and sender-constrained tokens where appropriate.
