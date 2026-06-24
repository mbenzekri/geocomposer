#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DB_NAME="${MSSQL_DB:-geocdb}"
APP_USER="${MSSQL_APP_USER:-geocuser}"
APP_PASSWORD="${MSSQL_APP_PASSWORD:-Geocomposer0!}"
SCHEMA_NAME="${MSSQL_SCHEMA:-geoc}"
INIT_FILE="init/01-create-geocdb.sql"
CONTAINER_INIT_FILE="/tmp/01-create-geocdb.sql"

bash scripts/wait.sh

docker cp "$INIT_FILE" "myproject-mssql:$CONTAINER_INIT_FILE"

bash scripts/sqlcmd.sh   -v MSSQL_DB="$DB_NAME"      MSSQL_APP_USER="$APP_USER"      MSSQL_APP_PASSWORD="$APP_PASSWORD"      MSSQL_SCHEMA="$SCHEMA_NAME"   -i "$CONTAINER_INIT_FILE"

echo "SQL Server initialized: database=$DB_NAME user=$APP_USER schema=$SCHEMA_NAME"
