#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────
# Stop Archestra protection for Claude Desktop
#
# Kills the mitmproxy process and restarts Claude Desktop
# without the proxy, restoring normal direct-to-claude.ai traffic.
# ─────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC}   $1"; }
warn()    { echo -e "${RED}[WARN]${NC} $1"; }

echo ""
echo -e "${BOLD}Stopping Archestra protection for Claude Desktop...${NC}"
echo ""

# ── Kill mitmproxy ───────────────────────────────────────────
MITM_PIDS=$(pgrep -f "mitmdump.*proxy-addon" 2>/dev/null || true)
if [[ -n "$MITM_PIDS" ]]; then
  echo "$MITM_PIDS" | xargs kill 2>/dev/null || true
  sleep 1
  success "Stopped mitmproxy (PID: $(echo $MITM_PIDS | tr '\n' ' '))"
else
  warn "No mitmproxy process found (already stopped?)"
fi

# ── Restart Claude Desktop without proxy ─────────────────────
echo ""
read -rp "  Restart Claude Desktop without proxy? [Y/n] " answer
answer=${answer:-Y}
if [[ "$answer" =~ ^[Yy]$ ]]; then
  info "Restarting Claude Desktop..."
  osascript -e 'quit app "Claude"' 2>/dev/null || true
  sleep 2
  open -a Claude
  success "Claude Desktop restarted (no proxy)"
else
  echo "  Quit and reopen Claude Desktop manually to remove proxy."
fi
echo ""
