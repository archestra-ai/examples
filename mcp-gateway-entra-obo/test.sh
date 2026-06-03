#!/usr/bin/env bash
set -euo pipefail

npm install
npm run typecheck
npm test

echo
echo "Success: local OBO demo exchanged a gateway token for a downstream MCP Bearer token."
