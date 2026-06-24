#!/usr/bin/env bash
set -euo pipefail

docker compose down -v
npm run up
npm run wait
npm run init
npm run restore

