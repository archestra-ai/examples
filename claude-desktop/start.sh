#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────
# Claude Desktop + Archestra — MCP Guard Setup
#
# Wraps Claude Desktop's MCP server connections with Archestra
# policy enforcement. Every tool call is checked against a
# policy before it can execute — blocking attacks like the
# LayerX CVSS 10/10 zero-click RCE via calendar injection.
#
# Usage: ./setup.sh
# ─────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GUARD_SCRIPT="${SCRIPT_DIR}/archestra-mcp-guard.mjs"
POLICY_FILE="${SCRIPT_DIR}/policy.json"
CONFIG_FILE="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
BACKUP_FILE="$HOME/Library/Application Support/Claude/claude_desktop_config.backup.json"

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
  echo -e "${CYAN}${BOLD}║    Claude Desktop + Archestra MCP Guard Setup   ║${NC}"
  echo -e "${CYAN}${BOLD}╚══════════════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "  This script wraps Claude Desktop's MCP extensions with"
  echo -e "  Archestra policy enforcement. Every tool call is checked"
  echo -e "  before it can execute — blocking prompt injection attacks"
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

check_node() {
  if ! command -v node &>/dev/null; then
    error "Node.js is required but not installed."
    echo "  Install it: https://nodejs.org/ or brew install node"
    exit 1
  fi
  success "Node.js found ($(node --version))"
}

check_jq() {
  if ! command -v jq &>/dev/null; then
    warn "jq is not installed (needed to modify Claude Desktop config)."
    echo ""
    read -rp "  Install jq via Homebrew? [Y/n] " answer
    answer=${answer:-Y}
    if [[ "$answer" =~ ^[Yy]$ ]]; then
      info "Installing jq..."
      brew install jq
      success "jq installed"
    else
      error "jq is required. Install it manually: brew install jq"
      exit 1
    fi
  else
    success "jq found"
  fi
}

check_claude_desktop() {
  if [[ ! -d "/Applications/Claude.app" ]]; then
    error "Claude Desktop not found at /Applications/Claude.app"
    echo "  Download it from: https://claude.ai/download"
    exit 1
  fi
  success "Claude Desktop found"
}

check_config_exists() {
  if [[ ! -f "$CONFIG_FILE" ]]; then
    error "Claude Desktop config not found at:"
    echo "  $CONFIG_FILE"
    echo ""
    echo "  Open Claude Desktop at least once, or create the file with:"
    echo '  echo "{}" > "'"$CONFIG_FILE"'"'
    exit 1
  fi
  success "Claude Desktop config found"
}

# ── Check if already guarded ─────────────────────────────
is_already_guarded() {
  if grep -q "archestra-mcp-guard" "$CONFIG_FILE" 2>/dev/null; then
    return 0
  fi
  return 1
}

# ── Wrap MCP servers with guard ───────────────────────────
inject_guard() {
  if is_already_guarded; then
    success "MCP servers already wrapped with Archestra guard"
    return 0
  fi

  info "Backing up Claude Desktop config..."
  cp "$CONFIG_FILE" "$BACKUP_FILE"
  success "Backup saved to: $(basename "$BACKUP_FILE")"

  info "Wrapping MCP servers with Archestra guard..."

  # Read current config
  local config
  config=$(cat "$CONFIG_FILE")

  # Get the list of MCP server names
  local server_names
  server_names=$(echo "$config" | jq -r '.mcpServers // {} | keys[]' 2>/dev/null)

  if [[ -z "$server_names" ]]; then
    warn "No MCP servers found in Claude Desktop config."
    echo "  Install some DXT extensions first, then re-run this script."
    return 0
  fi

  echo ""
  echo -e "  Found MCP servers:"

  local modified_config="$config"
  local count=0

  while IFS= read -r server_name; do
    local current_command
    current_command=$(echo "$modified_config" | jq -r ".mcpServers[\"$server_name\"].command // empty")
    local current_args
    current_args=$(echo "$modified_config" | jq -c ".mcpServers[\"$server_name\"].args // []")

    # Skip if already guarded
    if [[ "$current_command" == *"archestra-mcp-guard"* ]]; then
      echo -e "    ${GREEN}✓${NC} $server_name (already guarded)"
      continue
    fi

    # Skip servers with no command (URL-based remote servers)
    if [[ -z "$current_command" ]]; then
      echo -e "    ${YELLOW}−${NC} $server_name (remote server, skipped)"
      continue
    fi

    echo -e "    ${BLUE}+${NC} $server_name (${current_command})"

    # Build new args: [guard_script, --policy, policy_path, --, original_command, ...original_args]
    local new_args
    new_args=$(jq -n \
      --arg guard "$GUARD_SCRIPT" \
      --arg policy "$POLICY_FILE" \
      --arg cmd "$current_command" \
      --argjson orig_args "$current_args" \
      '[$guard, "--policy", $policy, "--", $cmd] + $orig_args')

    # Update the config: command becomes "node", args become the guard wrapper
    modified_config=$(echo "$modified_config" | jq \
      --arg name "$server_name" \
      --argjson new_args "$new_args" \
      '.mcpServers[$name].command = "node" | .mcpServers[$name].args = $new_args')

    count=$((count + 1))
  done <<< "$server_names"

  if [[ $count -eq 0 ]]; then
    info "No MCP servers needed wrapping."
    return 0
  fi

  # Write the modified config
  echo "$modified_config" | jq '.' > "$CONFIG_FILE"
  echo ""
  success "Wrapped $count MCP server(s) with Archestra guard"
}

# ── Show policy summary ──────────────────────────────────
show_policy() {
  echo ""
  echo -e "${BOLD}Active Policy:${NC} $POLICY_FILE"
  echo ""

  local blocked_tools
  blocked_tools=$(jq -r '.blocked_tools[]? // empty' "$POLICY_FILE" 2>/dev/null)
  if [[ -n "$blocked_tools" ]]; then
    echo -e "  ${RED}Blocked tools:${NC}"
    while IFS= read -r tool; do
      echo -e "    ✗ $tool"
    done <<< "$blocked_tools"
  fi

  local blocked_args
  blocked_args=$(jq -r '.blocked_arguments | keys[]? // empty' "$POLICY_FILE" 2>/dev/null)
  if [[ -n "$blocked_args" ]]; then
    echo -e "  ${YELLOW}Argument restrictions:${NC}"
    while IFS= read -r tool; do
      local patterns
      patterns=$(jq -r ".blocked_arguments[\"$tool\"] | to_entries[] | \"\\(.key): \\(.value | join(\", \"))\"" "$POLICY_FILE" 2>/dev/null)
      echo -e "    $tool:"
      while IFS= read -r pattern; do
        echo -e "      ✗ $pattern"
      done <<< "$patterns"
    done <<< "$blocked_args"
  fi
}

# ── Restart Claude Desktop ────────────────────────────────
restart_claude() {
  echo ""
  read -rp "  Restart Claude Desktop now to apply changes? [Y/n] " answer
  answer=${answer:-Y}
  if [[ "$answer" =~ ^[Yy]$ ]]; then
    info "Restarting Claude Desktop..."
    osascript -e 'quit app "Claude"' 2>/dev/null || true
    sleep 2
    open -a Claude
    success "Claude Desktop restarted"
  else
    warn "Changes will take effect next time Claude Desktop starts."
  fi
}

# ── Main ───────────────────────────────────────────────────
main() {
  banner
  check_os
  check_node
  check_jq
  check_claude_desktop
  check_config_exists
  inject_guard
  show_policy

  echo ""
  echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}${BOLD}║                  Setup Complete!                 ║${NC}"
  echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "  Every MCP tool call now passes through Archestra's guard."
  echo -e "  Blocked calls are logged to: /tmp/archestra-mcp-guard.log"
  echo ""
  echo -e "  ${BOLD}Edit policies:${NC}   $POLICY_FILE"
  echo -e "  ${BOLD}View log:${NC}        tail -f /tmp/archestra-mcp-guard.log"
  echo -e "  ${BOLD}Restore config:${NC}  ./stop.sh"

  restart_claude
}

main
