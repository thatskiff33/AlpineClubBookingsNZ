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
# Same view, exported for the Playwright process (#2420). The pre-setup project
# has to put the stack into a state no admin API can reach: `saveClubTheme()`
# deliberately never clears `ClubTheme.completedAt`, so setup can be completed
# through the app but never un-completed. Only the `pre-setup` project uses it,
# and it restores the row afterwards; every other spec drives the app over HTTP.
export E2E_DATABASE_URL="$HOST_DATABASE_URL"

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
  DATABASE_URL="$HOST_DATABASE_URL" npx tsx --conditions=react-server prisma/seed.ts

  echo "==> Relativizing booking seasons so seeded fixtures never expire (#2117)"
  DATABASE_URL="$HOST_DATABASE_URL" npx tsx e2e/setup/relativize-seasons.ts

  echo "==> Enabling the modules the E2E journeys need"
  DATABASE_URL="$HOST_DATABASE_URL" npx tsx e2e/setup/enable-e2e-modules.ts

  echo "==> Seeding Stripe test-mode credentials into the encrypted store (#2082; no-op unless test keys are set)"
  DATABASE_URL="$HOST_DATABASE_URL" npx tsx --conditions=react-server e2e/setup/seed-stripe-credentials.ts

  # Multi-lodge project only (E2E_MULTI_LODGE=1): provision a second active
  # lodge and enable the multiLodge module. Skipped by default, so the default
  # single-lodge suite is seeded byte-identically.
  if [[ "${E2E_MULTI_LODGE:-}" == "1" ]]; then
    echo "==> Provisioning second lodge (E2E_MULTI_LODGE=1)"
    DATABASE_URL="$HOST_DATABASE_URL" npx tsx --conditions=react-server e2e/setup/seed-second-lodge.ts
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
  # A normal run starts from fresh browser/TOTP state. A small number of
  # ordered, same-stack evidence runs intentionally need the second command to
  # reuse the TOTP secrets created by the first command while preserving the
  # database between them. Make that exceptional behaviour explicit at the
  # call site instead of silently carrying auth state between ordinary runs.
  if [[ "${E2E_PRESERVE_AUTH_STATE:-0}" != "1" ]]; then
    rm -rf e2e/.auth
  fi
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
