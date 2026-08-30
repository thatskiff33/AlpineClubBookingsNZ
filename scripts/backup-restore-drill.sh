#!/usr/bin/env bash
# Backup / restore fire drill for AlpineClubBookingsNZ.
#
#   scripts/backup-restore-drill.sh                 # self-contained local drill
#   scripts/backup-restore-drill.sh --from-dump P   # restore an operator-supplied dump P
#   scripts/backup-restore-drill.sh --help
#
# WHAT IT PROVES
#   A pg_dump artifact (the same plain-SQL, gzipped shape src/lib/backup.ts
#   produces) can be restored into an empty database, that Prisma migrations
#   run forward on the restored data, and that the restored rows still satisfy
#   the integer-cent money invariants. The quarterly runbook lives in
#   docs/MAINTENANCE.md.
#
# TWO MODES
#   Default (local):   spins up a throwaway Postgres, seeds a source database,
#                      dumps it, restores into a second database, and asserts
#                      restore fidelity + sentinel + migration health.
#   --from-dump <path>: restores an operator-supplied dump (e.g. a production
#                      S3 backup the operator downloaded THEMSELVES) into the
#                      throwaway restore database and runs only the sentinel +
#                      migration assertions. Source-fidelity comparisons are
#                      skipped because there is no local source to compare to.
#
# SAFETY
#   * Port 5432 on this host is LIVE PRODUCTION Postgres. This script NEVER
#     touches it: it starts its own container bound to 127.0.0.1:55441.
#   * The container name is acb-fire-drill-db and it is removed on exit (even on
#     failure) via a trap. All scratch files live in a mktemp dir, also removed.
#   * The drill never fetches from S3 and never reads live provider credentials.
#     In --from-dump mode the operator supplies the file; the script only reads
#     it locally.
#   * Client tools (pg_dump/psql/pg_restore) run INSIDE the postgres:16
#     container via `docker exec`, so the dump/restore uses a client that
#     matches the server major version regardless of what is on the host PATH.
set -euo pipefail

# --------------------------------------------------------------------------- #
# Constants — the port and container name are fixed so this can never collide
# with production (5432) or the E2E/staging stacks (5433).
# --------------------------------------------------------------------------- #
CONTAINER="acb-fire-drill-db"
DRILL_PORT="55441"
PG_IMAGE="postgres:16"
SRC_DB="drill_source"
RES_DB="drill_restore"
FIDELITY_TABLES=(Member Booking Payment BookingGuest BookingGuestNight)

if [[ "$DRILL_PORT" == "5432" ]]; then
  echo "Refusing to run: drill port must never be 5432 (production)." >&2
  exit 1
fi

# Remember the invoking directory so a relative --from-dump path still resolves
# after we cd into the repo root below.
INVOKE_PWD="$PWD"
cd "$(dirname "$0")/.."

# --------------------------------------------------------------------------- #
# Argument parsing
# --------------------------------------------------------------------------- #
MODE="local"
FROM_DUMP=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from-dump)
      MODE="from-dump"
      FROM_DUMP="${2:-}"
      if [[ -z "$FROM_DUMP" ]]; then
        echo "--from-dump requires a path to a dump file." >&2
        exit 1
      fi
      shift 2
      ;;
    -h|--help)
      # Print the header comment block (skip the shebang, stop at the first
      # non-comment line) as usage text.
      awk 'NR==1 {next} /^#/ {sub(/^# ?/, ""); print; next} {exit}' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1 (see --help)." >&2
      exit 1
      ;;
  esac
done

if [[ "$MODE" == "from-dump" ]]; then
  # Resolve a relative dump path against the operator's original directory.
  [[ "$FROM_DUMP" != /* ]] && FROM_DUMP="${INVOKE_PWD}/${FROM_DUMP}"
  if [[ ! -r "$FROM_DUMP" ]]; then
    echo "Dump file not found or not readable: $FROM_DUMP" >&2
    exit 1
  fi
fi

# --------------------------------------------------------------------------- #
# Scratch dir + teardown trap (fires on success AND failure)
# --------------------------------------------------------------------------- #
WORK_DIR="$(mktemp -d)"
cleanup() {
  local status=$?
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORK_DIR" >/dev/null 2>&1 || true
  return "$status"
}
trap cleanup EXIT

log() { echo "==> $*"; }
fatal() { echo "ERROR: $*" >&2; exit 1; }

# psql helpers run inside the container as the postgres superuser (peer auth),
# so no password crosses the wire and the client is postgres:16.
psql_val() {
  # psql_val <db> <sql>  -> single scalar value, trimmed
  docker exec -u postgres "$CONTAINER" psql -tAX -d "$1" -c "$2"
}

# --------------------------------------------------------------------------- #
# Assertion accounting — every assertion is recorded so the full PASS/FAIL
# summary always prints, then the script exits non-zero if any failed.
# --------------------------------------------------------------------------- #
SUMMARY=()
FAILS=0
pass() { SUMMARY+=("PASS  $1"); }
fail() { SUMMARY+=("FAIL  $1"); FAILS=$((FAILS + 1)); }
skip() { SUMMARY+=("SKIP  $1"); }

# --------------------------------------------------------------------------- #
# Container lifecycle
# --------------------------------------------------------------------------- #
start_container() {
  # Pre-clean any container left by a crashed prior run so re-runs are idempotent.
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

  local password
  password="$(openssl rand -hex 16 2>/dev/null \
    || head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  [[ -n "$password" ]] || fatal "could not generate a database password"

  log "Starting throwaway ${PG_IMAGE} as ${CONTAINER} on 127.0.0.1:${DRILL_PORT}"
  docker run --rm -d --name "$CONTAINER" \
    -e POSTGRES_PASSWORD="$password" \
    -e POSTGRES_DB=postgres \
    --tmpfs /var/lib/postgresql/data \
    -p "127.0.0.1:${DRILL_PORT}:5432" \
    "$PG_IMAGE" >/dev/null

  # Host-side connection string for the Node/Prisma steps (migrate + seeds).
  # These are the ONLY database URLs the drill ever uses.
  SRC_URL="postgresql://postgres:${password}@127.0.0.1:${DRILL_PORT}/${SRC_DB}"
  RES_URL="postgresql://postgres:${password}@127.0.0.1:${DRILL_PORT}/${RES_DB}"

  log "Waiting for Postgres to accept connections"
  local i
  for i in $(seq 1 60); do
    if docker exec "$CONTAINER" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  fatal "Postgres did not become ready within 60s"
}

create_databases() {
  if [[ "$MODE" == "local" ]]; then
    log "Creating databases ${SRC_DB} and ${RES_DB}"
    docker exec -u postgres "$CONTAINER" psql -v ON_ERROR_STOP=1 \
      -c "CREATE DATABASE ${SRC_DB};" -c "CREATE DATABASE ${RES_DB};" >/dev/null
  else
    log "Creating database ${RES_DB}"
    docker exec -u postgres "$CONTAINER" psql -v ON_ERROR_STOP=1 \
      -c "CREATE DATABASE ${RES_DB};" >/dev/null
  fi
}

# --------------------------------------------------------------------------- #
# Source preparation (local mode only): migrate, seed, dump.
# Seeds are invoked exactly as scripts/e2e-stack.sh does, with minimal inline
# placeholder env — the drill never reads the repo .env (DOTENV_CONFIG_PATH is
# pointed at an empty file, and DATABASE_URL is set explicitly so nothing can
# redirect the drill at another database).
# --------------------------------------------------------------------------- #
prepare_source() {
  export DOTENV_CONFIG_PATH=/dev/null
  export SEED_ADMIN_EMAIL="${SEED_ADMIN_EMAIL:-drill-admin@fire-drill.local}"
  export SEED_ADMIN_PASSWORD="${SEED_ADMIN_PASSWORD:-FireDrill-Admin-Placeholder-1}"
  export SEED_LODGE_PASSWORD="${SEED_LODGE_PASSWORD:-FireDrill-Lodge-Placeholder-1}"

  log "Applying migrations to ${SRC_DB}"
  DATABASE_URL="$SRC_URL" npx prisma migrate deploy >/dev/null

  log "Seeding demo data (prisma/demo-seed.ts)"
  ALLOW_DEMO_SEED=1 DATABASE_URL="$SRC_URL" npx tsx prisma/demo-seed.ts >/dev/null

  log "Seeding base data (prisma/seed.ts)"
  DATABASE_URL="$SRC_URL" npx tsx --conditions=react-server prisma/seed.ts >/dev/null

  # Take the backup: plain pg_dump piped through gzip, matching the artifact
  # shape src/lib/backup.ts writes (pg_dump with no format flags, then gzip).
  DUMP_FILE="${WORK_DIR}/drill-source.sql.gz"
  log "Taking backup: pg_dump ${SRC_DB} | gzip -> ${DUMP_FILE##*/}"
  docker exec -u postgres "$CONTAINER" pg_dump "$SRC_DB" | gzip > "$DUMP_FILE"
  [[ -s "$DUMP_FILE" ]] || fatal "pg_dump produced an empty backup"
}

# --------------------------------------------------------------------------- #
# Restore a dump into a database. The target schema is reset first (mirroring
# the src/lib/backup.ts restore path). Format is auto-detected from the file's
# magic bytes so both the local gzipped plain dump and an operator-supplied
# artifact restore through the same code path.
# --------------------------------------------------------------------------- #
restore_dump() {
  local path="$1" db="$2"

  log "Resetting public schema in ${db}"
  docker exec -u postgres "$CONTAINER" psql -v ON_ERROR_STOP=1 -qX -d "$db" \
    -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;" >/dev/null

  # Detect format from magic bytes without slurping binary into a variable
  # (gzip: 1f 8b; pg_dump custom archive: ASCII "PGDMP").
  local magic2
  magic2="$(head -c 2 "$path" | od -An -tx1 | tr -d ' \n')"

  if [[ "$magic2" == "1f8b" ]]; then
    log "Restoring gzipped plain-SQL dump into ${db}"
    gunzip -c "$path" \
      | docker exec -i -u postgres "$CONTAINER" psql -v ON_ERROR_STOP=1 -qX -d "$db" >/dev/null
  elif head -c 5 "$path" | grep -q '^PGDMP'; then
    log "Restoring custom-format dump into ${db} (pg_restore)"
    docker exec -i -u postgres "$CONTAINER" pg_restore --no-owner -d "$db" >/dev/null < "$path"
  else
    log "Restoring plain-SQL dump into ${db}"
    docker exec -i -u postgres "$CONTAINER" psql -v ON_ERROR_STOP=1 -qX -d "$db" >/dev/null < "$path"
  fi
}

# --------------------------------------------------------------------------- #
# Assertions. Runs with `set +e` so a single failing query never aborts the
# drill before the summary prints; failures are tallied instead.
# --------------------------------------------------------------------------- #
run_assertions() {
  set +e

  # ---- restore-side metrics (collected for the summary + assertions) -------
  RES_COUNTS=()
  local t
  for t in "${FIDELITY_TABLES[@]}"; do
    RES_COUNTS+=("$(psql_val "$RES_DB" "SELECT count(*) FROM \"$t\";")")
  done
  RES_BOOKING_SUM="$(psql_val "$RES_DB" 'SELECT COALESCE(SUM("finalPriceCents"),0) FROM "Booking";')"
  RES_PAYMENT_SUM="$(psql_val "$RES_DB" 'SELECT COALESCE(SUM("amountCents"),0) FROM "Payment";')"

  # ---- restore fidelity (local mode only) ----------------------------------
  if [[ "$MODE" == "local" ]]; then
    SRC_COUNTS=()
    for t in "${FIDELITY_TABLES[@]}"; do
      SRC_COUNTS+=("$(psql_val "$SRC_DB" "SELECT count(*) FROM \"$t\";")")
    done
    SRC_BOOKING_SUM="$(psql_val "$SRC_DB" 'SELECT COALESCE(SUM("finalPriceCents"),0) FROM "Booking";')"
    SRC_PAYMENT_SUM="$(psql_val "$SRC_DB" 'SELECT COALESCE(SUM("amountCents"),0) FROM "Payment";')"

    local i
    for i in "${!FIDELITY_TABLES[@]}"; do
      t="${FIDELITY_TABLES[$i]}"
      if [[ "${SRC_COUNTS[$i]}" == "${RES_COUNTS[$i]}" ]]; then
        pass "fidelity: ${t} row count matches (${RES_COUNTS[$i]})"
      else
        fail "fidelity: ${t} row count source=${SRC_COUNTS[$i]} restore=${RES_COUNTS[$i]}"
      fi
    done

    assert_money_match "Booking.finalPriceCents sum" "$SRC_BOOKING_SUM" "$RES_BOOKING_SUM"
    assert_money_match "Payment.amountCents sum" "$SRC_PAYMENT_SUM" "$RES_PAYMENT_SUM"
  else
    skip "fidelity: row counts (no local source in --from-dump mode)"
    skip "fidelity: money sums (no local source in --from-dump mode)"
  fi

  # ---- sentinel invariants on the restored DB ------------------------------
  local badB badP
  badB="$(psql_val "$RES_DB" 'SELECT count(*) FROM "Booking" WHERE "finalPriceCents" IS NULL OR "finalPriceCents" < 0;')"
  badP="$(psql_val "$RES_DB" 'SELECT count(*) FROM "Payment" WHERE "amountCents" IS NULL OR "amountCents" < 0;')"
  if [[ "$badB" == "0" ]]; then
    pass "sentinel: no Booking rows with NULL/negative finalPriceCents"
  else
    fail "sentinel: ${badB} Booking rows have NULL/negative finalPriceCents"
  fi
  if [[ "$badP" == "0" ]]; then
    pass "sentinel: no Payment rows with NULL/negative amountCents"
  else
    fail "sentinel: ${badP} Payment rows have NULL/negative amountCents"
  fi

  # ---- migration table health ----------------------------------------------
  local unfinished
  unfinished="$(psql_val "$RES_DB" "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL;")"
  if [[ "$unfinished" == "0" ]]; then
    pass "migrations: _prisma_migrations has no unfinished rows"
  else
    fail "migrations: ${unfinished} unfinished _prisma_migrations rows after migrate deploy"
  fi

  set -e
}

assert_money_match() {
  # assert_money_match <label> <source> <restore>
  local label="$1" src="$2" res="$3"
  if [[ ! "$src" =~ ^-?[0-9]+$ ]]; then
    fail "${label}: source value is not an integer (${src})"
  elif [[ ! "$res" =~ ^-?[0-9]+$ ]]; then
    fail "${label}: restore value is not an integer (${res})"
  elif [[ "$src" == "$res" ]]; then
    pass "${label}: integer cents match (${res})"
  else
    fail "${label}: source=${src} restore=${res}"
  fi
}

print_summary() {
  local line
  echo
  echo "======================================================================"
  echo " Backup / restore fire drill summary"
  echo " timestamp : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo " mode      : ${MODE}"
  echo " image     : ${PG_IMAGE}   endpoint: 127.0.0.1:${DRILL_PORT} (never 5432)"
  if [[ "$MODE" == "from-dump" ]]; then
    echo " dump      : ${FROM_DUMP}"
  fi
  echo "----------------------------------------------------------------------"
  echo " Restore metrics (${RES_DB}):"
  local i
  for i in "${!FIDELITY_TABLES[@]}"; do
    printf "   %-20s %s\n" "${FIDELITY_TABLES[$i]}" "${RES_COUNTS[$i]}"
  done
  printf "   %-20s %s\n" "SUM finalPriceCents" "${RES_BOOKING_SUM}"
  printf "   %-20s %s\n" "SUM amountCents" "${RES_PAYMENT_SUM}"
  if [[ "$MODE" == "local" ]]; then
    echo "   (source counts/sums identical by fidelity assertions below)"
  fi
  echo "----------------------------------------------------------------------"
  echo " Assertions:"
  for line in "${SUMMARY[@]}"; do
    echo "   ${line}"
  done
  echo "----------------------------------------------------------------------"
  if [[ "$FAILS" -eq 0 ]]; then
    echo " RESULT: PASS — backup is restorable and invariants hold."
  else
    echo " RESULT: FAIL — ${FAILS} assertion(s) failed. Treat as a backup-pipeline"
    echo "         incident: do NOT overwrite any backup, and escalate to the owner."
  fi
  echo "======================================================================"
}

# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
command -v docker >/dev/null 2>&1 || fatal "docker is required but not on PATH"

start_container
create_databases

if [[ "$MODE" == "local" ]]; then
  prepare_source
  restore_dump "$DUMP_FILE" "$RES_DB"
else
  restore_dump "$FROM_DUMP" "$RES_DB"
fi

log "Running migrations forward on the restored database (${RES_DB})"
export DOTENV_CONFIG_PATH=/dev/null
DATABASE_URL="$RES_URL" npx prisma migrate deploy >/dev/null

run_assertions
print_summary

if [[ "$FAILS" -gt 0 ]]; then
  exit 1
fi
