#!/usr/bin/env bash
set -euo pipefail

PASSWORD="${MSSQL_SA_PASSWORD:-Mssqlserver0!}"
DB_NAME="${MSSQL_DB:-geocdb}"

bash scripts/wait.sh

docker exec -it myproject-mssql /opt/mssql-tools18/bin/sqlcmd \
  -S localhost \
  -U sa \
  -P "$PASSWORD" \
  -C \
  -d "$DB_NAME"