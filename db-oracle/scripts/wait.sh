#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

MAX_ATTEMPTS="${ORACLE_WAIT_ATTEMPTS:-120}"
SLEEP_SECONDS="${ORACLE_WAIT_SLEEP:-5}"

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  if docker exec "$ORACLE_CONTAINER" healthcheck.sh >/dev/null 2>&1; then
    echo "Oracle is ready."
    exit 0
  fi

  if [ "$attempt" -eq "$MAX_ATTEMPTS" ]; then
    echo "Oracle did not become ready after $((MAX_ATTEMPTS * SLEEP_SECONDS)) seconds." >&2
    docker logs "$ORACLE_CONTAINER" >&2 || true
    exit 1
  fi

  sleep "$SLEEP_SECONDS"
done
