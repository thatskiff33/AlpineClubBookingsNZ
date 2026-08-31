#!/usr/bin/env bash
# Orchestrates the ISOLATED tacbookings-measure stack for the #2352 slice-1
# staging evaluation. Run from the wt-measure worktree root.
#
# Manual commands must run through the private snapshot wrapper so the source
# .env file never becomes Compose's mutable runtime authority:
#
#   measurement/stack/measure-stack.sh with-private-env -- \
#     bash measurement/stack/measure-stack.sh prepare
#   measurement/stack/measure-stack.sh with-private-env -- \
#     bash measurement/stack/measure-stack.sh prepare-canonical-dump <absolute-path>
#
# Commands below are inner commands. Calling one directly is valid only while
# the reviewed wrapper (or the phase-2 orchestrator) owns the fixed lock and has
# exported its HMAC-bound private snapshot.
#
#   measurement/stack/measure-stack.sh prepare          # postgres + schema + seeds + app + caddy
#   measurement/stack/measure-stack.sh restore-canonical-dump <absolute-path> <sha256>
#   measurement/stack/measure-stack.sh database-fingerprint
#   measurement/stack/measure-stack.sh app-image <tag>  # swap the app image (e.g. tacbookings-measure-app:baseline)
#   measurement/stack/measure-stack.sh restart-app      # restart the app container (clears the in-memory ISR store)
#   measurement/stack/measure-stack.sh up               # start postgres+mailpit+app+caddy (existing data)
#   measurement/stack/measure-stack.sh stop             # stop containers, keep them + volumes
#   measurement/stack/measure-stack.sh down             # remove containers + network, KEEP volumes (seeded DB survives)
#   measurement/stack/measure-stack.sh destroy          # remove containers + volumes (full reset)
#
# Safety: only ever touches the tacbookings-measure compose project
# (ports 3003/5435/8027/8127, all loopback-bound). Never the staging
# (tacbookings-staging, 3001/5433/8025) or any production stack.
set -euo pipefail

SCRIPT_DIRECTORY="$(cd "$(dirname "$0")" && pwd -P)"
cd "$SCRIPT_DIRECTORY/../.."
ROOT="$(pwd)"

new_private_token() {
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex") + "\n")'
}

with_private_env() {
  [[ "${1:-}" == -- ]] || {
    echo "usage: $0 with-private-env -- <command> [args...]" >&2
    exit 2
  }
  shift
  [[ "$#" -gt 0 ]] || {
    echo "with-private-env requires a command" >&2
    exit 2
  }
  case "$(uname -s)" in
    MINGW*|MSYS*) ;;
    *) echo "the private measurement wrapper is cleared only for Git Bash on Windows" >&2; exit 2 ;;
  esac

  local windows_temp_path lock_dir lock_token snapshot key_file audit_file snapshot_hmac command_status
  local lock_held=false
  windows_temp_path="$(powershell.exe -NoProfile -NonInteractive -Command '[IO.Path]::GetTempPath()' | tr -d '\0\r\n')"
  lock_dir="$(cygpath -u "$windows_temp_path")/tacbookings-measure-phase2.lock"
  lock_token="$(new_private_token)"
  if ! mkdir "$lock_dir" 2>/dev/null; then
    echo "another measurement operation is active, or stale lock requires review: $lock_dir" >&2
    exit 1
  fi
  lock_held=true
  snapshot="$(cygpath -am "$lock_dir/.env.measure.snapshot")"
  key_file="$(cygpath -am "$lock_dir/runtime-env-hmac.key")"
  audit_file="$(cygpath -am "$lock_dir/measure-env-snapshot-audit.json")"

  cleanup_private_env() {
    local status="${1:-$?}"
    trap - EXIT INT TERM
    if [[ "$lock_held" == true ]] && [[ -f "$lock_dir/owner.txt" ]] && grep -qx "token=$lock_token" "$lock_dir/owner.txt"; then
      rm -f -- "$lock_dir/.env.measure.snapshot" "$lock_dir/runtime-env-hmac.key" \
        "$lock_dir/measure-env-snapshot-audit.json" "$lock_dir/owner.txt"
      rmdir "$lock_dir" 2>/dev/null || true
    fi
    exit "$status"
  }
  trap cleanup_private_env EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  umask 077
  printf 'pid=%s\nstarted_at_utc=%s\ntoken=%s\n' "$$" "$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)" "$lock_token" > "$lock_dir/owner.txt"
  new_private_token > "$key_file"
  chmod 600 "$lock_dir/owner.txt" "$key_file"
  node measurement/phase2/bin/measure-env-contract.mjs \
    --snapshot-source "$(cygpath -am measurement/stack/.env.measure)" \
    --snapshot-out "$snapshot" --hmac-key-file "$key_file" --audit-out "$audit_file"
  snapshot_hmac="$(node -e 'const v=require(process.argv[1]);if(!/^[a-f0-9]{64}$/.test(v.snapshot_hmac_sha256))process.exit(2);process.stdout.write(v.snapshot_hmac_sha256)' "$audit_file")"
  chmod 600 "$lock_dir/owner.txt" "$snapshot" "$key_file" "$audit_file"

  MEASURE_ENV_SNAPSHOT="$snapshot" \
  MEASURE_ENV_SNAPSHOT_HMAC_SHA256="$snapshot_hmac" \
  PHASE2_ENV_AUDIT_HMAC_KEY_FILE="$key_file" \
    "$@" && command_status=0 || command_status=$?
  cleanup_private_env "$command_status"
}

if [[ "${1:-}" == with-private-env ]]; then
  shift
  with_private_env "$@"
  exit 0
fi

: "${MEASURE_ENV_SNAPSHOT:?MEASURE_ENV_SNAPSHOT must point to the private orchestrator snapshot}"
: "${MEASURE_ENV_SNAPSHOT_HMAC_SHA256:?MEASURE_ENV_SNAPSHOT_HMAC_SHA256 must bind the private snapshot}"
: "${PHASE2_ENV_AUDIT_HMAC_KEY_FILE:?PHASE2_ENV_AUDIT_HMAC_KEY_FILE must point to the private HMAC key}"
case "$MEASURE_ENV_SNAPSHOT" in /*|[A-Za-z]:/*) ;; *) echo "MEASURE_ENV_SNAPSHOT must be absolute" >&2; exit 1 ;; esac
ENV_FILE="$(cygpath -am "$MEASURE_ENV_SNAPSHOT")"
verify_env_snapshot() {
  node measurement/phase2/bin/measure-env-contract.mjs --verify-snapshot "$ENV_FILE" \
    --hmac-key-file "$PHASE2_ENV_AUDIT_HMAC_KEY_FILE" --expected-hmac "$MEASURE_ENV_SNAPSHOT_HMAC_SHA256"
}
verify_env_snapshot
PROJECT=tacbookings-measure

# Host-side view of the measure database, for migrate + seeds.
env_value() { node measurement/phase2/bin/measure-env-contract.mjs --get "$1" --env-file "$ENV_FILE"; }
DB_PASSWORD="$(env_value DB_PASSWORD)"
[ -n "$DB_PASSWORD" ] || { echo "private measurement DB password is empty" >&2; exit 1; }
DEFAULT_MEASURE_APP_IMAGE="$(env_value APP_IMAGE)"
export HOST_DATABASE_URL="postgresql://tac:${DB_PASSWORD}@localhost:5435/tacbookings"

compose() {
  verify_env_snapshot
  local image="${MEASURE_APP_IMAGE:-$DEFAULT_MEASURE_APP_IMAGE}"
  local clean_env=("PATH=$PATH") name
  # PROGRAMFILES is how the Windows Docker CLI locates C:\Program Files\Docker\
  # cli-plugins. Without it `docker compose` is not a known command at all and
  # the whole stack fails on its first call with "unknown flag: --env-file",
  # which reads like a Compose version problem rather than a missing variable.
  # The other spellings are carried for the same reason; every one of them is a
  # path, never a credential, so this does not widen what `env -i` is here to
  # keep out of Compose.
  for name in SystemRoot SYSTEMROOT COMSPEC PROGRAMFILES ProgramFiles ProgramW6432 ProgramData PROGRAMDATA DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_CERT_PATH DOCKER_TLS_VERIFY HOME USERPROFILE TEMP TMP; do
    [ -z "${!name:-}" ] || clean_env+=("$name=${!name}")
  done
  env -i "${clean_env[@]}" MEASURE_APP_IMAGE="$image" docker compose --env-file "$ENV_FILE" -p "$PROJECT" --project-directory "$ROOT" \
    -f docker-compose.yml -f measurement/stack/docker-compose.measure.yml "$@"
}

stop_application_writers() {
  echo "==> Stopping app + caddy before changing the measure database"
  compose stop app caddy >/dev/null
}

start_application_writers() {
  echo "==> Starting app + caddy (http://localhost:8027 via Caddy; app direct on :3003)"
  compose up -d --wait app caddy
}

prepare_database() {
  echo "==> Starting measure postgres (host port 5435)"
  compose up -d --wait postgres

  stop_application_writers

  echo "==> Resetting database schema"
  compose exec -T postgres psql -U tac -d tacbookings -v ON_ERROR_STOP=1 \
    -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"

  echo "==> Generating Prisma client"
  DATABASE_URL="$HOST_DATABASE_URL" npx prisma generate

  echo "==> Applying the full migration history"
  DATABASE_URL="$HOST_DATABASE_URL" npx prisma migrate deploy

  echo "==> Seeding demo data (the sanctioned representative dataset)"
  ALLOW_DEMO_SEED=1 DATABASE_URL="$HOST_DATABASE_URL" npx tsx prisma/demo-seed.ts

  echo "==> Seeding base data (SEED_THEME_COMPLETE=1 so the public site is open)"
  SEED_THEME_COMPLETE=1 \
  SEED_ADMIN_EMAIL="$(env_value SEED_ADMIN_EMAIL)" \
  SEED_ADMIN_PASSWORD="$(env_value SEED_ADMIN_PASSWORD)" \
  SEED_LODGE_PASSWORD="$(env_value SEED_LODGE_PASSWORD)" \
  DATABASE_URL="$HOST_DATABASE_URL" npx tsx --conditions=react-server prisma/seed.ts
}

require_absolute_file_path() {
  case "${1:-}" in
    /*|[A-Za-z]:/*) ;;
    *) echo "expected an absolute archive path, got: ${1:-<missing>}" >&2; exit 1 ;;
  esac
}

database_fingerprint() {
  # A canonical, complete logical fingerprint. The archive is restored before
  # each side; this detects any timing-side database mutation afterwards.
  #
  # The `\restrict`/`\unrestrict` pair is filtered for the same reason the
  # version and timestamp headers are: it is a psql meta-command wrapper that
  # carries no database content. PostgreSQL 16.14's pg_dump emits a fresh
  # RANDOM token in it on every invocation, so without this filter two dumps of
  # a completely unchanged database differ — measured here, and the token was
  # the ONLY difference across 14,122 lines. That made the fingerprint useless
  # as an equality control: the correctness runner's post-restore assertion,
  # every phase-2 before/after side comparison, and aggregation's single-common-
  # fingerprint requirement would each have failed on an untouched database, so
  # no pair could ever have completed.
  compose exec -T postgres pg_dump -U tac -d tacbookings \
    --schema=public --no-owner --no-privileges --inserts --column-inserts \
    | sed -E '/^-- Dumped (from|by) database version /d; /^-- Started on /d; /^-- Completed on /d; /^\\(un)?restrict [A-Za-z0-9]+$/d' \
    | sha256sum | awk '{print $1}'
}

provider_isolation_audit() {
  compose exec -T postgres psql -U tac -d tacbookings -v ON_ERROR_STOP=1 -tA <<'SQL'
WITH forbidden_credentials AS (
  SELECT count(*)::int AS count FROM "IntegrationCredential"
  WHERE lower(provider) = ANY (ARRAY['xero','stripe','google','backup','anthropic','anthropic-diagnostics'])
), module_rows AS (
  SELECT count(*)::int AS rows,
    count(*) FILTER (WHERE analytics OR "aiAssistant" OR "aiDiagnostics" OR "xeroIntegration" OR "googleLogin")::int AS unsafe
  FROM "ClubModuleSettings"
), analytics_rows AS (
  SELECT count(*)::int AS rows,
    count(*) FILTER (WHERE coalesce(trim("measurementId"), '') <> '')::int AS unsafe
  FROM "AnalyticsSettings"
)
SELECT json_build_object(
  'schema_version', 1,
  'forbidden_integration_credential_count', (SELECT count FROM forbidden_credentials),
  'xero_token_count', (SELECT count(*)::int FROM "XeroToken"),
  'club_module_settings_rows', (SELECT rows FROM module_rows),
  'unsafe_club_module_settings_rows', (SELECT unsafe FROM module_rows),
  'analytics_settings_rows', (SELECT rows FROM analytics_rows),
  'unsafe_analytics_settings_rows', (SELECT unsafe FROM analytics_rows)
)::text;
SQL
}

create_canonical_dump() (
  local archive="$1"
  local temp_archive
  require_absolute_file_path "$archive"
  [ ! -e "$archive" ] || { echo "refusing to overwrite canonical archive: $archive" >&2; exit 1; }
  mkdir -p "$(dirname "$archive")"
  temp_archive="$(mktemp "${archive}.tmp.XXXXXXXX")"
  cleanup_canonical_temp() { rm -f -- "$temp_archive"; }
  trap cleanup_canonical_temp EXIT
  # Deliberately NOT --schema=public. A schema-filtered dump omits
  # `CREATE EXTENSION`, so restoring it into a dropped-and-recreated schema
  # lost btree_gist and pgcrypto and then failed on the first exclusion
  # constraint that needs a GiST operator class. The archive has to be able to
  # rebuild the database on its own, because that is exactly what every timing
  # side and every correctness postcondition asks it to do.
  compose exec -T postgres pg_dump -U tac -d tacbookings \
    --format=custom --no-owner --no-privileges > "$temp_archive"
  [ -s "$temp_archive" ] || { echo "canonical archive is empty: $temp_archive" >&2; exit 1; }
  compose exec -T postgres pg_restore --list < "$temp_archive" > /dev/null
  # Same-directory hard-link publication is atomic and refuses a destination
  # created by a racing writer; unlinking the temporary name leaves one inode.
  node -e 'const fs=require("node:fs");fs.linkSync(process.argv[1],process.argv[2]);fs.unlinkSync(process.argv[1])' "$(cygpath -am "$temp_archive")" "$(cygpath -am "$archive")"
  sha256sum "$archive"
)

prepare_stack() (
  local archive="${1:-}"
  local preparation_complete=false
  cleanup_failed_preparation() {
    local status="$?"
    trap - EXIT INT TERM
    if [[ "$preparation_complete" != true ]]; then
      echo "measure stack preparation failed; leaving app + caddy stopped" >&2
      stop_application_writers >/dev/null 2>&1 || true
    fi
    exit "$status"
  }
  trap cleanup_failed_preparation EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  prepare_database
  if [[ -n "$archive" ]]; then
    create_canonical_dump "$archive"
  fi
  start_application_writers
  preparation_complete=true
  trap - EXIT INT TERM
  echo "==> Measure stack ready"
)

restore_canonical_dump() {
  local archive="$1"
  local expected_sha="$2"
  require_absolute_file_path "$archive"
  [ -f "$archive" ] || { echo "canonical archive is missing: $archive" >&2; exit 1; }
  [ "$(sha256sum "$archive" | awk '{print $1}')" = "$expected_sha" ] || {
    echo "canonical archive checksum mismatch" >&2; exit 1;
  }
  stop_application_writers
  compose up -d --wait postgres >/dev/null
  # The recreate is required, not incidental: a full-database `pg_dump` writes
  # "*not* creating schema, since initdb creates it" and never creates `public`
  # itself, so dropping without recreating leaves the very first
  # `COMMENT ON SCHEMA public` with nothing to comment on.
  compose exec -T postgres psql -U tac -d tacbookings -v ON_ERROR_STOP=1 \
    -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;" >/dev/null
  compose exec -T postgres pg_restore -U tac -d tacbookings \
    --exit-on-error --no-owner --no-privileges < "$archive"
  database_fingerprint
}

case "${1:-}" in
  prepare) prepare_stack ;;
  prepare-canonical-dump)
    shift
    [ -n "${1:-}" ] || { echo "usage: $0 prepare-canonical-dump <absolute-path>" >&2; exit 1; }
    prepare_stack "$1"
    ;;
  restore-canonical-dump)
    shift
    [ -n "${1:-}" ] && [ -n "${2:-}" ] || {
      echo "usage: $0 restore-canonical-dump <absolute-path> <sha256>" >&2; exit 1;
    }
    restore_canonical_dump "$1" "$2"
    ;;
  database-fingerprint) database_fingerprint ;;
  provider-isolation-audit) provider_isolation_audit ;;
  app-image)
    shift
    [ -n "${1:-}" ] || { echo "usage: $0 app-image <image:tag>" >&2; exit 1; }
    MEASURE_APP_IMAGE="$1" compose up -d --wait app
    ;;
  restart-app)
    compose restart app
    compose up -d --wait app
    ;;
  up) compose up -d --wait postgres mailpit app caddy ;;
  stop) compose stop ;;
  down) compose down ;;
  destroy) compose down -v ;;
  compose)
    shift
    compose "$@"
    ;;
  *)
    echo "Usage: $0 {with-private-env -- <command> [args...]|prepare|prepare-canonical-dump <path>|restore-canonical-dump <path> <sha256>|database-fingerprint|provider-isolation-audit|app-image <tag>|restart-app|up|stop|down|destroy|compose ...}" >&2
    exit 1
    ;;
esac
