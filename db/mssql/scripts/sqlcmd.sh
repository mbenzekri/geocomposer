#!/usr/bin/env bash
set -euo pipefail

PASSWORD="${MSSQL_SA_PASSWORD:-Mssqlserver0!}"

if docker exec myproject-mssql test -x /opt/mssql-tools18/bin/sqlcmd >/dev/null 2>&1; then
  docker exec myproject-mssql /opt/mssql-tools18/bin/sqlcmd \
    -S localhost \
    -U sa \
    -P "$PASSWORD" \
    -C \
    "$@"
elif docker exec myproject-mssql test -x /opt/mssql-tools/bin/sqlcmd >/dev/null 2>&1; then
  docker exec myproject-mssql /opt/mssql-tools/bin/sqlcmd \
    -S localhost \
    -U sa \
    -P "$PASSWORD" \
    "$@"
else
  echo "sqlcmd not found in myproject-mssql." >&2
  echo "Install sqlcmd on the host or build a custom SQL Server image including mssql-tools18." >&2
  exit 1
fi
