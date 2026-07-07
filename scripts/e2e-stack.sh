#!/usr/bin/env bash
# Orchestrates the staging Docker Compose stack for the Playwright E2E suite.
#
#   scripts/e2e-stack.sh prepare   # up postgres, reset schema, migrate, seed, up app
#   scripts/e2e-stack.sh run       # run the Playwright suite against the stack
#   scripts/e2e-stack.sh test      # prepare + run
#   scripts/e2e-stack.sh down      # stop the stack and remove its volumes
#
# Configuration comes from an env file (default .env.staging; override with
# E2E_ENV_FILE). Copy .env.staging.example and keep placeholder provider keys —
# the suite never needs live providers. Real Stripe *test-mode* keys are only
# required for the payment specs, which otherwise skip.
#
# Safety: this only ever talks to the isolated tacbookings-staging compose
# project. It never touches the production compose project or port 5432.
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE="${E2E_ENV_FILE:-.env.staging}"
COMPOSE_PROJECT="${E2E_COMPOSE_PROJECT:-tacbookings-staging}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE — copy .env.staging.example and adjust (see docs/E2E_PLAYWRIGHT.md)." >&2
  exit 1
fi

# Parse the compose-style env file (KEY=VALUE, no shell quoting): values may
# contain spaces (e.g. cron schedules), and unquoted values may carry trailing
# "  # comment" annotations, so plain `source` is not safe.
while IFS= read -r line; do
  [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
  [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
  key="${line%%=*}"
  value="${line#*=}"
  value="${value%%[[:space:]]\#*}" # strip inline comment
  value="${value%"${value##*[![:space:]]}"}" # trim trailing whitespace
  export "$key=$value"
done < "$ENV_FILE"

if [[ "${STRIPE_SECRET_KEY:-}" == sk_live* || "${NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY:-}" == pk_live* ]]; then
  echo "Refusing to run: live Stripe keys found in $ENV_FILE. E2E is test-mode only." >&2
  exit 1
fi

STAGING_POSTGRES_PORT="${STAGING_POSTGRES_PORT:-5433}"
STAGING_HTTP_PORT="${STAGING_HTTP_PORT:-3001}"
MAILPIT_HTTP_PORT="${MAILPIT_HTTP_PORT:-8025}"
export E2E_BASE_URL="${E2E_BASE_URL:-http://localhost:${STAGING_HTTP_PORT}}"
# Host-side view of the mailpit HTTP API, so the Playwright email-code
# two-factor spec can read back the captured code (e2e/helpers/mailpit.ts).
export E2E_MAILPIT_URL="${E2E_MAILPIT_URL:-http://localhost:${MAILPIT_HTTP_PORT}}"
# Host-side view of the compose-internal database, for migrate + seeds.
HOST_DATABASE_URL="postgresql://tac:${DB_PASSWORD}@localhost:${STAGING_POSTGRES_PORT}/tacbookings"

compose() {
  docker compose --env-file "$ENV_FILE" -p "$COMPOSE_PROJECT" \
    -f docker-compose.yml -f docker-compose.staging.yml "$@"
}

prepare() {
  echo "==> Starting staging postgres (host port ${STAGING_POSTGRES_PORT})"
  compose up -d --wait postgres

  echo "==> Resetting database schema"
  compose exec -T postgres psql -U tac -d tacbookings -v ON_ERROR_STOP=1 \
    -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

  echo "==> Generating Prisma client"
  DATABASE_URL="$HOST_DATABASE_URL" npx prisma generate

  echo "==> Applying migrations"
  DATABASE_URL="$HOST_DATABASE_URL" npx prisma migrate deploy

  echo "==> Seeding demo data"
  ALLOW_DEMO_SEED=1 DATABASE_URL="$HOST_DATABASE_URL" npx tsx prisma/demo-seed.ts

  echo "==> Seeding base data"
  DATABASE_URL="$HOST_DATABASE_URL" npx tsx prisma/seed.ts

  echo "==> Enabling the modules the E2E journeys need"
  DATABASE_URL="$HOST_DATABASE_URL" npx tsx e2e/setup/enable-e2e-modules.ts

  # Advisory two-lodge project (#1568): when E2E_TWO_LODGE=1, the demo seed ran
  # with DEMO_SECOND_LODGE=1 (West Ridge Hut) and enable-e2e-modules turned
  # multiLodge on (E2E_ENABLE_MULTI_LODGE=1). Layer on the West Ridge seasons,
  # kiosk binding, isolation bookings and cross-lodge offers the two-lodge specs
  # need. The default blocking stack never sets this, so it is a no-op there.
  if [[ "${E2E_TWO_LODGE:-}" == "1" ]]; then
    echo "==> Seeding two-lodge E2E fixtures (West Ridge seasons, kiosk, offers)"
    DATABASE_URL="$HOST_DATABASE_URL" npx tsx e2e/setup/seed-two-lodge.ts
  fi

  echo "==> Starting app (http://localhost:${STAGING_HTTP_PORT})"
  if [[ "${E2E_SKIP_APP_BUILD:-}" == "1" ]]; then
    compose up -d --wait app
  else
    compose up -d --build --wait app
  fi
  echo "==> Stack ready"
}

run() {
  rm -rf e2e/.auth
  npx playwright test "$@"
}

case "${1:-}" in
  prepare)
    prepare
    ;;
  run)
    shift
    run "$@"
    ;;
  test)
    shift
    prepare
    run "$@"
    ;;
  down)
    compose down -v
    ;;
  *)
    echo "Usage: $0 {prepare|run|test|down} [playwright args]" >&2
    exit 1
    ;;
esac
