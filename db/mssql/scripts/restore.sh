#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DB_NAME="${MSSQL_DB:-geocdb}"
BAK_NAME="seed.bak"
CONTAINER_BAK="/tmp/$BAK_NAME"

bash scripts/wait.sh

if [ ! -f "dumps/$BAK_NAME" ]; then
  echo "Missing backup: db/mssql/dumps/$BAK_NAME" >&2
  exit 1
fi

docker cp "dumps/$BAK_NAME" "myproject-mssql:$CONTAINER_BAK"
docker exec -u root myproject-mssql chown mssql:mssql "$CONTAINER_BAK"

bash scripts/sqlcmd.sh -d master -b -Q "IF DB_ID(N'$DB_NAME') IS NOT NULL BEGIN ALTER DATABASE [$DB_NAME] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [$DB_NAME]; END"

bash scripts/sqlcmd.sh -d master -b -Q "RESTORE DATABASE [$DB_NAME] FROM DISK = N'$CONTAINER_BAK' WITH REPLACE, RECOVERY;"

echo "Database restored from db/mssql/dumps/$BAK_NAME"