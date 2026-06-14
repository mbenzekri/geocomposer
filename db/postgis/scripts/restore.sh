#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

bash scripts/wait.sh

if [ ! -f dumps/seed.dump ]; then
  echo "Missing dump: db/postgis/dumps/seed.dump" >&2
  exit 1
fi

docker cp dumps/seed.dump myproject-postgis:/tmp/seed.dump

docker exec myproject-postgis pg_restore \
  -U postgres \
  -d postgres \
  --clean \
  --if-exists \
  /tmp/seed.dump

echo "Database restored from db/postgis/dumps/seed.dump"
