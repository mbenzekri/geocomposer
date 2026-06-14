#!/usr/bin/env bash
set -euo pipefail

timeout="${POSTGIS_WAIT_TIMEOUT:-60}"

for ((elapsed = 0; elapsed < timeout; elapsed += 1)); do
  if docker exec myproject-postgis pg_isready -U postgres -d postgres >/dev/null 2>&1; then
    echo "PostGIS is ready"
    exit 0
  fi

  sleep 1
done

echo "PostGIS did not become ready within ${timeout}s" >&2
docker logs myproject-postgis >&2 || true
exit 1
