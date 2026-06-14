#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

bash scripts/wait.sh

mkdir -p dumps

docker exec myproject-postgis pg_dump \
  -U postgres \
  -d postgres \
  -Fc \
  -f /tmp/seed.dump

docker cp myproject-postgis:/tmp/seed.dump dumps/seed.dump

echo "Dump written to db/postgis/dumps/seed.dump"
