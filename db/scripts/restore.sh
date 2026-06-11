#!/usr/bin/env bash
set -e

docker cp ./dumps/seed.dump myproject-postgis:/tmp/seed.dump

docker exec myproject-postgis pg_restore \
  -U postgres \
  -d postgres \
  --clean \
  --if-exists \
  /tmp/seed.dump

echo "Database restored from db/dumps/seed.dump"
