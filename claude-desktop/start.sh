#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────
# Start Archestra protection for Claude Desktop
#
# Launches mitmproxy to intercept Claude Desktop's traffic to
# claude.ai and route it through Archestra's LLM proxy for
# tool invocation policies, dual LLM defense, and observability.
#
# Usage: ./start.sh
# ─────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROXY_ADDON="${SCRIPT_DIR}/proxy-addon.py"
PROXY_LOG="/tmp/mitmdump-proxy.log"
LISTEN_PORT=8080

# ── Colors ──────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

banner() {
  echo ""
  echo -e "${CYAN}${BOLD}╔══════════════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}${BOLD}║       Claude Desktop + Archestra Protection     ║${NC}"
  echo -e "${CYAN}${BOLD}╚══════════════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "  Routes Claude Desktop traffic through Archestra's LLM proxy"
  echo -e "  for tool invocation policies, dual LLM defense, cost limits,"
  echo -e "  and full observability — blocking prompt injection attacks"
  echo -e "  like the LayerX CVSS 10 zero-click RCE."
  echo ""
}

info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC}   $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
error()   { echo -e "${RED}[ERR]${NC}  $1"; }

# ── Prerequisite Checks ────────────────────────────────────

check_os() {
  if [[ "$(uname)" != "Darwin" ]]; then
    error "This script is for macOS only."
    exit 1
  fi
}

check_mitmdump() {
  if ! command -v mitmdump &>/dev/null; then
    error "mitmproxy is required but not installed."
    echo ""
    echo "  Install it: brew install mitmproxy"
    exit 1
  fi
  success "mitmproxy found ($(mitmdump --version | head -1))"
}

check_claude_desktop() {
  if [[ ! -d "/Applications/Claude.app" ]]; then
    error "Claude Desktop not found at /Applications/Claude.app"
    echo "  Download it from: https://claude.ai/download"
    exit 1
  fi
  success "Claude Desktop found"
}

check_proxy_addon() {
  if [[ ! -f "$PROXY_ADDON" ]]; then
    error "Proxy addon not found at: $PROXY_ADDON"
    exit 1
  fi
  success "Proxy addon found"
}

check_archestra() {
  if curl -sf "http://127.0.0.1:9000/.well-known/oauth-authorization-server" >/dev/null 2>&1; then
    success "Archestra backend reachable at 127.0.0.1:9000"
  else
    warn "Archestra backend not reachable at 127.0.0.1:9000"
    echo "  Make sure Archestra is running (tilt up, docker compose, etc.)"
  fi
}

# ── Configuration ───────────────────────────────────────────

get_config() {
  # Profile ID
  if [[ -n "${ARCHESTRA_PROFILE_ID:-}" ]]; then
    PROFILE_ID="$ARCHESTRA_PROFILE_ID"
  else
    echo ""
    read -rp "  Archestra Profile ID: " PROFILE_ID
    if [[ -z "$PROFILE_ID" ]]; then
      error "Profile ID is required."
      echo "  Set ARCHESTRA_PROFILE_ID env var or enter it when prompted."
      exit 1
    fi
  fi
  success "Profile ID: ${PROFILE_ID:0:8}..."

  # Anthropic API Key
  if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    API_KEY="$ANTHROPIC_API_KEY"
  else
    echo ""
    read -rsp "  Anthropic API Key: " API_KEY
    echo ""
    if [[ -z "$API_KEY" ]]; then
      error "Anthropic API Key is required."
      echo "  Set ANTHROPIC_API_KEY env var or enter it when prompted."
      exit 1
    fi
  fi
  success "Anthropic API Key: ${API_KEY:0:12}..."
}

# ── Kill existing proxy ────────────────────────────────────

kill_existing_proxy() {
  local pids
  pids=$(pgrep -f "mitmdump.*proxy-addon" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    echo "$pids" | xargs kill 2>/dev/null || true
    sleep 1
    info "Stopped existing proxy (PID: $(echo $pids | tr '\n' ' '))"
  fi
}

# ── Start proxy ────────────────────────────────────────────

start_proxy() {
  info "Starting mitmproxy on port ${LISTEN_PORT}..."
  mitmdump \
    --listen-port "$LISTEN_PORT" \
    -s "$PROXY_ADDON" \
    --set "archestra_profile_id=${PROFILE_ID}" \
    --set "anthropic_api_key=${API_KEY}" \
    > "$PROXY_LOG" 2>&1 &

  PROXY_PID=$!
  sleep 2

  if kill -0 "$PROXY_PID" 2>/dev/null; then
    success "mitmproxy running (PID: $PROXY_PID, log: $PROXY_LOG)"
  else
    error "mitmproxy failed to start. Check log: $PROXY_LOG"
    tail -5 "$PROXY_LOG" 2>/dev/null || true
    exit 1
  fi
}

# ── Restart Claude Desktop with proxy ──────────────────────

restart_claude() {
  echo ""
  read -rp "  Restart Claude Desktop with proxy? [Y/n] " answer
  answer=${answer:-Y}
  if [[ "$answer" =~ ^[Yy]$ ]]; then
    info "Restarting Claude Desktop with proxy..."
    osascript -e 'quit app "Claude"' 2>/dev/null || true
    sleep 2
    open -a Claude --args --proxy-server="http://127.0.0.1:${LISTEN_PORT}"
    success "Claude Desktop started with Archestra proxy"
  else
    echo ""
    echo "  Start Claude Desktop manually with:"
    echo "    open -a Claude --args --proxy-server=http://127.0.0.1:${LISTEN_PORT}"
  fi
}

# ── Main ───────────────────────────────────────────────────

main() {
  banner
  check_os
  check_mitmdump
  check_claude_desktop
  check_proxy_addon
  check_archestra
  get_config
  kill_existing_proxy
  start_proxy

  echo ""
  echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}${BOLD}║              Archestra Proxy Active!             ║${NC}"
  echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "  All Claude Desktop traffic → Archestra → claude.ai"
  echo ""
  echo -e "  ${BOLD}Proxy log:${NC}     tail -f $PROXY_LOG"
  echo -e "  ${BOLD}Stop proxy:${NC}    ./stop.sh"

  restart_claude
  echo ""
}

main
