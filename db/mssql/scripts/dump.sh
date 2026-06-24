#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DB_NAME="${MSSQL_DB:-geocdb}"
BAK_NAME="seed.bak"
CONTAINER_BAK="/tmp/$BAK_NAME"

bash scripts/wait.sh

mkdir -p dumps

bash scripts/sqlcmd.sh -d master -Q "BACKUP DATABASE [$DB_NAME] TO DISK = N'$CONTAINER_BAK' WITH FORMAT, INIT, NAME = N'$DB_NAME full backup';"

docker cp "myproject-mssql:$CONTAINER_BAK" "dumps/$BAK_NAME"

echo "Backup written to db/mssql/dumps/$BAK_NAME"