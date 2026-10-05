#!/usr/bin/env bash
set -Eeuo pipefail

OPERATOR_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$OPERATOR_DIR/docker-compose.test.yml"
PROJECT_NAME="operator-e2e-$$"

compose() {
  docker compose --project-name "$PROJECT_NAME" --file "$COMPOSE_FILE" "$@"
}

if ! command -v docker >/dev/null 2>&1; then
  printf 'Docker is required for the database-backed test suite.\n' >&2
  exit 127
fi

if ! docker compose version >/dev/null 2>&1; then
  printf 'Docker Compose v2 is required for the database-backed test suite.\n' >&2
  exit 127
fi

cleanup() {
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

compose up --detach postgres-test

ready=0
for attempt in {1..60}; do
  if compose exec --no-TTY postgres-test pg_isready -U operator_test -d operator_test >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done

if [[ "$ready" != 1 ]]; then
  compose logs --no-color postgres-test >&2 || true
  printf 'The temporary PostgreSQL test database did not become ready in 60 seconds.\n' >&2
  exit 1
fi

published_address="$(compose port postgres-test 5432)"
published_port="${published_address##*:}"
if [[ ! "$published_port" =~ ^[0-9]+$ ]]; then
  printf 'Could not determine the temporary PostgreSQL host port.\n' >&2
  exit 1
fi

printf 'Running the full Bun test suite against a temporary PostgreSQL database on port %s.\n' "$published_port"
cd "$OPERATOR_DIR"
TEST_DATABASE_URL="postgres://operator_test:operator_test@127.0.0.1:${published_port}/operator_test" bun test
