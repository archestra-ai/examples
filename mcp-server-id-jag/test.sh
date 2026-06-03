#!/usr/bin/env bash
set -euo pipefail

npm install
npm run build
npm test

echo
echo "Success: local ID-JAG demo minted an MCP access token and rejected the original assertion as an MCP bearer token."
