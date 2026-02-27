#!/usr/bin/env bash
set -euo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

KEYCLOAK_URL="http://localhost:8080"
GATEWAY_URL="http://localhost:3456"
GITHUB_MCP_URL="http://localhost:3457"
REALM="mcp-demo"

pass() { echo -e "  ${GREEN}PASS${NC}: $1"; }
fail() { echo -e "  ${RED}FAIL${NC}: $1"; exit 1; }
step() { echo -e "\n${YELLOW}[$1/12]${NC} $2"; }

# Helper: get a Keycloak access token
get_keycloak_token() {
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
  local URL="$1"
  local TOKEN="$2"
  local METHOD="$3"
  local PARAMS="{}"
  if [ $# -ge 4 ]; then PARAMS="$4"; fi

  local RESPONSE
  RESPONSE=$(curl -sf -X POST "$URL/mcp" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$METHOD\",\"params\":$PARAMS}")

  echo "$RESPONSE" | awk '/^data: /{sub(/^data: /, ""); print; exit}'
}

echo "================================================================"
echo " MCP Gateway Token Exchange — End-to-End Test"
echo ""
echo " Keycloak JWT → Gateway → GitHub Token → Mock GitHub MCP Server"
echo "================================================================"

# ── Step 1: Check services ──────────────────────────────────────────────
step 1 "Check all services are running"

if curl -sf "$KEYCLOAK_URL/realms/$REALM" > /dev/null 2>&1; then
  pass "Keycloak realm '$REALM' is accessible"
else
  fail "Keycloak realm '$REALM' is not accessible at $KEYCLOAK_URL"
fi

if curl -sf "$GATEWAY_URL/health" > /dev/null 2>&1; then
  pass "Token Exchange Gateway is healthy"
else
  fail "Gateway is not accessible at $GATEWAY_URL"
fi

if curl -sf "$GITHUB_MCP_URL/health" > /dev/null 2>&1; then
  pass "Mock GitHub MCP Server is healthy"
else
  fail "Mock GitHub MCP Server is not accessible at $GITHUB_MCP_URL"
fi

# ── Step 2: Unauthenticated request ────────────────────────────────────
step 2 "Gateway rejects unauthenticated requests"

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$GATEWAY_URL/mcp" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')

if [ "$HTTP_CODE" = "401" ]; then
  pass "Got 401 Unauthorized (as expected)"
else
  fail "Expected 401 but got $HTTP_CODE"
fi

# ── Step 3: Resource metadata ──────────────────────────────────────────
step 3 "Protected Resource Metadata (RFC 9728)"

METADATA=$(curl -sf "$GATEWAY_URL/.well-known/oauth-protected-resource")
AUTH_SERVER=$(echo "$METADATA" | jq -r '.authorization_servers[0]')

if [ "$AUTH_SERVER" = "$KEYCLOAK_URL/realms/$REALM" ]; then
  pass "Resource metadata points to Keycloak: $AUTH_SERVER"
else
  fail "Expected authorization_server=$KEYCLOAK_URL/realms/$REALM but got $AUTH_SERVER"
fi

# ── Step 4: Direct GitHub token is rejected by gateway ─────────────────
step 4 "Gateway rejects GitHub tokens (only accepts Keycloak JWTs)"

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$GATEWAY_URL/mcp" \
  -H "Authorization: Bearer ghp_alice_github_token_mock_abc123" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')

if [ "$HTTP_CODE" = "401" ]; then
  pass "Gateway correctly rejected a GitHub token (not a valid JWT)"
else
  fail "Expected 401 but got $HTTP_CODE"
fi

# ── Step 5: Get Alice's Keycloak token ─────────────────────────────────
step 5 "Get Alice's Keycloak access token"

ALICE_TOKEN=$(get_keycloak_token alice)
if [ -n "$ALICE_TOKEN" ] && [ "$ALICE_TOKEN" != "null" ]; then
  pass "Alice's Keycloak JWT acquired"
  echo -e "    ${CYAN}JWT claims: $(echo "$ALICE_TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | jq -c '{email, realm_roles}' 2>/dev/null)${NC}"
else
  fail "Failed to get Alice's Keycloak token"
fi

# ── Step 6: Get Bob's Keycloak token ───────────────────────────────────
step 6 "Get Bob's Keycloak access token"

BOB_TOKEN=$(get_keycloak_token bob)
if [ -n "$BOB_TOKEN" ] && [ "$BOB_TOKEN" != "null" ]; then
  pass "Bob's Keycloak JWT acquired"
else
  fail "Failed to get Bob's Keycloak token"
fi

# ── Step 7: List tools via gateway (token exchange happens here!) ──────
step 7 "List GitHub tools via gateway (Keycloak JWT → GitHub token exchange)"

TOOLS_RESULT=$(mcp_call "$GATEWAY_URL" "$ALICE_TOKEN" "tools/list")
TOOL_COUNT=$(echo "$TOOLS_RESULT" | jq '.result.tools | length' 2>/dev/null || echo "0")

if [ "$TOOL_COUNT" = "3" ]; then
  TOOL_NAMES=$(echo "$TOOLS_RESULT" | jq -r '.result.tools[].name' 2>/dev/null | tr '\n' ', ' | sed 's/,$//')
  pass "Found $TOOL_COUNT GitHub tools: $TOOL_NAMES"
else
  fail "Expected 3 tools but found $TOOL_COUNT. Response: $(echo "$TOOLS_RESULT" | head -c 500)"
fi

# ── Step 8: get-authenticated-user (proves token exchange worked) ──────
step 8 "get-authenticated-user (proves token was exchanged)"

USER_RESULT=$(mcp_call "$GATEWAY_URL" "$ALICE_TOKEN" "tools/call" '{"name":"get-authenticated-user","arguments":{}}')
USER_TEXT=$(echo "$USER_RESULT" | jq -r '.result.content[0].text' 2>/dev/null)
GH_LOGIN=$(echo "$USER_TEXT" | jq -r '.login' 2>/dev/null)

if [ "$GH_LOGIN" = "alice-gh" ]; then
  echo -e "    ${CYAN}Keycloak identity: alice@example.com${NC}"
  echo -e "    ${CYAN}GitHub identity:   $GH_LOGIN${NC}"
  echo -e "    ${CYAN}Message: $(echo "$USER_TEXT" | jq -r '.message' 2>/dev/null)${NC}"
  pass "Token exchange confirmed — Keycloak JWT was swapped for GitHub token"
else
  fail "Expected GitHub login 'alice-gh' but got '$GH_LOGIN'"
fi

# ── Step 9: list-repos as Alice ────────────────────────────────────────
step 9 "list-repos as Alice (GitHub-authenticated)"

REPOS_RESULT=$(mcp_call "$GATEWAY_URL" "$ALICE_TOKEN" "tools/call" '{"name":"list-repos","arguments":{}}')
REPOS_TEXT=$(echo "$REPOS_RESULT" | jq -r '.result.content[0].text' 2>/dev/null)
REPO_USER=$(echo "$REPOS_TEXT" | jq -r '.user' 2>/dev/null)

if [ "$REPO_USER" = "alice-gh" ]; then
  REPO_COUNT=$(echo "$REPOS_TEXT" | jq '.repos | length' 2>/dev/null)
  pass "Listed $REPO_COUNT repos for GitHub user $REPO_USER"
else
  fail "Expected repos for 'alice-gh' but got '$REPO_USER'"
fi

# ── Step 10: create-issue as Alice ─────────────────────────────────────
step 10 "create-issue as Alice"

ISSUE_RESULT=$(mcp_call "$GATEWAY_URL" "$ALICE_TOKEN" "tools/call" \
  '{"name":"create-issue","arguments":{"repo":"alice-gh/my-app","title":"Fix login bug","body":"Login fails on mobile"}}')
ISSUE_TEXT=$(echo "$ISSUE_RESULT" | jq -r '.result.content[0].text' 2>/dev/null)
ISSUE_STATE=$(echo "$ISSUE_TEXT" | jq -r '.state' 2>/dev/null)

if [ "$ISSUE_STATE" = "open" ]; then
  ISSUE_URL=$(echo "$ISSUE_TEXT" | jq -r '.html_url' 2>/dev/null)
  pass "Issue created: $ISSUE_URL"
else
  fail "Expected issue state 'open' but got '$ISSUE_STATE'"
fi

# ── Step 11: Bob's token also gets exchanged ───────────────────────────
step 11 "Token exchange works for Bob too"

BOB_USER_RESULT=$(mcp_call "$GATEWAY_URL" "$BOB_TOKEN" "tools/call" '{"name":"get-authenticated-user","arguments":{}}')
BOB_USER_TEXT=$(echo "$BOB_USER_RESULT" | jq -r '.result.content[0].text' 2>/dev/null)
BOB_GH_LOGIN=$(echo "$BOB_USER_TEXT" | jq -r '.login' 2>/dev/null)

if [ "$BOB_GH_LOGIN" = "bob-gh" ]; then
  echo -e "    ${CYAN}Keycloak identity: bob@example.com${NC}"
  echo -e "    ${CYAN}GitHub identity:   $BOB_GH_LOGIN${NC}"
  pass "Bob's Keycloak JWT was exchanged for his GitHub token"
else
  fail "Expected GitHub login 'bob-gh' but got '$BOB_GH_LOGIN'"
fi

# ── Step 12: Direct call to mock GitHub with Keycloak JWT fails ────────
step 12 "Mock GitHub MCP rejects Keycloak JWTs directly"

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$GITHUB_MCP_URL/mcp" \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')

if [ "$HTTP_CODE" = "401" ]; then
  pass "Mock GitHub correctly rejected the Keycloak JWT (needs a GitHub token)"
else
  fail "Expected 401 but got $HTTP_CODE"
fi

echo ""
echo "================================================================"
echo -e " ${GREEN}All 12 tests passed!${NC}"
echo ""
echo " Summary: Users authenticate with their Keycloak JWT."
echo " The gateway validates the JWT, exchanges it for a"
echo " service-specific GitHub token, and proxies the request"
echo " to the upstream MCP server. The upstream only ever sees"
echo " the GitHub token — never the Keycloak JWT."
echo "================================================================"
