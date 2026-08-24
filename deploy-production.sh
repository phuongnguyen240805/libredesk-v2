#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

if [ ! -f .env.production ]; then
  echo "Missing .env.production. Copy .env.production.example to .env.production and fill secrets first." >&2
  exit 1
fi

get_env() {
  key="$1"
  fallback="$2"
  value=$(grep -E "^[[:space:]]*${key}[[:space:]]*=" .env.production | tail -n 1 | cut -d= -f2- | tr -d '\r' || true)
  if [ -z "$value" ]; then
    printf '%s' "$fallback"
  else
    printf '%s' "$value" | sed 's/^["'\'']//; s/["'\'']$//'
  fi
}

NETWORK=$(get_env LIORA_PLATFORM_NETWORK liora-platform)

docker info >/dev/null

if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
  echo "Creating external Docker network: $NETWORK"
  docker network create "$NETWORK" >/dev/null
fi

echo "Validating production compose..."
docker compose --env-file .env.production -f docker-compose.production.yml config >/dev/null

echo "Building and starting LibreDesk production stack..."
docker compose --env-file .env.production -f docker-compose.production.yml up -d --build

echo
docker compose --env-file .env.production -f docker-compose.production.yml ps
echo
echo "Published host ports should only be 9001, 3100 and 3200 (or your overrides)."
