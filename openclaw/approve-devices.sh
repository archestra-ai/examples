#!/usr/bin/env bash
set -euo pipefail

# Approve all pending OpenClaw device pairing requests
PENDING_IDS=$(docker compose exec -T openclaw-gateway node dist/index.js devices list 2>&1 \
  | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' || true)

if [ -z "$PENDING_IDS" ]; then
  echo "No pending device pairing requests."
  exit 0
fi

for id in $PENDING_IDS; do
  echo "Approving $id ..."
  docker compose exec -T openclaw-gateway node dist/index.js devices approve "$id"
done
