#!/usr/bin/env bash

ORACLE_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORACLE_ROOT_DIR="$(cd "$ORACLE_SCRIPT_DIR/.." && pwd)"

ORACLE_CONTAINER="${ORACLE_CONTAINER:-myproject-oracle-xe}"
ORACLE_SYS_PASSWORD="${ORACLE_SYS_PASSWORD:-oracle}"
ORACLE_APP_USER="${ORACLE_APP_USER:-GEOCOMPOSER}"
ORACLE_APP_PASSWORD="${ORACLE_APP_PASSWORD:-geocomposer}"
ORACLE_SERVICE="${ORACLE_SERVICE:-XEPDB1}"
ORACLE_CONNECT_HOST="${ORACLE_CONNECT_HOST:-localhost}"
ORACLE_CONNECT_PORT="${ORACLE_CONNECT_PORT:-1521}"
ORACLE_RESTORE_SQL="${ORACLE_RESTORE_SQL:-$ORACLE_ROOT_DIR/init/world.sql}"
ORACLE_RESTORE_DIR_PATH="${ORACLE_RESTORE_DIR_PATH:-/tmp/geocomposer-restore}"

oracle_connect_descriptor() {
  printf '//%s:%s/%s' "$ORACLE_CONNECT_HOST" "$ORACLE_CONNECT_PORT" "$ORACLE_SERVICE"
}

oracle_system_connection() {
  printf 'system/%s@%s' "$ORACLE_SYS_PASSWORD" "$(oracle_connect_descriptor)"
}

oracle_app_connection() {
  printf '%s/%s@%s' "$ORACLE_APP_USER" "$ORACLE_APP_PASSWORD" "$(oracle_connect_descriptor)"
}
