#!/usr/bin/env bash
set -e

mkdir -p ./dumps

docker exec myproject-postgis pg_dump \
  -U postgres \
  -d postgres \
  -Fc \
  -f /tmp/seed.dump

docker cp myproject-postgis:/tmp/seed.dump ./dumps/seed.dump

echo "Dump written to ./dumps/seed.dump"