#!/usr/bin/env bash
set -euo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

KEYCLOAK_URL="http://localhost:8080"
MCP_URL="http://localhost:3456"
REALM="mcp-demo"

pass() { echo -e "  ${GREEN}PASS${NC}: $1"; }
fail() { echo -e "  ${RED}FAIL${NC}: $1"; exit 1; }
step() { echo -e "\n${YELLOW}[$1/10]${NC} $2"; }

# Helper: get an access token from Keycloak
get_token() {
  local USERNAME="$1"
  curl -sf -X POST "$KEYCLOAK_URL/realms/$REALM/protocol/openid-connect/token" \
    -d "grant_type=password" \
    -d "client_id=mcp-test-client" \
    -d "client_secret=mcp-test-secret" \
    -d "username=$USERNAME" \
    -d "password=password" | jq -r '.access_token'
}

# Helper: send an MCP JSON-RPC request and extract the SSE data payload
mcp_call() {
  local TOKEN="$1"
  local METHOD="$2"
  local PARAMS="{}"
  if [ $# -ge 3 ]; then PARAMS="$3"; fi

  local RESPONSE
  RESPONSE=$(curl -sf -X POST "$MCP_URL/mcp" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$METHOD\",\"params\":$PARAMS}")

  # Extract JSON from SSE data lines (use awk to avoid SIGPIPE with head)
  echo "$RESPONSE" | awk '/^data: /{sub(/^data: /, ""); print; exit}'
}

echo "============================================"
echo " MCP Server + Keycloak JWKS — End-to-End Test"
echo "============================================"

# ── Step 1: Check services ──────────────────────────────────────────
step 1 "Check services are running"

if curl -sf "$KEYCLOAK_URL/realms/$REALM" > /dev/null 2>&1; then
  pass "Keycloak realm '$REALM' is accessible"
else
  fail "Keycloak realm '$REALM' is not accessible at $KEYCLOAK_URL"
fi

if curl -sf "$MCP_URL/health" > /dev/null 2>&1; then
  pass "MCP server is healthy"
else
  fail "MCP server is not accessible at $MCP_URL"
fi

# ── Step 2: Unauthenticated request returns 401 ────────────────────
step 2 "Unauthenticated request returns 401"

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$MCP_URL/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')

if [ "$HTTP_CODE" = "401" ]; then
  pass "Got 401 Unauthorized (as expected)"
else
  fail "Expected 401 but got $HTTP_CODE"
fi

# ── Step 3: Resource metadata endpoint ──────────────────────────────
step 3 "Protected Resource Metadata (RFC 9728)"

METADATA=$(curl -sf "$MCP_URL/.well-known/oauth-protected-resource")
AUTH_SERVER=$(echo "$METADATA" | jq -r '.authorization_servers[0]')

if [ "$AUTH_SERVER" = "$KEYCLOAK_URL/realms/$REALM" ]; then
  pass "Resource metadata points to Keycloak: $AUTH_SERVER"
else
  fail "Expected authorization_server=$KEYCLOAK_URL/realms/$REALM but got $AUTH_SERVER"
fi

# ── Step 4: Get Alice's token ───────────────────────────────────────
step 4 "Get Alice's access token"

ALICE_TOKEN=$(get_token alice)
if [ -n "$ALICE_TOKEN" ] && [ "$ALICE_TOKEN" != "null" ]; then
  pass "Alice's token acquired"
else
  fail "Failed to get Alice's token"
fi

# ── Step 5: Get Bob's token ─────────────────────────────────────────
step 5 "Get Bob's access token"

BOB_TOKEN=$(get_token bob)
if [ -n "$BOB_TOKEN" ] && [ "$BOB_TOKEN" != "null" ]; then
  pass "Bob's token acquired"
else
  fail "Failed to get Bob's token"
fi

# ── Step 6: List tools ──────────────────────────────────────────────
step 6 "List tools (as Alice)"

TOOLS_RESULT=$(mcp_call "$ALICE_TOKEN" "tools/list")
TOOL_COUNT=$(echo "$TOOLS_RESULT" | jq '.result.tools | length' 2>/dev/null || echo "0")

if [ "$TOOL_COUNT" = "2" ]; then
  TOOL_NAMES=$(echo "$TOOLS_RESULT" | jq -r '.result.tools[].name' 2>/dev/null | tr '\n' ', ' | sed 's/,$//')
  pass "Found $TOOL_COUNT tools: $TOOL_NAMES"
else
  fail "Expected 2 tools but found $TOOL_COUNT"
fi

# ── Step 7: get-server-info as Alice ────────────────────────────────
step 7 "get-server-info as Alice"

INFO_RESULT=$(mcp_call "$ALICE_TOKEN" "tools/call" '{"name":"get-server-info","arguments":{}}')
INFO_TEXT=$(echo "$INFO_RESULT" | jq -r '.result.content[0].text' 2>/dev/null)
INFO_EMAIL=$(echo "$INFO_TEXT" | jq -r '.user.email' 2>/dev/null)

if [ -n "$INFO_EMAIL" ] && [ "$INFO_EMAIL" != "null" ]; then
  INFO_ROLES=$(echo "$INFO_TEXT" | jq -c '.user.roles' 2>/dev/null)
  pass "Alice identified as $INFO_EMAIL (roles: $INFO_ROLES)"
else
  fail "get-server-info did not return user info"
fi

# ── Step 8: query-database as Alice (has db-reader role) ────────────
step 8 "query-database as Alice (should succeed)"

DB_RESULT=$(mcp_call "$ALICE_TOKEN" "tools/call" '{"name":"query-database","arguments":{"query":"SELECT * FROM widgets"}}')
IS_ERROR=$(echo "$DB_RESULT" | jq '.result.isError // false' 2>/dev/null)
ROW_COUNT=$(echo "$DB_RESULT" | jq -r '.result.content[0].text' 2>/dev/null | jq '.rowCount // 0' 2>/dev/null)

if [ "$IS_ERROR" = "false" ] && [ "$ROW_COUNT" = "3" ]; then
  pass "Alice queried database successfully ($ROW_COUNT rows)"
else
  fail "Expected successful query with 3 rows but got isError=$IS_ERROR, rowCount=$ROW_COUNT"
fi

# ── Step 9: query-database as Bob (no db-reader role) ───────────────
step 9 "query-database as Bob (should fail — no db-reader role)"

DB_BOB_RESULT=$(mcp_call "$BOB_TOKEN" "tools/call" '{"name":"query-database","arguments":{"query":"SELECT * FROM widgets"}}')
BOB_IS_ERROR=$(echo "$DB_BOB_RESULT" | jq '.result.isError // false' 2>/dev/null)
BOB_TEXT=$(echo "$DB_BOB_RESULT" | jq -r '.result.content[0].text' 2>/dev/null)

if [ "$BOB_IS_ERROR" = "true" ]; then
  pass "Bob denied access: $BOB_TEXT"
else
  fail "Expected isError=true for Bob but got isError=$BOB_IS_ERROR"
fi

# ── Step 10: get-server-info as Bob (auth works, just no db role) ───
step 10 "get-server-info as Bob (should succeed)"

BOB_INFO=$(mcp_call "$BOB_TOKEN" "tools/call" '{"name":"get-server-info","arguments":{}}')
BOB_INFO_EMAIL=$(echo "$BOB_INFO" | jq -r '.result.content[0].text' 2>/dev/null | jq -r '.user.email' 2>/dev/null)

if [ -n "$BOB_INFO_EMAIL" ] && [ "$BOB_INFO_EMAIL" != "null" ]; then
  BOB_ROLES=$(echo "$BOB_INFO" | jq -r '.result.content[0].text' 2>/dev/null | jq -c '.user.roles' 2>/dev/null)
  pass "Bob identified as $BOB_INFO_EMAIL (roles: $BOB_ROLES)"
else
  fail "get-server-info did not return user info for Bob"
fi

echo ""
echo "============================================"
echo -e " ${GREEN}All 10 tests passed!${NC}"
echo "============================================"
