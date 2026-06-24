#!/usr/bin/env bash
set -euo pipefail

timeout="${MSSQL_WAIT_TIMEOUT:-120}"

for ((elapsed = 0; elapsed < timeout; elapsed += 1)); do
  if bash scripts/sqlcmd.sh -Q "SELECT 1" >/dev/null 2>&1; then
    echo "SQL Server is ready"
    exit 0
  fi

  sleep 1
done

echo "SQL Server did not become ready within ${timeout}s" >&2
docker logs myproject-mssql >&2 || true
exit 1
