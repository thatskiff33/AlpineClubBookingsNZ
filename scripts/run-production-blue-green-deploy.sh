#!/usr/bin/env bash
set -Eeuo pipefail

run_production_wrapper() {
DEFAULT_SOURCE_REPO="$HOME/AlpineClubBookingsNZ"
if [[ ! -d "$DEFAULT_SOURCE_REPO" && -d "$HOME/AlpineClubBookingsNZ" ]]; then
  DEFAULT_SOURCE_REPO="$HOME/AlpineClubBookingsNZ"
fi
SOURCE_REPO="${SOURCE_REPO:-$DEFAULT_SOURCE_REPO}"
DEPLOY_REF="${DEPLOY_REF:-origin/main}"
FETCH_LATEST="${FETCH_LATEST:-1}"
DEPLOY_WORKSPACE_ROOT="${DEPLOY_WORKSPACE_ROOT:-$HOME/tacbookings-deployments}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-$(basename "$SOURCE_REPO" | tr '[:upper:]' '[:lower:]')}"
SYNC_SOURCE_REPO_AFTER_DEPLOY="${SYNC_SOURCE_REPO_AFTER_DEPLOY:-1}"
PRUNE_STALE_DEPLOY_WORKSPACES="${PRUNE_STALE_DEPLOY_WORKSPACES:-1}"
GHCR_APP_IMAGE_REPOSITORY="${GHCR_APP_IMAGE_REPOSITORY:-ghcr.io/thatskiff33/alpineclubbookingsnz-app}"
GHCR_MIGRATE_IMAGE_REPOSITORY="${GHCR_MIGRATE_IMAGE_REPOSITORY:-ghcr.io/thatskiff33/alpineclubbookingsnz-migrate}"
APP_IMAGE="${APP_IMAGE:-}"
MIGRATE_IMAGE="${MIGRATE_IMAGE:-}"

ACTIVE_UPSTREAM_FILE_REL="deploy/caddy/tacbookings-active.caddy"
CADDY_CONFIG_CONTAINER_PATH="/etc/caddy/Caddyfile"
CADDY_DEPLOY_CONTAINER_PATH="/etc/caddy/deploy"
CADDY_CONFIG_VOLUME_SUFFIX="caddy_config"
CRON_SERVICE="app"
BLUE_SERVICE="app_blue"
GREEN_SERVICE="app_green"
CADDY_SERVICE="caddy"
READINESS_PATH="/api/health/ready"
WORKSPACE=""
RESOLVED_REF=""

step() {
  printf "\n[%s] %s\n" "$1" "$2"
}

info() {
  printf "  %s\n" "$1"
}

warn() {
  printf "  WARNING: %s\n" "$1"
}

fail() {
  trap - ERR
  printf "\nProduction blue/green wrapper failed.\n" >&2
  if [ -n "$WORKSPACE" ]; then
    printf "Workspace preserved at %s\n" "$WORKSPACE" >&2
  fi
}

trap fail ERR

require_command() {
  local command_name="$1"
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Missing required command: $command_name" >&2
    return 1
  }
}

env_flag_is_true() {
  case "$1" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

source_repo_is_clean() {
  [ -z "$(git -C "$SOURCE_REPO" status --short --untracked-files=normal)" ]
}

write_active_upstream_file() {
  local primary_service="$1"
  local fallback_service="${2:-}"
  local destination="$WORKSPACE/$ACTIVE_UPSTREAM_FILE_REL"
  local temp_file

  temp_file="$(mktemp "${destination}.XXXXXX")"
  {
    echo "reverse_proxy {"
    echo "  lb_policy first"
    echo "  lb_try_duration 10s"
    echo "  fail_duration 30s"
    echo "  health_uri ${READINESS_PATH}"
    echo "  health_interval 10s"
    echo "  health_timeout 5s"
    if [ -n "$fallback_service" ] && [ "$fallback_service" != "$primary_service" ]; then
      printf '  to %s:3000 %s:3000\n' "$primary_service" "$fallback_service"
    else
      printf '  to %s:3000\n' "$primary_service"
    fi
    echo "}"
  } >"$temp_file"
  mv "$temp_file" "$destination"
}

resolve_ref() {
  if env_flag_is_true "$FETCH_LATEST"; then
    info "Fetching latest origin/main in $SOURCE_REPO"
    git -C "$SOURCE_REPO" fetch --prune origin main
  fi

  RESOLVED_REF="$(git -C "$SOURCE_REPO" rev-parse "${DEPLOY_REF}^{commit}")"
  info "Resolved ${DEPLOY_REF} to commit ${RESOLVED_REF}"
}

resolve_image_refs() {
  if [ -z "$APP_IMAGE" ] && [ -z "$MIGRATE_IMAGE" ]; then
    APP_IMAGE="${GHCR_APP_IMAGE_REPOSITORY}:${RESOLVED_REF}"
    MIGRATE_IMAGE="${GHCR_MIGRATE_IMAGE_REPOSITORY}:${RESOLVED_REF}"
  elif [ -z "$APP_IMAGE" ] || [ -z "$MIGRATE_IMAGE" ]; then
    echo "APP_IMAGE and MIGRATE_IMAGE must both be set when overriding deployment images." >&2
    return 1
  fi

  info "App image: $APP_IMAGE"
  info "Migration image: $MIGRATE_IMAGE"
}

create_workspace() {
  mkdir -p "$DEPLOY_WORKSPACE_ROOT"
  WORKSPACE="$(mktemp -d "$DEPLOY_WORKSPACE_ROOT/${COMPOSE_PROJECT_NAME}-XXXXXX")"

  info "Creating clean deploy workspace at $WORKSPACE"
  git -C "$SOURCE_REPO" archive "$RESOLVED_REF" | tar -xf - -C "$WORKSPACE"

  cp "$SOURCE_REPO/.env" "$WORKSPACE/.env"
  chmod 600 "$WORKSPACE/.env"
}

validate_source_repo_state() {
  local branch

  branch="$(git -C "$SOURCE_REPO" rev-parse --abbrev-ref HEAD)"
  if [ "$branch" != "main" ]; then
    echo "Source repository must be on main before deploy. Current branch: $branch" >&2
    return 1
  fi

  if ! source_repo_is_clean; then
    echo "Source repository must be clean on main before deploy, including no untracked files." >&2
    return 1
  fi
}

get_service_container_id() {
  local service="$1"

  docker compose \
    --project-name "$COMPOSE_PROJECT_NAME" \
    -f "$SOURCE_REPO/docker-compose.yml" \
    ps -q "$service" 2>/dev/null || true
}

get_live_caddy_deploy_mount_source() {
  local caddy_cid
  local mount_source

  caddy_cid="$(get_service_container_id "$CADDY_SERVICE")"
  if [ -z "$caddy_cid" ]; then
    return 1
  fi

  mount_source="$(
    docker inspect "$caddy_cid" \
      --format "{{range .Mounts}}{{if eq .Destination \"$CADDY_DEPLOY_CONTAINER_PATH\"}}{{println .Source}}{{end}}{{end}}"
  )"
  mount_source="${mount_source%$'\n'}"
  if [ -z "$mount_source" ]; then
    return 1
  fi

  printf '%s' "$mount_source"
}

seed_active_upstream_from_live_bind_mount() {
  local mount_source
  local source_file
  local destination

  if ! mount_source="$(get_live_caddy_deploy_mount_source)"; then
    return 1
  fi
  source_file="${mount_source}/${ACTIVE_UPSTREAM_FILE_REL##*/}"
  destination="$WORKSPACE/$ACTIVE_UPSTREAM_FILE_REL"

  if [ -f "$source_file" ]; then
    cp "$source_file" "$destination"
    info "Copied live active upstream file from $source_file"
    return 0
  fi

  return 1
}

infer_active_service_from_caddy_autosave() {
  local volume_name="${COMPOSE_PROJECT_NAME}_${CADDY_CONFIG_VOLUME_SUFFIX}"
  local active_service

  docker volume inspect "$volume_name" >/dev/null 2>&1 || return 1

  active_service="$(
    docker run --rm \
      -v "${volume_name}:/config:ro" \
      caddy:2-alpine \
      sh -lc "if [ -f /config/caddy/autosave.json ]; then grep -oE 'app(_(blue|green))?:3000' /config/caddy/autosave.json | head -n1 | cut -d: -f1; fi" \
      2>/dev/null || true
  )"
  active_service="${active_service%$'\n'}"

  case "$active_service" in
    "$CRON_SERVICE"|"$BLUE_SERVICE"|"$GREEN_SERVICE")
      printf '%s' "$active_service"
      return 0
      ;;
  esac

  return 1
}

infer_active_service_from_running_colors() {
  local blue_cid
  local green_cid
  local blue_running=0
  local green_running=0

  blue_cid="$(get_service_container_id "$BLUE_SERVICE")"
  green_cid="$(get_service_container_id "$GREEN_SERVICE")"

  if [ -n "$blue_cid" ] && [ "$(docker inspect -f '{{.State.Status}}' "$blue_cid")" = "running" ]; then
    blue_running=1
  fi

  if [ -n "$green_cid" ] && [ "$(docker inspect -f '{{.State.Status}}' "$green_cid")" = "running" ]; then
    green_running=1
  fi

  if [ "$blue_running" = "1" ] && [ "$green_running" = "0" ]; then
    printf '%s' "$BLUE_SERVICE"
    return 0
  fi

  if [ "$green_running" = "1" ] && [ "$blue_running" = "0" ]; then
    printf '%s' "$GREEN_SERVICE"
    return 0
  fi

  return 1
}

seed_active_upstream_file() {
  local active_service

  if seed_active_upstream_from_live_bind_mount; then
    return 0
  fi

  if active_service="$(infer_active_service_from_caddy_autosave)"; then
    if [ "$active_service" = "$CRON_SERVICE" ]; then
      write_active_upstream_file "$CRON_SERVICE"
    else
      write_active_upstream_file "$active_service" "$CRON_SERVICE"
    fi
    info "Reconstructed active upstream file from Caddy autosave state: $active_service"
    return 0
  fi

  if active_service="$(infer_active_service_from_running_colors)"; then
    write_active_upstream_file "$active_service" "$CRON_SERVICE"
    info "Reconstructed active upstream file from running color services: $active_service"
    return 0
  fi

  warn "Unable to infer the live upstream state. Keeping the archived default active upstream file."
}

run_deploy() {
  info "Running low-level blue/green deploy from $WORKSPACE"
  (
    cd "$WORKSPACE"
    PROJECT_DIR="$WORKSPACE" \
    COMPOSE_PROJECT_NAME="$COMPOSE_PROJECT_NAME" \
    APP_IMAGE="$APP_IMAGE" \
    MIGRATE_IMAGE="$MIGRATE_IMAGE" \
    ./scripts/run-production-blue-green-deploy.sh --internal-blue-green-deploy
  )
}

sync_source_repo_to_deployed_commit() {
  local current_ref

  if ! env_flag_is_true "$SYNC_SOURCE_REPO_AFTER_DEPLOY"; then
    info "Skipping source repository sync because SYNC_SOURCE_REPO_AFTER_DEPLOY=${SYNC_SOURCE_REPO_AFTER_DEPLOY}."
    return 0
  fi

  validate_source_repo_state
  current_ref="$(git -C "$SOURCE_REPO" rev-parse HEAD)"
  if [ "$current_ref" = "$RESOLVED_REF" ]; then
    info "Source repository is already at the deployed commit."
    return 0
  fi

  git -C "$SOURCE_REPO" fetch --prune origin main
  git -C "$SOURCE_REPO" merge --ff-only "$RESOLVED_REF"
  info "Updated $SOURCE_REPO to deployed commit ${RESOLVED_REF}."
}

prune_stale_deploy_workspaces() {
  local live_mount_source=""
  local live_workspace=""
  local candidate
  local removed_any=0

  if ! env_flag_is_true "$PRUNE_STALE_DEPLOY_WORKSPACES"; then
    info "Skipping deploy workspace cleanup because PRUNE_STALE_DEPLOY_WORKSPACES=${PRUNE_STALE_DEPLOY_WORKSPACES}."
    return 0
  fi

  if [ ! -d "$DEPLOY_WORKSPACE_ROOT" ]; then
    return 0
  fi

  if ! live_mount_source="$(get_live_caddy_deploy_mount_source)"; then
    warn "Unable to identify the live deploy workspace from Caddy. Preserving existing deploy workspaces."
    return 0
  fi
  live_workspace="$(dirname "$(dirname "$live_mount_source")")"

  while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    if [ "$candidate" = "$live_workspace" ] || [ "$candidate" = "$WORKSPACE" ]; then
      continue
    fi

    rm -rf "$candidate"
    info "Removed stale deploy workspace: $candidate"
    removed_any=1
  done < <(find "$DEPLOY_WORKSPACE_ROOT" -maxdepth 1 -mindepth 1 -type d -name "${COMPOSE_PROJECT_NAME}-*")

  if [ "$removed_any" = "0" ]; then
    info "No stale deploy workspaces to remove."
  fi
}

echo "====================================================="
echo "  AlpineClubBookingsNZ: Production Blue/Green Deploy Wrapper"
echo "====================================================="

step "1/8" "Validating host prerequisites"
require_command git
require_command docker
require_command tar
require_command mktemp
require_command cp
require_command chmod
require_command mkdir
require_command basename
require_command dirname
require_command find
require_command rm
info "Required host commands are available."

step "2/8" "Validating source repository"
[ -d "$SOURCE_REPO" ] || {
  echo "Source repository not found: $SOURCE_REPO" >&2
  exit 1
}
git -C "$SOURCE_REPO" rev-parse --is-inside-work-tree >/dev/null
[ -f "$SOURCE_REPO/.env" ] || {
  echo "Source repository is missing .env: $SOURCE_REPO/.env" >&2
  exit 1
}
[ -f "$SOURCE_REPO/docker-compose.yml" ] || {
  echo "Source repository is missing docker-compose.yml" >&2
  exit 1
}
validate_source_repo_state
info "Source repository contract looks valid."

step "3/8" "Resolving deploy commit and image references"
resolve_ref
resolve_image_refs

step "4/8" "Creating deployment workspace"
create_workspace

step "5/8" "Preserving live Caddy upstream state"
seed_active_upstream_file

step "6/8" "Executing blue/green deploy"
run_deploy

step "7/8" "Syncing source repository to the deployed commit"
sync_source_repo_to_deployed_commit

step "8/8" "Cleaning stale deploy workspaces"
prune_stale_deploy_workspaces

echo
echo "Deploy workspace: $WORKSPACE"
echo "This workspace remains in place because the live Caddy container bind-mounts it."
}

run_internal_blue_green_deploy() {
DEFAULT_PROJECT_DIR="$HOME/AlpineClubBookingsNZ"
if [[ ! -d "$DEFAULT_PROJECT_DIR" && -d "$HOME/AlpineClubBookingsNZ" ]]; then
  DEFAULT_PROJECT_DIR="$HOME/AlpineClubBookingsNZ"
fi
PROJECT_DIR="${PROJECT_DIR:-$DEFAULT_PROJECT_DIR}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-180}"
PRUNE_UNTIL="${PRUNE_UNTIL:-12h}"
FORCE_NO_CACHE="${FORCE_NO_CACHE:-0}"
SKIP_APP_IMAGE_BUILD="${SKIP_APP_IMAGE_BUILD:-0}"
APP_IMAGE="${APP_IMAGE:-}"
MIGRATE_IMAGE="${MIGRATE_IMAGE:-}"
BLUE_GREEN_DRAIN_SECONDS="${BLUE_GREEN_DRAIN_SECONDS:-30}"
ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS="${ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS:-0}"
BLUE_GREEN_MIGRATION_OVERRIDE_REASON="${BLUE_GREEN_MIGRATION_OVERRIDE_REASON:-}"
BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED="${BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED:-0}"
MIGRATION_SAFETY_LEDGER="${MIGRATION_SAFETY_LEDGER:-docs/BLUE_GREEN_MIGRATION_SAFETY.tsv}"

# Pre-cutover warm-up gate (#2566). The defaults are the owner's: bounded
# concurrency of three, and a tolerance of at most ONE failed non-critical CMS page
# AND at most 10% of those discovered — both conditions, so a club with fewer than
# ten published pages tolerates none. Widening either is allowed and logged; it is
# never silent. DEPLOY_WARMUP_SERVICES defaults to the target colour plus the cron
# leader (see `warmup_services`).
DEPLOY_WARMUP_ENABLED="${DEPLOY_WARMUP_ENABLED:-1}"
DEPLOY_WARMUP_OVERRIDE_REASON="${DEPLOY_WARMUP_OVERRIDE_REASON:-}"
DEPLOY_WARMUP_SERVICES="${DEPLOY_WARMUP_SERVICES:-}"
DEPLOY_WARMUP_CONCURRENCY="${DEPLOY_WARMUP_CONCURRENCY:-3}"
DEPLOY_WARMUP_REQUEST_TIMEOUT_SECONDS="${DEPLOY_WARMUP_REQUEST_TIMEOUT_SECONDS:-20}"
DEPLOY_WARMUP_TOTAL_TIMEOUT_SECONDS="${DEPLOY_WARMUP_TOTAL_TIMEOUT_SECONDS:-240}"
DEPLOY_WARMUP_MAX_FAILED_CMS_ROUTES="${DEPLOY_WARMUP_MAX_FAILED_CMS_ROUTES:-1}"
DEPLOY_WARMUP_MAX_FAILED_CMS_PERCENT="${DEPLOY_WARMUP_MAX_FAILED_CMS_PERCENT:-10}"
DEPLOY_WARMUP_PATH="/api/deploy/warmup"
DEPLOY_WARMUP_VERDICT_SENTINEL="WARMUP-GATE-VERDICT"

POSTGRES_SERVICE="postgres"
CRON_SERVICE="app"
CADDY_SERVICE="caddy"
MIGRATE_SERVICE="migrate"
BLUE_SERVICE="app_blue"
GREEN_SERVICE="app_green"
ACTIVE_UPSTREAM_FILE_REL="deploy/caddy/tacbookings-active.caddy"
READINESS_PATH="/api/health/ready"
DEPLOY_RUNTIME_STATUS_PATH="/api/deploy/runtime-status"
# What every container running app code must SAY IT PARSED out of
# APP_ENVIRONMENT_ROLE (ENV-SAFETY 1 #3034, epic #2986; INV-CONFIG-003).
#
# THE DECLARATION KIND AND NOT THE EFFECTIVE ROLE, and the difference is the
# reason this is safe to assert at all: a correctly declared production
# installation whose administrator has switched the safer override on legitimately
# RESOLVES non-production, so asserting the resolved role would refuse a
# legitimate release. The declaration is the half a deployment owns.
#
# It is asserted from the CONTAINER's own self-report rather than from .env,
# because those are different questions. The step-3 preflight validates the FILE;
# the containers receive whatever Compose RESOLVED, and Compose prefers a value
# exported in the invoking shell over the env file and takes the LAST duplicate
# line rather than the first. The preflight refuses those shapes it can see, but a
# gate that is only right while it models Compose's precedence and dotenv grammar
# correctly is one Compose release away from being wrong — so the value is re-read
# from the process that actually got it, at step 14, with the old colour still
# serving and nothing switched.
#
# And it is read by ASKING THE APPLICATION (/api/deploy/runtime-status), not by
# parsing the container's environment in shell. A second parser is a second thing
# to drift; see get_service_runtime_payload for the review that measured exactly
# that.
EXPECTED_ENVIRONMENT_ROLE_DECLARATION="production"

SHADOW_DATABASE_NAME="tacbookings_shadow_validate_$$"
SHADOW_DATABASE_CREATED=0
ACTIVE_SERVICE=""
TARGET_SERVICE=""
SWITCHED_TRAFFIC=0
EXTERNAL_HEALTH_VERIFIED=0

step() {
  printf "\n[%s] %s\n" "$1" "$2"
}

info() {
  printf "  %s\n" "$1"
}

warn() {
  printf "  WARNING: %s\n" "$1"
}

print_failure_context() {
  if [ -d "$PROJECT_DIR" ]; then
    cd "$PROJECT_DIR" || return 0
    docker compose ps || true
    echo
    if [ -n "$TARGET_SERVICE" ]; then
      docker compose logs "$TARGET_SERVICE" --tail 120 || true
      echo
    fi
    docker compose logs "$CRON_SERVICE" --tail 120 || true
    echo
    docker compose logs "$CADDY_SERVICE" --tail 60 || true
    echo
    docker compose logs "$POSTGRES_SERVICE" --tail 60 || true
  fi
}

rollback_traffic_if_needed() {
  if [ "$SWITCHED_TRAFFIC" != "1" ] || [ "$EXTERNAL_HEALTH_VERIFIED" = "1" ] || [ -z "$ACTIVE_SERVICE" ]; then
    return 0
  fi

  if [ ! -f "$PROJECT_DIR/$ACTIVE_UPSTREAM_FILE_REL" ]; then
    return 0
  fi

  cd "$PROJECT_DIR" || return 0
  warn "Restoring Caddy upstream to ${ACTIVE_SERVICE} after deployment failure."
  write_active_upstream_file "$ACTIVE_SERVICE" "$CRON_SERVICE"
  reload_caddy >/dev/null 2>&1 || true
}

fail() {
  trap - ERR
  rollback_traffic_if_needed
  printf "\nBlue/green deployment failed.\n" >&2
  print_failure_context
}

drop_shadow_database() {
  if [ "$SHADOW_DATABASE_CREATED" != "1" ] || [ ! -d "$PROJECT_DIR" ]; then
    return 0
  fi

  cd "$PROJECT_DIR" || return 0
  if [ -n "$(docker compose ps -q "$POSTGRES_SERVICE" 2>/dev/null || true)" ]; then
    docker compose exec -T "$POSTGRES_SERVICE" \
      psql -U tac -d postgres -v ON_ERROR_STOP=1 \
      -c "DROP DATABASE IF EXISTS ${SHADOW_DATABASE_NAME};" >/dev/null 2>&1 || true
  fi

  SHADOW_DATABASE_CREATED=0
}

trap fail ERR
trap drop_shadow_database EXIT

trim_whitespace() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

# Every shape Docker Compose accepts as an assignment of this key, as one
# extended regular expression.
#
# THE SHAPE WAS THE FINDING. The first version counted with `awk -F=` and
# `$1 == key`, which needs the key to be the WHOLE first `=`-field — so three
# shapes Compose honours slipped past it, measured against real
# `docker compose v5.3.1`: an INDENTED line, an `export `-prefixed line, and
# spaces around the `=`. Any of those appearing a SECOND time further down a .env
# whose first line is correct passed the duplicate check and handed every
# container `non-production`. Appending to a .env by hand, or from a rehearsal
# script, produces exactly those shapes.
#
# Deliberately scoped to THIS key rather than by changing `get_env_file_value`,
# which every other `require_*_env_key` shares and which is not this issue to
# change. A comment line cannot match: a `#` before the key fails the anchor.
environment_role_env_pattern() {
  printf '^[[:space:]]*(export[[:space:]]+)?%s[[:space:]]*=' "$1"
}

# How many lines in .env assign this key.
#
# `grep -c` prints 0 and EXITS 1 when nothing matches, which under `set -e` would
# abort inside the assignment, so the status is discarded and the count kept.
count_environment_role_env_assignments() {
  local key="$1"

  grep -cE "$(environment_role_env_pattern "$key")" .env || true
}

# The value Compose would resolve for this key.
#
# LAST-WINS, matching Compose dotenv parsing rather than the first-match reader
# used for every other key. A duplicate is refused before this matters, but if
# that refusal is ever relaxed this reader agrees with the containers instead of
# disagreeing with them, which is the safer default of the two.
#
# It then undoes what Compose undoes: an `export ` prefix, whitespace around the
# `=`, an inline comment (the same `[[:space:]]+#` rule `get_env_file_value`
# applies for every other key), and ONE layer of matching surrounding quotes.
# Those last three are why `APP_ENVIRONMENT_ROLE = production`,
# `export APP_ENVIRONMENT_ROLE=production` and `APP_ENVIRONMENT_ROLE="production"`
# no longer abort a deploy Compose would have resolved to `production` — and in
# particular why the first two are no longer reported as a MISSING entry for a key
# plainly present in the file, which is what gets an operator editing the wrong
# line under deploy pressure.
#
# One place it stays narrower than Compose: a `#` INSIDE a quoted value is treated
# as an inline comment and truncated. That can only shorten a value, so it can only
# turn an accepted value into a refused one — never the reverse — and the refusal
# names the sanitized value it read.
environment_role_env_value() {
  local key="$1"
  local value
  local first
  local last

  value="$(
    sed -nE "s/$(environment_role_env_pattern "$key")[[:space:]]*(.*)$/\2/p" .env |
      tail -n 1
  )"
  value="$(printf '%s' "$value" | sed -E 's/[[:space:]]+#.*$//')"
  value="$(trim_whitespace "$value")"

  # One layer of matching surrounding quotes, compared character by character
  # rather than by a `case` pattern, because a pattern holding both quote
  # characters inside a single-quoted shell word is unreadable and easy to get
  # subtly wrong.
  if [ "${#value}" -ge 2 ]; then
    first="${value%"${value#?}"}"
    last="${value#"${value%?}"}"
    if [ "$first" = "$last" ] && { [ "$first" = '"' ] || [ "$first" = "'" ]; }; then
      value="${value#?}"
      value="${value%?}"
    fi
  fi

  printf '%s' "$value"
}


# A deployment-supplied value made safe to echo at an operator's terminal.
#
# The application deliberately reduces this same string to printable ASCII before
# it reaches a log line or a page (`sanitizeEnvironmentRoleRawValue` in
# src/lib/environment-role-declaration.ts), for the plain reason that a value
# holding a newline or an escape sequence must not be able to write a second line
# into — or repaint — the terminal of the person reading the refusal. A shell that
# echoed the raw value would be the hole that module closes, reopened one layer
# out. Control characters become `?` rather than being deleted, so the operator
# can SEE that something is in there; the cap matches the app's 64 characters
# including the `...` marker, so the whole result is printable ASCII.
printable_deploy_value() {
  local sanitized

  sanitized="$(printf '%s' "$1" | tr -c ' -~' '?')"
  if [ "${#sanitized}" -gt 64 ]; then
    printf '%s...' "${sanitized:0:61}"
  else
    printf '%s' "$sanitized"
  fi
}

get_env_file_value() {
  local key="$1"

  awk -F= -v key="$key" '
    /^[[:space:]]*#/ { next }
    $1 == key {
      value = substr($0, index($0, "=") + 1)
      sub(/[[:space:]]+#.*$/, "", value)
      print value
      exit
    }
  ' .env
}

require_command() {
  local command_name="$1"
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Missing required command: $command_name" >&2
    return 1
  }
}

require_env_key() {
  local key="$1"
  local value

  value="$(trim_whitespace "$(get_env_file_value "$key")")"
  if [ -z "$value" ]; then
    echo "Missing required .env entry: $key" >&2
    return 1
  fi
}

require_one_of_env_keys() {
  local label="$1"
  shift

  local key
  local value
  for key in "$@"; do
    value="$(trim_whitespace "$(get_env_file_value "$key")")"
    if [ -n "$value" ]; then
      return 0
    fi
  done

  echo "Missing required .env entry: $label" >&2
  return 1
}

require_non_placeholder_env_key() {
  local key="$1"
  local value

  require_env_key "$key"
  value="$(trim_whitespace "$(get_env_file_value "$key")")"

  if printf '%s' "$value" | grep -Eqi '(^<.*>$|placeholder|changeme|example\.com)'; then
    echo ".env entry appears to be a placeholder and must be replaced: $key" >&2
    return 1
  fi
}

# NOTE: require_boolean_env_key / require_positive_integer_env_key /
# env_key_is_true were removed with the BACKUP_ENABLED / BACKUP_RETENTION_DAYS
# preflight (#2095) — backup config is DB-backed now and no other .env key needs
# them. Reintroduce them if a future boolean/integer .env key appears.

warn_legacy_xero_env() {
  # Xero credentials moved to encrypted, DB-backed storage (#2079). The legacy
  # XERO_* env vars are ignored by the app now; warn (never fail) so operators
  # know to remove them from .env after re-entering credentials in-app.
  local key
  local value
  for key in XERO_CLIENT_ID XERO_CLIENT_SECRET XERO_REDIRECT_URI XERO_ENCRYPTION_KEY XERO_WEBHOOK_KEY; do
    value="$(trim_whitespace "$(get_env_file_value "$key")")"
    if [ -n "$value" ]; then
      warn "Legacy $key is set but no longer used — Xero credentials are configured in-app now (#2079). Remove it from .env."
    fi
  done
}

warn_legacy_stripe_env() {
  # Stripe credentials moved to encrypted, DB-backed storage (#2082). The legacy
  # STRIPE_* env vars (including the NEXT_PUBLIC_ publishable key, now delivered
  # at runtime from the store) are ignored by the app now; warn (never fail) so
  # operators know to remove them after re-entering credentials in-app.
  local key
  local value
  for key in STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY; do
    value="$(trim_whitespace "$(get_env_file_value "$key")")"
    if [ -n "$value" ]; then
      warn "Legacy $key is set but no longer used — Stripe credentials are configured in-app now (#2082). Remove it from .env."
    fi
  done
}

warn_legacy_backup_env() {
  # Backup configuration moved to encrypted, DB-backed storage (#2095). The
  # legacy BACKUP_ENABLED / BACKUP_S3_* / BACKUP_RETENTION_DAYS /
  # BACKUP_RESTORE_VALIDATION_URL env vars are ignored by the app now; warn
  # (never fail) so operators know to remove them after migrating config in-app
  # at Admin → Backups. BACKUP_CRON_SCHEDULE is deliberately NOT listed — it is
  # cron-leader timing and legitimately stays in the environment.
  local key
  local value
  for key in BACKUP_ENABLED BACKUP_S3_BUCKET BACKUP_S3_REGION BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY BACKUP_RETENTION_DAYS BACKUP_RESTORE_VALIDATION_URL; do
    value="$(trim_whitespace "$(get_env_file_value "$key")")"
    if [ -n "$value" ]; then
      warn "Legacy $key is set but no longer used — backup configuration is managed in-app now (#2095). Remove it from .env."
    fi
  done
}

working_tree_is_clean() {
  [ -z "$(git status --short --untracked-files=normal)" ]
}

extract_url_host() {
  local url="$1"
  printf '%s' "$url" | sed -E 's#^[A-Za-z][A-Za-z0-9+.-]*://([^/:?#]+).*$#\1#'
}

require_http_url_env_key() {
  local key="$1"
  local value

  require_non_placeholder_env_key "$key"
  value="$(trim_whitespace "$(get_env_file_value "$key")")"

  if ! printf '%s' "$value" | grep -Eq '^https?://[^[:space:]]+$'; then
    echo ".env entry must be a valid http(s) URL: $key" >&2
    return 1
  fi
}

# The deployment's declaration of what this installation IS (ENV-SAFETY 1, #3034;
# epic #2986; INV-CONFIG-003).
#
# THIS SCRIPT DEPLOYS THE CLUB'S LIVE SITE AND NOTHING ELSE, so it requires
# exactly `production`. That is narrower than the application parser, which
# accepts `production` OR `non-production`, and the difference is the whole point.
# There is no staging mode here, no `--env` switch and no alternate path: a
# non-production stack goes through `docker-compose.staging.yml` and
# `scripts/e2e-stack.sh`, which declare `non-production` themselves. A script
# whose only job is the live site accepting a declaration that says "this is a
# copy" would be accepting the one value it can prove is wrong.
#
# THAT IS NOT A THEORETICAL HOLE, it is the likeliest operator error. `.env.example`
# ships `APP_ENVIRONMENT_ROLE=non-production` — correct there, because it is a
# local-development template and a template that shipped `production` would have a
# developer's laptop declaring itself live. But `.env.example` is ALSO the file an
# operator diffs against their real `.env` when upgrading, and "a new key appeared
# in the template, copy it across" is the normal upgrade move. Following that
# through: the deploy passes, the migration runs, the new colour boots and resolves
# NON_PRODUCTION, and then every confirmation, payment notice, waitlist offer and
# renewal reminder for the club's REAL members is safety-suppressed — and every
# application-managed contact on the club's REAL Xero organisation has its email
# address rewritten to a non-deliverable one (INV-CONFIG-005). Destructive edits to
# live accounting, made confidently, by the very mechanism this epic added to keep
# members safe.
#
# So the safe-looking value is the unsafe outcome HERE, and only here. The correct
# pairing is `non-production` in the template (safe by default on a laptop) and
# `production` required at the one place that knows it is deploying production.
#
# WHY IT IS A HARD REFUSAL AND WHY IT RUNS IN THE PREFLIGHT. From this release on,
# an installation that has not declared itself resolves UNKNOWN, and UNKNOWN fails
# closed: nothing whose safety depends on knowing whether these are the club's real
# members goes out. An existing production install upgrading into this release has
# no declaration, so without this check the upgrade would succeed and then quietly
# stop sending mail — the outcome epic #2986 explicitly forbids shipping. Refusing
# at step 3 of 20 means the old colour is still serving, the migration has not run
# (step 13) and nothing has been switched (step 17): the operator fixes one line in
# .env and re-runs. `deploy-environment-role-contract.test.ts` pins that ORDER, not
# merely this function's existence, because moving the check after step 13 or step
# 14 brings the forbidden outcome straight back.
#
# The comparison is case-folded after trimming, exactly as
# `src/lib/environment-role-declaration.ts` folds it, so the deploy gate and the
# application cannot disagree about what counts as declared. A near miss is
# refused rather than guessed at: `prod`, `staging`, `true` and APP_RUNTIME_ROLE's
# own values are all rejected, because guessing is how a typo becomes "production".
require_environment_role_env_key() {
  local key="APP_ENVIRONMENT_ROLE"
  local value
  local normalised
  local occurrences
  local exported_normalised

  # NOT `require_env_key` and NOT `get_env_file_value`, which is the fix for a
  # second review finding rather than a refactor. Those read the first line whose
  # whole first `=`-field is the key, so an indented or `export `-prefixed entry
  # was reported as a MISSING .env entry for a key plainly present in the file —
  # and a quoted value was refused as unrecognised — while Compose resolved all
  # three to `production`. All three were fail-closed, but "missing" for a visible
  # key is what gets an operator editing the wrong line under deploy pressure.
  occurrences="$(count_environment_role_env_assignments "$key")"
  if [ "$occurrences" -eq 0 ]; then
    echo "Missing required .env entry: $key" >&2
    echo "It declares whether this installation is the club's live site or a copy," >&2
    echo "and nothing infers it: an undeclared installation resolves UNKNOWN and" >&2
    echo "holds back member email and Xero writes until it is declared." >&2
    echo "Add APP_ENVIRONMENT_ROLE=production to this deployment's .env, then re-run." >&2
    echo "See docs/guides/environment-role.md." >&2
    echo "This is NOT APP_RUNTIME_ROLE, which names the container slot (web-blue, cron-leader)." >&2
    return 1
  fi

  # A DUPLICATED KEY IS REFUSED, because Compose and any first-match reader would
  # take different lines: Compose's dotenv parsing is LAST-WINS. A duplicate is
  # always an operator mistake, so it is refused outright rather than silently
  # resolved in either direction — taking last-wins here would agree with Compose
  # but would also quietly bless a file that says two different things about the
  # most consequential setting in it. The count above sees every shape Compose
  # accepts, including the indented and `export `-prefixed ones a `-F=` field
  # comparison missed.
  if [ "$occurrences" -gt 1 ]; then
    echo ".env entry $key appears $occurrences times. Leave exactly one." >&2
    echo "Docker Compose resolves the LAST one, so a file that says production" >&2
    echo "on one line and non-production on another hands every container the" >&2
    echo "value — which is how a live site would come up believing it is a copy." >&2
    return 1
  fi

  value="$(environment_role_env_value "$key")"
  if [ -z "$value" ]; then
    echo ".env entry $key is present but empty, so Compose would hand the" >&2
    echo "containers an empty value and the app would resolve UNKNOWN." >&2
    echo "Set APP_ENVIRONMENT_ROLE=production in this deployment's .env, then re-run." >&2
    return 1
  fi
  normalised="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"

  # A SHELL-EXPORTED VALUE BEATS THE FILE IN COMPOSE'S OWN PRECEDENCE, so a stale
  # `export APP_ENVIRONMENT_ROLE=non-production` left in the invoking shell, a
  # systemd unit or a restore-rehearsal script would override a correct .env and
  # this gate would never see it. That is not hypothetical for this script: it
  # already exports GIT_COMMIT_SHA / KNOWLEDGE_BUNDLE_OBSERVED_AT / RELEASE_ID
  # for compose to forward, and it does not sanitise the caller's environment.
  #
  # Compared case-folded and trimmed, the same fold the file value gets, so a
  # harmless `PRODUCTION` in the shell is not reported as a disagreement. Both
  # values are named in the refusal, because "they disagree" without saying which
  # said what is not something an operator can act on.
  if [ -n "${APP_ENVIRONMENT_ROLE+x}" ]; then
    exported_normalised="$(
      printf '%s' "$(trim_whitespace "${APP_ENVIRONMENT_ROLE:-}")" |
        tr '[:upper:]' '[:lower:]'
    )"
    if [ "$exported_normalised" != "$normalised" ]; then
      echo "$key disagrees between this shell and .env, and Docker Compose would" >&2
      echo "take the SHELL value. Refusing rather than deploying the one you did" >&2
      echo "not edit." >&2
      echo "  exported in this shell: $(printable_deploy_value "${APP_ENVIRONMENT_ROLE:-}")" >&2
      echo "  in .env:                $(printable_deploy_value "$value")" >&2
      echo "Run 'unset $key' in this shell (and remove it from whatever exported" >&2
      echo "it — a systemd unit, a wrapper script, a restore rehearsal), then" >&2
      echo "re-run so the .env is the only source." >&2
      return 1
    fi
  fi

  if [ "$normalised" != "production" ]; then
    echo ".env entry $key must be exactly production for this script (got: $(printable_deploy_value "$value"))" >&2
    echo "This script deploys the club's LIVE site. There is no staging mode here." >&2
    if [ "$normalised" = "non-production" ]; then
      echo "The value says this installation is a COPY. Deploying it would suppress" >&2
      echo "real members' email and, once Xero containment lands, rewrite the email" >&2
      echo "addresses on the club's real accounting contacts. Refusing." >&2
      echo "If you copied this line from .env.example, that template is for a local" >&2
      echo "checkout: production deployments set production here." >&2
    else
      echo "It declares whether this installation is the club's live site or a copy," >&2
      echo "and nothing infers it: an undeclared installation resolves UNKNOWN and" >&2
      echo "holds back member email and Xero writes until it is declared." >&2
    fi
    echo "Set APP_ENVIRONMENT_ROLE=production in this deployment's .env, then re-run." >&2
    echo "Non-production stacks use docker-compose.staging.yml, which declares" >&2
    echo "non-production itself. See docs/guides/environment-role.md." >&2
    echo "This is NOT APP_RUNTIME_ROLE, which names the container slot (web-blue, cron-leader)." >&2
    return 1
  fi

  # Belt and braces now that the two agree: drop the variable from this shell so
  # the .env is the ONLY source Compose can read it from. Nothing else in this
  # script reads it, and the value is re-verified from each container's own
  # self-report at step 14 (`assert_runtime_identity`), before the cutover.
  unset APP_ENVIRONMENT_ROLE
}

require_domain_matches_url() {
  local key="$1"
  local domain="$2"
  local value
  local host

  value="$(trim_whitespace "$(get_env_file_value "$key")")"
  host="$(extract_url_host "$value")"

  if [ "$host" != "$domain" ] && [ "$host" != "www.$domain" ] && [ "www.$host" != "$domain" ]; then
    echo "$key host must match DOMAIN. Expected $domain or www.$domain, got $host" >&2
    return 1
  fi
}

require_safe_database_password() {
  local value

  value="$(trim_whitespace "$(get_env_file_value DB_PASSWORD)")"
  if printf '%s' "$value" | grep -Eq '[@/:?#[:space:]]'; then
    echo "DB_PASSWORD contains URL-unsafe characters for the DATABASE_URL values in docker-compose.yml" >&2
    echo "Use a password without @ / : ? # or whitespace, or update the compose URLs to URL-encode it." >&2
    return 1
  fi
}

validate_host_contract() {
  require_command docker
  require_command curl
  require_command awk
  require_command sed
  require_command grep
  require_command find
  require_command mktemp

  docker compose version >/dev/null
  docker buildx version >/dev/null
}

validate_env_contract() {
  local domain

  if [ ! -f .env ]; then
    echo "Deployment requires a .env file in $PROJECT_DIR" >&2
    return 1
  fi

  require_non_placeholder_env_key DB_PASSWORD
  require_safe_database_password
  require_non_placeholder_env_key DOMAIN
  require_http_url_env_key NEXTAUTH_URL
  require_one_of_env_keys "AUTH_SECRET or NEXTAUTH_SECRET" AUTH_SECRET NEXTAUTH_SECRET
  require_non_placeholder_env_key CRON_SECRET
  # Is this the club's live site or a copy (ENV-SAFETY 1 #3034, epic #2986)?
  # Refused here, in the step-3 preflight, rather than discovered after cutover —
  # see the helper's own comment for why an undeclared upgrade must abort.
  require_environment_role_env_key
  # Stripe credentials moved to encrypted, DB-backed storage (#2082) — no longer
  # required (or read) from .env. Legacy vars are warned about below.
  require_non_placeholder_env_key SMTP_HOST
  require_non_placeholder_env_key SMTP_PORT
  require_non_placeholder_env_key AWS_SES_ACCESS_KEY_ID
  require_non_placeholder_env_key AWS_SES_SECRET_ACCESS_KEY
  require_non_placeholder_env_key SES_SNS_TOPIC_ARN
  require_non_placeholder_env_key EMAIL_FROM
  require_non_placeholder_env_key LEGACY_DASHBOARD_EXPORT_TOKEN
  # Backup configuration moved to the encrypted, DB-backed store in-app (#2095):
  # BACKUP_ENABLED / BACKUP_RETENTION_DAYS / BACKUP_S3_* / BACKUP_RESTORE_VALIDATION_URL
  # are no longer read from .env, so they are not validated here — only warned
  # about below. BACKUP_CRON_SCHEDULE legitimately stays env-driven (cron-leader
  # timing) and defaults to "0 3 * * *" when unset.

  domain="$(trim_whitespace "$(get_env_file_value DOMAIN)")"
  require_domain_matches_url NEXTAUTH_URL "$domain"

  warn_legacy_xero_env
  warn_legacy_stripe_env
  warn_legacy_backup_env
}

using_prebuilt_images() {
  [ -n "$APP_IMAGE" ] || [ -n "$MIGRATE_IMAGE" ]
}

validate_image_reference_contract() {
  local image_ref

  if ! using_prebuilt_images; then
    return 0
  fi

  if [ -z "$APP_IMAGE" ] || [ -z "$MIGRATE_IMAGE" ]; then
    echo "APP_IMAGE and MIGRATE_IMAGE must both be set when deploying prebuilt images." >&2
    return 1
  fi

  for image_ref in "$APP_IMAGE" "$MIGRATE_IMAGE"; do
    if ! printf '%s\n' "$image_ref" | grep -Eq '^[^[:space:]]+(:[^[:space:]]+|@sha256:[[:xdigit:]]{64})$'; then
      echo "APP_IMAGE and MIGRATE_IMAGE must be tagged or digest-pinned image references without whitespace." >&2
      return 1
    fi
  done

  info "Using prebuilt app image: $APP_IMAGE"
  info "Using prebuilt migration image: $MIGRATE_IMAGE"
}

validate_repo_contract() {
  [ -f docker-compose.yml ] || {
    echo "docker-compose.yml not found in $PROJECT_DIR" >&2
    return 1
  }

  [ -f Dockerfile ] || {
    echo "Dockerfile not found in $PROJECT_DIR" >&2
    return 1
  }

  [ -f Caddyfile ] || {
    echo "Caddyfile not found in $PROJECT_DIR" >&2
    return 1
  }

  [ -f "$ACTIVE_UPSTREAM_FILE_REL" ] || {
    echo "Active upstream file not found at $ACTIVE_UPSTREAM_FILE_REL" >&2
    return 1
  }

  [ -f prisma/schema.prisma ] || {
    echo "Prisma schema not found at prisma/schema.prisma" >&2
    return 1
  }

  [ -d prisma/migrations ] || {
    echo "Prisma migrations directory not found at prisma/migrations" >&2
    return 1
  }

  [ -x scripts/validate-blue-green-migrations.sh ] || {
    echo "Blue/green migration safety validator not found or not executable at scripts/validate-blue-green-migrations.sh" >&2
    return 1
  }

  [ -f "$MIGRATION_SAFETY_LEDGER" ] || {
    echo "Blue/green migration safety ledger not found at $MIGRATION_SAFETY_LEDGER" >&2
    return 1
  }
}

validate_caddy_contract() {
  local domain

  domain="$(trim_whitespace "$(get_env_file_value DOMAIN)")"
  if ! grep -Fq "$domain" Caddyfile && ! grep -Fq '{$DOMAIN}' Caddyfile; then
    echo "DOMAIN=$domain does not appear in Caddyfile and Caddyfile does not use the {\$DOMAIN} placeholder" >&2
    return 1
  fi

  docker run --rm \
    -e "DOMAIN=$domain" \
    -v "$PROJECT_DIR/Caddyfile:/etc/caddy/Caddyfile:ro" \
    -v "$PROJECT_DIR/deploy/caddy:/etc/caddy/deploy:ro" \
    caddy:2-alpine \
    caddy validate --config /etc/caddy/Caddyfile >/dev/null
}

wait_for_health() {
  local service="$1"
  local timeout="$2"
  local cid
  local status
  local waited=0

  cid="$(docker compose ps -q "$service")"
  if [ -z "$cid" ]; then
    echo "No container found for service: $service" >&2
    return 1
  fi

  while true; do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid")"
    if [ "$status" = "healthy" ] || [ "$status" = "running" ]; then
      return 0
    fi

    if [ "$status" = "exited" ] || [ "$status" = "dead" ]; then
      echo "Service $service entered state: $status" >&2
      return 1
    fi

    if [ "$waited" -ge "$timeout" ]; then
      echo "Timed out waiting for $service to become healthy" >&2
      docker compose ps "$service" >&2 || true
      return 1
    fi

    sleep 2
    waited=$((waited + 2))
  done
}

wait_for_url() {
  local url="$1"
  local timeout="$2"
  local waited=0

  while true; do
    if curl -fsS "$url" >/dev/null; then
      return 0
    fi

    if [ "$waited" -ge "$timeout" ]; then
      echo "Timed out waiting for URL to respond successfully: $url" >&2
      return 1
    fi

    sleep 2
    waited=$((waited + 2))
  done
}

drain_previous_connections() {
  local drain_seconds="$1"

  if ! printf '%s' "$drain_seconds" | grep -Eq '^[0-9]+$'; then
    echo "BLUE_GREEN_DRAIN_SECONDS must be a non-negative integer" >&2
    return 1
  fi

  if [ "$drain_seconds" -eq 0 ]; then
    info "Skipping connection drain wait because BLUE_GREEN_DRAIN_SECONDS=0."
    return 0
  fi

  info "Allowing ${drain_seconds}s for in-flight requests on the previous service to drain."
  sleep "$drain_seconds"
}

maybe_pull_latest() {
  local branch

  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    info "Not a Git checkout. Skipping git pull."
    return
  fi

  branch="$(git rev-parse --abbrev-ref HEAD)"
  if [ "$branch" != "main" ]; then
    echo "Deployment must run from main. Current branch: $branch" >&2
    return 1
  fi

  if ! working_tree_is_clean; then
    echo "Deployment requires a clean working tree on main, including no untracked files." >&2
    return 1
  fi

  info "Pulling latest code from origin/main..."
  git pull --ff-only origin main
  info "Deploying commit $(git rev-parse --short HEAD)."
}

prepare_application_images() {
  local cron_image_ref
  local target_image_ref
  local migrate_image_ref

  if using_prebuilt_images; then
    info "Pulling prebuilt application images from the registry."
    docker compose pull "$CRON_SERVICE" "$TARGET_SERVICE" "$MIGRATE_SERVICE"
    return 0
  fi

  if [ "$SKIP_APP_IMAGE_BUILD" = "1" ]; then
    cron_image_ref="$(get_service_image_ref "$CRON_SERVICE")"
    target_image_ref="$(get_service_image_ref "$TARGET_SERVICE")"
    migrate_image_ref="$(get_service_image_ref "$MIGRATE_SERVICE")"
    info "Skipping app image build because SKIP_APP_IMAGE_BUILD=1."
    info "Reusing images: ${cron_image_ref}, ${target_image_ref}, ${migrate_image_ref}"
    return 0
  fi

  # AID-3 (#2372): stamp the deployed-code knowledge bundle with the verified
  # commit SHA + observed-at. `.git` is absent from the Docker build context, so
  # the in-builder generator reads these from build args that compose forwards
  # from the environment (docker-compose.yml). Exported here from the clean,
  # ff-only main checkout this deploy is building.
  GIT_COMMIT_SHA="$(git rev-parse HEAD)"
  KNOWLEDGE_BUNDLE_OBSERVED_AT="$(git show -s --format=%cI HEAD)"
  # #2352 D1: the same commit, as the release identifier the public website's
  # fixed CSP nonce is derived from. Baked into the image as a build arg rather
  # than passed at runtime, so every process of this release computes the same
  # nonce and a page one of them stored still hydrates when another serves it.
  # The nonce is a digest of this value, so the SHA itself is never published.
  RELEASE_ID="$GIT_COMMIT_SHA"
  export GIT_COMMIT_SHA KNOWLEDGE_BUNDLE_OBSERVED_AT RELEASE_ID
  info "Stamping deployed-code knowledge bundle with commit $(git rev-parse --short=12 HEAD)."

  if [ "$FORCE_NO_CACHE" = "1" ]; then
    docker compose build --pull --no-cache "$CRON_SERVICE" "$TARGET_SERVICE" "$MIGRATE_SERVICE"
  else
    docker compose build --pull "$CRON_SERVICE" "$TARGET_SERVICE" "$MIGRATE_SERVICE"
  fi
}

run_prune_command() {
  local success_message="$1"
  local failure_message="$2"
  shift 2

  if "$@" >/dev/null; then
    info "$success_message"
  else
    warn "$failure_message"
  fi
}

prune_stale_docker_assets() {
  local phase="$1"

  info "Reclaiming Docker disk space (${phase}) using resources older than $PRUNE_UNTIL."
  run_prune_command \
    "Cleared unused BuildKit cache older than $PRUNE_UNTIL." \
    "Unable to clear unused BuildKit cache older than $PRUNE_UNTIL. Continuing." \
    docker buildx prune -af --filter "until=$PRUNE_UNTIL"
  run_prune_command \
    "Pruned unused Docker images, containers, and networks older than $PRUNE_UNTIL." \
    "Unable to prune unused Docker images, containers, and networks older than $PRUNE_UNTIL. Continuing." \
    docker system prune -af --filter "until=$PRUNE_UNTIL"
}

get_service_image_ref() {
  local service="$1"
  local project_name
  local image_ref

  project_name="${COMPOSE_PROJECT_NAME:-$(basename "$PROJECT_DIR" | tr '[:upper:]' '[:lower:]')}"
  case "$service" in
    "$CRON_SERVICE"|"$BLUE_SERVICE"|"$GREEN_SERVICE")
      image_ref="${APP_IMAGE:-${project_name}-app:local}"
      ;;
    "$MIGRATE_SERVICE")
      image_ref="${MIGRATE_IMAGE:-${project_name}-migrate:local}"
      ;;
    *)
      image_ref="${project_name}-${service}:latest"
      ;;
  esac
  docker image inspect "$image_ref" >/dev/null 2>&1 || {
    echo "Unable to inspect image: $image_ref" >&2
    return 1
  }

  printf '%s' "$image_ref"
}

validate_runtime_image_contract() {
  local app_image_ref

  app_image_ref="$(get_service_image_ref "$TARGET_SERVICE")"
  if [ -z "$app_image_ref" ]; then
    echo "Unable to resolve image for service: $TARGET_SERVICE" >&2
    return 1
  fi

  docker run --rm --entrypoint sh "$app_image_ref" -lc '
    test -f /app/server.js &&
    test -d /app/.next/static &&
    test -d /app/public &&
    command -v node >/dev/null &&
    command -v wget >/dev/null
  ' >/dev/null

  # Backups are configured in-app now (#2095), so the image must ALWAYS be
  # backup-capable — the enabled switch and S3 destination live in the DB and can
  # be turned on at runtime with no redeploy. Gating these checks on a (now
  # unread) BACKUP_ENABLED env var would silently skip them once operators follow
  # the docs and remove the var, shipping an image that cannot back up. So the
  # pg_dump and AWS CLI presence checks are unconditional.
  docker run --rm --entrypoint sh "$app_image_ref" -lc 'command -v pg_dump >/dev/null' >/dev/null || {
    echo "The app image does not contain pg_dump, which the in-app backup job requires" >&2
    return 1
  }

  docker run --rm --entrypoint sh "$app_image_ref" -lc 'command -v aws >/dev/null' >/dev/null || {
    echo "The app image does not contain the AWS CLI, which durable (S3) backups require" >&2
    return 1
  }
}

verify_postgres_query() {
  local result

  result="$(docker compose exec -T "$POSTGRES_SERVICE" psql -U tac -d tacbookings -Atqc 'SELECT 1')"
  if [ "$result" != "1" ]; then
    echo "Postgres smoke query failed" >&2
    return 1
  fi
}

create_shadow_database() {
  docker compose exec -T "$POSTGRES_SERVICE" \
    psql -U tac -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS ${SHADOW_DATABASE_NAME};" \
    -c "CREATE DATABASE ${SHADOW_DATABASE_NAME};" >/dev/null

  SHADOW_DATABASE_CREATED=1
}

validate_prisma_schema_matches_migrations() {
  local db_password
  local diff_output
  local shadow_database_url

  db_password="$(trim_whitespace "$(get_env_file_value DB_PASSWORD)")"
  create_shadow_database
  shadow_database_url="postgresql://tac:${db_password}@postgres:5432/${SHADOW_DATABASE_NAME}"

  if ! diff_output="$(
    docker compose --profile "$MIGRATE_SERVICE" run --rm \
      -e SHADOW_DATABASE_URL="$shadow_database_url" \
      "$MIGRATE_SERVICE" \
      ./node_modules/.bin/prisma migrate diff \
      --exit-code \
      --from-migrations prisma/migrations \
      --to-schema prisma/schema.prisma 2>&1
  )"; then
    printf '%s\n' "$diff_output" >&2
    echo "Prisma schema does not match the committed migration history." >&2
    echo "Create and commit the missing migration before deploying." >&2
    return 1
  fi

  drop_shadow_database
}

verify_prisma_migration_status() {
  local status_output

  if ! status_output="$(
    docker compose --profile "$MIGRATE_SERVICE" run --rm \
      "$MIGRATE_SERVICE" \
      ./node_modules/.bin/prisma migrate status 2>&1
  )"; then
    printf '%s\n' "$status_output" >&2
    echo "Prisma migration status check failed after migrate deploy." >&2
    return 1
  fi
}

list_pending_migration_sql_files() {
  local applied_migrations_file
  local migration_table_exists
  local migration_dir
  local migration_name
  local migration_sql_path

  applied_migrations_file="$(mktemp)"
  migration_table_exists="$(
    docker compose exec -T "$POSTGRES_SERVICE" \
      psql -U tac -d tacbookings -Atqc \
      "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = '_prisma_migrations')"
  )"

  if [ "$migration_table_exists" = "t" ]; then
    docker compose exec -T "$POSTGRES_SERVICE" \
      psql -U tac -d tacbookings -Atqc \
      "SELECT migration_name FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL ORDER BY finished_at" \
      >"$applied_migrations_file"
  fi

  while IFS= read -r migration_sql_path; do
    migration_dir="$(dirname "$migration_sql_path")"
    migration_name="$(basename "$migration_dir")"
    if grep -Fxq "$migration_name" "$applied_migrations_file"; then
      continue
    fi
    printf '%s\n' "$migration_sql_path"
  done < <(find prisma/migrations -mindepth 2 -maxdepth 2 -name migration.sql | sort)

  rm -f "$applied_migrations_file"
}

validate_pending_migrations_blue_green_safe() {
  local pending_sql_files=()

  mapfile -t pending_sql_files < <(list_pending_migration_sql_files)
  if [ "${#pending_sql_files[@]}" -eq 0 ]; then
    info "No pending Prisma migrations detected."
    return 0
  fi

  ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS="$ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS" \
    BLUE_GREEN_MIGRATION_OVERRIDE_REASON="$BLUE_GREEN_MIGRATION_OVERRIDE_REASON" \
    BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED="$BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED" \
    MIGRATION_SAFETY_LEDGER="$MIGRATION_SAFETY_LEDGER" \
    ./scripts/validate-blue-green-migrations.sh "${pending_sql_files[@]}"
}

assert_readiness_payload_healthy() {
  local source="$1"
  local payload="$2"

  if ! printf '%s' "$payload" | grep -q '"status":"healthy"'; then
    echo "$source health payload did not report healthy: $payload" >&2
    return 1
  fi

  if ! printf '%s' "$payload" | grep -q '"db":{"status":"ok"'; then
    echo "$source health payload did not report db ok: $payload" >&2
    return 1
  fi

  if ! printf '%s' "$payload" | grep -q '"config":{"status":"ok"'; then
    echo "$source readiness payload did not report config ok: $payload" >&2
    return 1
  fi
}

assert_runtime_identity() {
  local source="$1"
  local payload="$2"
  local expected_role="$3"
  local expected_cron_enabled="$4"
  local expected_environment_role="${5:-}"

  if [ -n "$expected_role" ] && ! printf '%s' "$payload" | grep -q "\"role\":\"${expected_role}\""; then
    echo "$source runtime payload did not report role=${expected_role}: $payload" >&2
    return 1
  fi

  if [ -n "$expected_cron_enabled" ] && ! printf '%s' "$payload" | grep -q "\"cronEnabled\":${expected_cron_enabled}"; then
    echo "$source runtime payload did not report cronEnabled=${expected_cron_enabled}: $payload" >&2
    return 1
  fi

  # The DECLARATION this container parsed for itself (ENV-SAFETY 1 #3034). Empty
  # expectation means "not checked", the same convention the two assertions above
  # use, so a caller that has nothing to compare against is not silently green.
  if [ -n "$expected_environment_role" ] && ! printf '%s' "$payload" | grep -q "\"environmentRole\":\"${expected_environment_role}\""; then
    echo "$source did not report environmentRole=${expected_environment_role}: $payload" >&2
    echo "That is what THIS CONTAINER parsed out of APP_ENVIRONMENT_ROLE, which is" >&2
    echo "not necessarily what .env says: Docker Compose prefers a value exported" >&2
    echo "in the invoking shell over the env file, and takes the LAST duplicate" >&2
    echo "line rather than the first." >&2
    echo "A container reporting non-production would hold back every real member's" >&2
    echo "email and, once Xero containment lands, rewrite the email addresses on" >&2
    echo "the club's real accounting contacts. absent or invalid resolves UNKNOWN," >&2
    echo "which holds back member email and Xero writes until it is declared." >&2
    echo "Refusing before the cutover. Run 'unset APP_ENVIRONMENT_ROLE' in this" >&2
    echo "shell, and check .env holds exactly one APP_ENVIRONMENT_ROLE=production." >&2
    return 1
  fi
}

curl_with_cron_secret_header() {
  local url="$1"
  local cron_secret="$2"

  {
    printf 'url = "%s"\n' "$url"
    printf 'header = "x-cron-secret: %s"\n' "$cron_secret"
    printf 'fail\n'
    printf 'silent\n'
    printf 'show-error\n'
  } | curl --config -
}

get_expected_runtime_role() {
  local service="$1"

  case "$service" in
    "$CRON_SERVICE")
      echo "cron-leader"
      ;;
    "$BLUE_SERVICE")
      echo "web-blue"
      ;;
    "$GREEN_SERVICE")
      echo "web-green"
      ;;
    *)
      echo "$service"
      ;;
  esac
}

get_expected_cron_enabled() {
  local service="$1"

  if [ "$service" = "$CRON_SERVICE" ]; then
    echo "true"
  else
    echo "false"
  fi
}

get_service_runtime_payload() {
  local service="$1"

  # THE APPLICATION'S OWN ANSWER, asked of the container from inside it.
  #
  # THIS DELIBERATELY RE-IMPLEMENTS NOTHING. It used to parse
  # APP_ENVIRONMENT_ROLE in shell, mirroring readEnvironmentRoleDeclaration() --
  # and a second review lens showed why that was the wrong shape rather than
  # merely under-tested: it built six mutants of that snippet and FIVE survived
  # the source-text assertions guarding it, four of them making a container that
  # declares `non-production` report `production` so the deploy proceeded. A
  # duplicated parser pinned by greps is a parser that drifts, and pre-cutover it
  # was the SOLE witness -- the application`s own parse was only asserted after
  # the cutover, by verify_external_health.
  #
  # So the pre-cutover witness is now the same endpoint the post-cutover check
  # uses, /api/deploy/runtime-status, whose environmentRole comes from
  # readEnvironmentRoleDeclaration() itself. There is no second implementation
  # left to disagree, and this class of finding cannot recur. The contract test
  # asserts that no shell-side kind mapping comes back.
  #
  # THE SECRET NEVER LEAVES THE CONTAINER. CRON_SECRET is already in the app
  # environment (docker-compose.yml), so the request is authorised from inside
  # rather than by interpolating the secret into a `docker compose exec` argument
  # list, where it would be readable in the host`s process table. That is the same
  # care `verify_external_health` takes by feeding curl its header on stdin.
  # busybox wget (v1.37 in node:24.17-alpine) supports --header; the readiness
  # fetch above already relies on the same wget being present.
  #
  # REACHABLE AT THIS POINT, verified from the step order: step 14 runs
  # `up -d --force-recreate` then wait_for_health, and the container`s own
  # healthcheck polls /api/health/ready on this exact loopback address, so the
  # server is answering before this runs. The route is force-dynamic and touches
  # no database.
  #
  # ONE DELIBERATE BEHAVIOUR CHANGE, which is a correctness gain: cronEnabled now
  # comes from the application`s rule (CRON_ENABLED lowercased must equal "true")
  # rather than from a permissive shell case list that also accepted 1/yes/on. A
  # deployment setting CRON_ENABLED=1 would have the app run NO cron while the old
  # shell parse reported cron enabled, so the deploy would have passed a
  # cron-leader that does nothing. Every documented value is true or false
  # (CONFIGURATION.md, .env.staging.example), so this refuses nothing that was
  # ever documented, and where the two differ the application is right.
  #
  # The path is passed as a positional argument rather than interpolated into the
  # single-quoted script, so no quoting of a host variable happens inside it.
  docker compose exec -T "$service" /bin/sh -c '
secret="${CRON_SECRET:-}"
if [ -z "$secret" ]; then
  echo "CRON_SECRET is empty inside this container, so the deploy cannot ask the application which release and which environment role it is running." >&2
  exit 1
fi
wget -q -O- --header "x-cron-secret: $secret" "http://127.0.0.1:3000$1"
' sh "$DEPLOY_RUNTIME_STATUS_PATH"
}

assert_logs_contain_any() {
  local logs="$1"
  local description="$2"
  shift 2

  local pattern
  for pattern in "$@"; do
    if printf '%s\n' "$logs" | grep -Fq "$pattern"; then
      return 0
    fi
  done

  echo "App startup log is missing all expected lines for ${description}." >&2
  printf 'Expected one of:\n' >&2
  for pattern in "$@"; do
    printf '  - %s\n' "$pattern" >&2
  done
  return 1
}

verify_internal_health() {
  local service="$1"
  local expected_role
  local expected_cron_enabled
  local payload
  local runtime_payload

  expected_role="$(get_expected_runtime_role "$service")"
  expected_cron_enabled="$(get_expected_cron_enabled "$service")"
  payload="$(docker compose exec -T "$service" wget -qO- "http://127.0.0.1:3000${READINESS_PATH}")"
  assert_readiness_payload_healthy "Internal ${service}" "$payload"
  runtime_payload="$(get_service_runtime_payload "$service")"
  assert_runtime_identity "Internal ${service}" "$runtime_payload" "$expected_role" "$expected_cron_enabled" "$EXPECTED_ENVIRONMENT_ROLE_DECLARATION"
}

verify_external_health() {
  local service="$1"
  local domain
  local expected_role
  local expected_cron_enabled
  local payload
  local runtime_payload
  local runtime_url
  local url

  domain="$(trim_whitespace "$(get_env_file_value DOMAIN)")"
  expected_role="$(get_expected_runtime_role "$service")"
  expected_cron_enabled="$(get_expected_cron_enabled "$service")"
  url="https://${domain}${READINESS_PATH}"
  wait_for_url "$url" "$HEALTH_TIMEOUT_SECONDS"
  payload="$(curl -fsS "$url")"
  assert_readiness_payload_healthy "External" "$payload"

  runtime_url="https://${domain}${DEPLOY_RUNTIME_STATUS_PATH}"
  runtime_payload="$(
    curl_with_cron_secret_header \
      "$runtime_url" \
      "$(trim_whitespace "$(get_env_file_value CRON_SECRET)")"
  )"
  assert_runtime_identity "External deploy runtime status" "$runtime_payload" "$expected_role" "$expected_cron_enabled" "$EXPECTED_ENVIRONMENT_ROLE_DECLARATION"
}

verify_cron_registration() {
  local logs=""
  local pattern
  local missing=""
  local waited=0
  local timeout="${CRON_REGISTRATION_TIMEOUT_SECONDS:-60}"
  local patterns=(
    "Scheduled booking and public-request cron cycle"
    "Scheduled database backup"
    "Scheduled data pruning"
    "Scheduled draft cleanup"
    "Scheduled pending deadline alerts"
    "Scheduled check-in reminders"
    "Scheduled capacity warnings"
    "Scheduled admin daily digest"
    "Scheduled email retry"
    "Scheduled complete bookings"
    "Scheduled hut leader auto-assign"
    "Scheduled age-up check"
    "Scheduled credit reconciliation"
  )

  while true; do
    logs="$(docker compose logs "$CRON_SERVICE" --tail 200)"
    missing=""
    for pattern in "${patterns[@]}"; do
      if ! printf '%s\n' "$logs" | grep -Fq "$pattern"; then
        missing="$pattern"
        break
      fi
    done

    if [ -z "$missing" ]; then
      break
    fi

    if [ "$waited" -ge "$timeout" ]; then
      echo "App startup log is missing expected cron registration after ${timeout}s: $missing" >&2
      return 1
    fi

    sleep 2
    waited=$((waited + 2))
  done

  assert_logs_contain_any \
    "$logs" \
    "finance sync registration" \
    "Scheduled daily finance sync" \
    "Finance sync cron registration skipped because the module is off"

  assert_logs_contain_any \
    "$logs" \
    "waitlist processor registration" \
    "Scheduled waitlist processor" \
    "Waitlist cron registration skipped because the module is off"

  assert_logs_contain_any \
    "$logs" \
    "Xero membership refresh registration" \
    "Scheduled Xero membership refresh" \
    "Xero cron registration skipped because the module is off" \
    "Xero membership refresh disabled by XERO_ENABLE_DAILY_MEMBERSHIP_REFRESH"
}

# --------------------------------------------------------------------------
# Pre-cutover warm-up gate (#2566, owner decision Option 4)
#
# The gate itself lives in the application (`src/app/api/deploy/warmup/route.ts`)
# and runs INSIDE the container it is warming, for three reasons set out in that
# file's header: the process that stores each page is then the process that
# answered, so warming the wrong colour is structurally impossible; untrusted CMS
# paths never touch a shell; and the tiered rules are unit-testable TypeScript
# rather than bash.
#
# This function's whole job is therefore to ask, print what came back, and refuse
# to cut over on anything that is not an acceptable verdict — including an
# unreadable answer.
# --------------------------------------------------------------------------

# Defined here rather than reused from the wrapper on purpose: the wrapper's
# `env_flag_is_true` lives INSIDE `run_production_wrapper`, and the internal engine
# runs as a separate invocation of this script, so that definition does not exist in
# this shell. Calling it would fail at the gate with "command not found" — i.e. it
# would block every deploy — which is the fail-closed direction but for the wrong
# reason.
warmup_gate_is_enabled() {
  case "$DEPLOY_WARMUP_ENABLED" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

# One numeric warm-up setting, checked against the SAME range the endpoint enforces.
#
# The range is mirrored here rather than left to the endpoint for a plain operational
# reason: the endpoint answers HTTP 400 with the offending parameter named in the body,
# and the container's only HTTP client is busybox `wget`, which on a non-2xx status
# writes no body at all. The endpoint now also answers the text form with a readable
# `blocked` report, so the reason survives either way — but catching it HERE means the
# operator is told which setting is wrong before a container is even asked, and the
# ranges cannot drift unnoticed because the argument list reads like the endpoint's.
#
# Ranges as at src/app/api/deploy/warmup/route.ts:
#   concurrency 1-8, requestTimeoutSeconds 1-120, totalTimeoutSeconds 5-1800,
#   maxFailedCmsRoutes 0-100, maxFailedCmsPercent 0-100.
require_integer_setting_in_range() {
  local name="$1"
  local value="$2"
  local min="$3"
  local max="$4"

  if ! printf '%s' "$value" | grep -Eq '^[0-9]+$'; then
    echo "${name} must be a non-negative integer. Got: ${value}" >&2
    return 1
  fi

  if [ "$value" -lt "$min" ] || [ "$value" -gt "$max" ]; then
    echo "${name} must be between ${min} and ${max} (the warm-up endpoint refuses anything else). Got: ${value}" >&2
    return 1
  fi
}

validate_warmup_settings() {
  local services

  # `|| return 1` on each, rather than leaning on the script's `set -e`: this function
  # is the one place a mistyped setting is caught, and its refusal should be readable in
  # the source rather than a property of a shell option set 1,400 lines earlier.
  require_integer_setting_in_range DEPLOY_WARMUP_CONCURRENCY "$DEPLOY_WARMUP_CONCURRENCY" 1 8 || return 1
  require_integer_setting_in_range DEPLOY_WARMUP_REQUEST_TIMEOUT_SECONDS "$DEPLOY_WARMUP_REQUEST_TIMEOUT_SECONDS" 1 120 || return 1
  require_integer_setting_in_range DEPLOY_WARMUP_TOTAL_TIMEOUT_SECONDS "$DEPLOY_WARMUP_TOTAL_TIMEOUT_SECONDS" 5 1800 || return 1
  require_integer_setting_in_range DEPLOY_WARMUP_MAX_FAILED_CMS_ROUTES "$DEPLOY_WARMUP_MAX_FAILED_CMS_ROUTES" 0 100 || return 1
  require_integer_setting_in_range DEPLOY_WARMUP_MAX_FAILED_CMS_PERCENT "$DEPLOY_WARMUP_MAX_FAILED_CMS_PERCENT" 0 100 || return 1

  # Assigned first so `warmup_services`'s own refusal is not swallowed by the `for`
  # list, which discards a command substitution's exit status.
  services="$(warmup_services)" || return 1

  local service
  for service in $services; do
    case "$service" in
      "$CRON_SERVICE"|"$BLUE_SERVICE"|"$GREEN_SERVICE") ;;
      *)
        echo "DEPLOY_WARMUP_SERVICES may only name app services (${CRON_SERVICE}, ${BLUE_SERVICE}, ${GREEN_SERVICE}). Got: ${service}" >&2
        return 1
        ;;
    esac
  done
}

# Every web instance that can serve public traffic after this deploy, and so every
# instance with its own page store to fill.
#
# The default is the target colour AND the cron leader, which is not belt and
# braces: `write_active_upstream_file` lists the cron leader as the SECOND
# upstream (`to <target>:3000 app:3000`), so Caddy serves public pages from it
# whenever the target fails its health probe. A warm target beside a cold
# fallback would hand the worst page loads of the release to exactly the moment
# the site is already struggling. The owner's decision anticipates this under
# "Future scaling": warm every instance separately, because one instance's
# in-memory store says nothing about another's.
# An EMPTY resolved list is refused rather than accepted, and that refusal is the
# point of the loop below. `[ -n "$DEPLOY_WARMUP_SERVICES" ]` is true for a value that
# is only whitespace — the shape a command substitution that produced nothing leaves
# behind — and printing it verbatim then word-split to nothing, so both callers
# iterated zero times, the gate returned success, and the deploy cut over having asked
# not one question about the release. It is the only path where this gate could report
# a pass without proving anything, and it printed nothing an operator would notice.
warmup_services() {
  local resolved=""
  local service

  if [ -n "$DEPLOY_WARMUP_SERVICES" ]; then
    for service in $DEPLOY_WARMUP_SERVICES; do
      resolved="${resolved:+$resolved }$service"
    done
  else
    resolved="$TARGET_SERVICE $CRON_SERVICE"
  fi

  if [ -z "$resolved" ]; then
    echo "DEPLOY_WARMUP_SERVICES resolved to no services, so the warm-up gate would prove nothing about this release. Name the app services to warm, or unset it for the default (${TARGET_SERVICE} and ${CRON_SERVICE})." >&2
    return 1
  fi

  printf '%s' "$resolved"
}

# The release identifier the gate should expect to find in the container it warms.
#
# A registry deploy pins both images by commit SHA, so the tag IS the expectation.
# A digest-pinned reference is deliberately not used: the digest is not the commit,
# and passing it would produce a false mismatch and block a good deploy. The local
# build path falls back to the checked-out commit, which is what
# `prepare_application_images` exports as RELEASE_ID for that path anyway.
resolve_expected_release() {
  local tag

  if [ -n "$APP_IMAGE" ] && [ "${APP_IMAGE#*@}" = "$APP_IMAGE" ]; then
    tag="${APP_IMAGE##*:}"
    if printf '%s' "$tag" | grep -Eq '^[0-9a-fA-F]{7,64}$'; then
      printf '%s' "$tag"
      return 0
    fi
  fi

  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git rev-parse HEAD
    return 0
  fi

  printf ''
}

# Warnings that must outlive the step they were printed in.
#
# The owner's decision asks for a deploy that completed with a tolerated failure to be
# "clearly labelled" and for the failure to be "visible to the operator completing the
# deployment". Printing it once at step 16 of 20 does not achieve that: four more steps,
# a container table and 80 lines of application logs scroll past before the completion
# banner, there is no log file (the wrapper runs the engine with no `tee`), and the
# operator's terminal is the only record. So each warning is accumulated here and
# re-printed AFTER the banner, and the banner itself names the state.
WARMUP_WARNINGS=""

record_warmup_warning() {
  if [ -z "$WARMUP_WARNINGS" ]; then
    WARMUP_WARNINGS="$1"
    return 0
  fi

  # `printf` rather than a literal newline inside the expansion: a `}` at column zero
  # inside a string reads like the end of the function to a human and to anything that
  # extracts a function body by line.
  WARMUP_WARNINGS="$(printf '%s\n%s' "$WARMUP_WARNINGS" "$1")"
}

# Accumulates every line of one report's WARNINGS block, whatever the verdict was.
#
# Keying the accumulator on the verdict alone lost warnings that arrive with a plain
# `pass`, and `evaluateWarmup` returns exactly that in several real cases
# (`src/lib/deploy/warmup-evaluate.ts`): the configured Book Now target unpublished
# between discovery and warming, a published CMS page unpublished the same way, a Book
# Now setting the gate could not read, an image carrying no release identifier, a
# deploy that could not say which release to expect, and a tolerance the operator
# widened. Each of those is a thing the operator has to act on, and each of them
# scrolled off screen with the step 16 report.
#
# Fed from a HERE-DOCUMENT rather than a pipe on purpose: `record_warmup_warning`
# assigns a global, and a `while` loop on the right of a pipe runs in a subshell, so
# every line would be recorded into a copy that is discarded at the closing `done`.
record_gate_warnings() {
  local service="$1"
  local warnings="$2"
  local line

  if [ -z "$warnings" ]; then
    return 0
  fi

  while IFS= read -r line; do
    if [ -n "$line" ]; then
      record_warmup_warning "${service}: warm-up warning — ${line}"
    fi
  done <<EOF
$warnings
EOF
}

# Re-prints the accumulated warnings and returns 0 when there were any, so the caller
# can label the completion banner rather than guess.
print_deploy_warning_summary() {
  if [ -z "$WARMUP_WARNINGS" ]; then
    return 1
  fi

  echo
  echo "============================================"
  echo "  DEPLOY COMPLETED WITH WARNINGS"
  echo "============================================"
  printf '%s\n' "$WARMUP_WARNINGS" | while IFS= read -r line; do
    printf '  ! %s\n' "$line"
  done
  echo
  echo "  Do not close this deploy out until each line above is recorded on a"
  echo "  follow-up issue. The full warm-up summary is at step 16 of 20 above."
  echo "============================================"
  return 0
}

warmup_gate_url() {
  local expected_release="$1"
  local url

  url="http://127.0.0.1:3000${DEPLOY_WARMUP_PATH}?format=text"
  url="${url}&concurrency=${DEPLOY_WARMUP_CONCURRENCY}"
  url="${url}&requestTimeoutSeconds=${DEPLOY_WARMUP_REQUEST_TIMEOUT_SECONDS}"
  url="${url}&totalTimeoutSeconds=${DEPLOY_WARMUP_TOTAL_TIMEOUT_SECONDS}"
  url="${url}&maxFailedCmsRoutes=${DEPLOY_WARMUP_MAX_FAILED_CMS_ROUTES}"
  url="${url}&maxFailedCmsPercent=${DEPLOY_WARMUP_MAX_FAILED_CMS_PERCENT}"
  if [ -n "$expected_release" ]; then
    url="${url}&expectedRelease=${expected_release}"
  fi

  printf '%s' "$url"
}

# Runs the gate against one service and returns non-zero unless the verdict allows
# a cutover.
#
# The cron secret is read INSIDE the container, from the environment the app
# already has, so it never appears in a host process list — the same concern
# `curl_with_cron_secret_header` addresses for the external check. Only the URL is
# passed in, and every value in it has been validated as an integer or a hex commit
# id above, so there is nothing to escape and no shell expansion of untrusted data.
run_warmup_gate_for_service() {
  local service="$1"
  local expected_release="$2"
  local url
  local exec_timeout
  local report
  local stderr_file
  local verdict
  local skipped_reason
  local failed_paths
  local gate_warnings

  url="$(warmup_gate_url "$expected_release")"
  # The container-side deadline must expire first, so a slow release produces a
  # readable report rather than a severed exec.
  exec_timeout=$((DEPLOY_WARMUP_TOTAL_TIMEOUT_SECONDS + 60))
  stderr_file="$(mktemp)"

  info "Warming ${service} directly (bounded to ${DEPLOY_WARMUP_CONCURRENCY} requests at a time)."

  if ! report="$(
    docker compose exec -T \
      -e "WARMUP_GATE_URL=$url" \
      -e "WARMUP_GATE_TIMEOUT=$exec_timeout" \
      "$service" \
      /bin/sh -lc 'wget -O - -T "$WARMUP_GATE_TIMEOUT" --header="x-cron-secret: $CRON_SECRET" "$WARMUP_GATE_URL"' \
      2>"$stderr_file"
  )"; then
    printf '%s\n' "$report"
    cat "$stderr_file" >&2
    rm -f "$stderr_file"
    echo "The warm-up gate on ${service} could not be read, so nothing has been proved about this release. Refusing to switch traffic." >&2
    return 1
  fi

  rm -f "$stderr_file"
  printf '%s\n' "$report"

  # The sentinel line, read through the one constant so the script and the report
  # renderer cannot drift. Last occurrence wins, and an absent line is refused
  # below rather than treated as a pass.
  # `|| true` is load-bearing under `set -o pipefail`: a report with no sentinel
  # makes grep exit non-zero, and without this the assignment would abort the
  # deploy with no explanation instead of reaching the "no readable verdict"
  # message below. The refusal is the same either way; the operator's information
  # is not.
  verdict="$(
    printf '%s\n' "$report" |
      grep -F "${DEPLOY_WARMUP_VERDICT_SENTINEL}:" |
      tail -n 1 |
      awk '{print $2}' || true
  )"

  # The failed addresses out of the summary's FAILED ROUTES block, so the end-of-deploy
  # warning names them rather than pointing at scrolled-off output. Each such line is
  # `    ! /path [tier] kind — detail`; a WARNINGS line also begins `    ! ` but never
  # with an address, which is what the `/` and the following ` [` select on.
  failed_paths="$(
    printf '%s\n' "$report" |
      sed -n 's|^[[:space:]]*![[:space:]]*\(/[^[:space:]]*\)[[:space:]]\[.*|\1|p' |
      tr '\n' ' ' |
      sed 's/[[:space:]]*$//' || true
  )"

  # Every line of the report's WARNINGS block, read out of the report rather than
  # inferred from the verdict. The block runs from the `WARNINGS (n):` header to the
  # blank line the renderer puts before the next block
  # (`src/lib/deploy/warmup-report.ts`), and each line inside it is `    ! <text>`.
  gate_warnings="$(
    printf '%s\n' "$report" |
      awk '
        /^[[:space:]]*WARNINGS \(/ { in_block = 1; next }
        in_block && /^[[:space:]]*$/ { in_block = 0; next }
        in_block { sub(/^[[:space:]]*![[:space:]]*/, ""); print }
      ' || true
  )"

  case "$verdict" in
    pass)
      if [ -n "$gate_warnings" ]; then
        # A pass is still a pass — but it is not a clean one, and the reasons above
        # are repeated after the completion banner rather than left to scroll away.
        warn "Warm-up gate passed on ${service} with warnings. The cutover proceeds; each warning above is repeated after the completion banner and needs recording before this deploy is closed out."
      else
        info "Warm-up gate passed on ${service}."
      fi
      ;;
    pass-with-warning)
      warn "Warm-up gate passed on ${service} WITH WARNINGS. The deployment is completing with a known non-critical page failure — record the failed path above and file (or link) a follow-up issue for it before closing this deploy out."
      record_warmup_warning "${service}: passed WITH WARNINGS — a non-critical published page failed. Failed path(s): ${failed_paths:-see the step 16 summary above}. File or link a follow-up issue before closing this deploy out."
      ;;
    skipped)
      skipped_reason="$(printf '%s\n' "$report" | sed -n 's/^[[:space:]]*SKIPPED: //p' | head -n 1 || true)"
      warn "Warm-up gate skipped on ${service}: ${skipped_reason:-no reason reported}"
      record_warmup_warning "${service}: the warm-up gate was SKIPPED, so this cutover is unverified — ${skipped_reason:-no reason reported}"
      ;;
    blocked)
      echo "The warm-up gate BLOCKED the cutover on ${service}. See the blocked reasons above." >&2
      return 1
      ;;
    *)
      echo "The warm-up gate on ${service} returned no readable verdict (expected a '${DEPLOY_WARMUP_VERDICT_SENTINEL}: ...' line). Refusing to switch traffic." >&2
      return 1
      ;;
  esac

  # After the case and outside it, so this cannot be keyed on the verdict again: the
  # reasons the gate reported are carried to the end of the deploy for every verdict
  # that reaches here, `pass` included.
  record_gate_warnings "$service" "$gate_warnings"
}

run_warmup_gate() {
  local expected_release
  local service
  local services

  if ! warmup_gate_is_enabled; then
    if [ -z "$DEPLOY_WARMUP_OVERRIDE_REASON" ]; then
      echo "DEPLOY_WARMUP_ENABLED=${DEPLOY_WARMUP_ENABLED} disables the pre-cutover warm-up gate, which requires a written justification." >&2
      echo "Set DEPLOY_WARMUP_OVERRIDE_REASON to the reason this deploy may cut over unwarmed, or leave the gate enabled." >&2
      return 1
    fi

    warn "================================================================"
    warn "PRE-CUTOVER WARM-UP GATE DISABLED for this deploy."
    warn "Reason: ${DEPLOY_WARMUP_OVERRIDE_REASON}"
    warn "Nothing has verified that the new release renders its public pages or"
    warn "populates its page cache. The first visitor to each page pays a cold"
    warn "render, and a broken public page will reach members rather than this log."
    warn "================================================================"
    record_warmup_warning "The pre-cutover warm-up gate was DISABLED for this deploy (reason given: ${DEPLOY_WARMUP_OVERRIDE_REASON}). Nothing verified that this release serves its public pages."
    return 0
  fi

  validate_warmup_settings || return 1

  expected_release="$(resolve_expected_release)"
  if [ -z "$expected_release" ]; then
    warn "Could not determine which commit this deploy is releasing, so the gate cannot confirm it warmed the intended release."
    record_warmup_warning "The gate could not confirm it warmed the intended release: this deploy could not determine which commit it is releasing."
  fi

  # Assigned first so an empty resolution refuses the deploy instead of being silently
  # iterated zero times. See `warmup_services`.
  services="$(warmup_services)" || return 1

  for service in $services; do
    # Explicit rather than relying on `set -e` to abort the run: this is the refusal
    # that stops a bad release reaching members, so it is spelled out here.
    run_warmup_gate_for_service "$service" "$expected_release" || return 1
  done
}

get_active_service() {
  local file="$PROJECT_DIR/$ACTIVE_UPSTREAM_FILE_REL"

  if [ ! -f "$file" ]; then
    echo "$CRON_SERVICE"
    return 0
  fi

  if grep -Fq "${BLUE_SERVICE}:3000" "$file"; then
    echo "$BLUE_SERVICE"
    return 0
  fi

  if grep -Fq "${GREEN_SERVICE}:3000" "$file"; then
    echo "$GREEN_SERVICE"
    return 0
  fi

  echo "$CRON_SERVICE"
}

choose_target_service() {
  local active_service="$1"

  if [ "$active_service" = "$BLUE_SERVICE" ]; then
    echo "$GREEN_SERVICE"
  else
    echo "$BLUE_SERVICE"
  fi
}

write_active_upstream_file() {
  local primary_service="$1"
  local fallback_service="${2:-}"
  local destination="$PROJECT_DIR/$ACTIVE_UPSTREAM_FILE_REL"
  local temp_file

  temp_file="$(mktemp "${destination}.XXXXXX")"
  {
    echo "reverse_proxy {"
    echo "  lb_policy first"
    echo "  lb_try_duration 10s"
    echo "  fail_duration 30s"
    echo "  health_uri ${READINESS_PATH}"
    echo "  health_interval 10s"
    echo "  health_timeout 5s"
    if [ -n "$fallback_service" ] && [ "$fallback_service" != "$primary_service" ]; then
      printf '  to %s:3000 %s:3000\n' "$primary_service" "$fallback_service"
    else
      printf '  to %s:3000\n' "$primary_service"
    fi
    echo "}"
  } >"$temp_file"
  mv "$temp_file" "$destination"
}

restore_previous_upstream_file() {
  local previous_upstream_contents="$1"
  local destination="$PROJECT_DIR/$ACTIVE_UPSTREAM_FILE_REL"
  printf '%s\n' "$previous_upstream_contents" >"$destination"
}

reload_caddy() {
  local attempts="${1:-10}"
  local delay_seconds="${2:-1}"
  local attempt=1

  while [ "$attempt" -le "$attempts" ]; do
    if docker compose exec -T "$CADDY_SERVICE" \
      caddy reload --address 127.0.0.1:2019 --config /etc/caddy/Caddyfile >/dev/null; then
      return 0
    fi

    if [ "$attempt" -lt "$attempts" ]; then
      sleep "$delay_seconds"
    fi
    attempt=$((attempt + 1))
  done

  echo "Timed out waiting for the Caddy admin endpoint to accept reloads on 127.0.0.1:2019" >&2
  return 1
}

stop_if_running() {
  local service="$1"

  if [ -n "$(docker compose ps -q "$service" 2>/dev/null || true)" ]; then
    docker compose stop "$service" >/dev/null
  fi
}

remove_service_container_if_present() {
  local service="$1"

  if [ -n "$(docker compose ps -a -q "$service" 2>/dev/null || true)" ]; then
    docker compose rm -fs "$service" >/dev/null
  fi
}

cleanup_inactive_web_services() {
  local service

  for service in "$BLUE_SERVICE" "$GREEN_SERVICE"; do
    if [ "$service" = "$TARGET_SERVICE" ]; then
      continue
    fi

    if [ -n "$(docker compose ps -a -q "$service" 2>/dev/null || true)" ]; then
      remove_service_container_if_present "$service"
      info "Removed inactive web service container: ${service}"
    fi
  done
}

remove_compose_orphans() {
  docker compose up -d --remove-orphans \
    "$POSTGRES_SERVICE" \
    "$CRON_SERVICE" \
    "$TARGET_SERVICE" \
    "$CADDY_SERVICE" >/dev/null
}

echo "============================================"
echo "  AlpineClubBookingsNZ: Blue/Green Deploy Script"
echo "============================================"

cd "$PROJECT_DIR"

ACTIVE_SERVICE="$(get_active_service)"
TARGET_SERVICE="$(choose_target_service "$ACTIVE_SERVICE")"

step "1/20" "Refreshing code (if appropriate)"
maybe_pull_latest

step "2/20" "Validating host deployment prerequisites"
validate_host_contract
info "Host has the required deployment commands."

step "3/20" "Validating deployment environment contract"
validate_env_contract
validate_image_reference_contract
info ".env contains the required production settings."

step "4/20" "Validating repository deployment files"
validate_repo_contract
validate_caddy_contract
info "Docker, Prisma, and Caddy config files are present and valid."

step "5/20" "Validating Docker Compose configuration"
docker compose config -q
info "docker compose config is valid."

step "6/20" "Selecting target web service"
info "Current live upstream: ${ACTIVE_SERVICE}"
info "Target web service: ${TARGET_SERVICE}"

step "7/20" "Pruning stale Docker cache before image preparation"
prune_stale_docker_assets "before image preparation"

step "8/20" "Pulling infrastructure images"
docker compose pull "$POSTGRES_SERVICE" "$CADDY_SERVICE"

step "9/20" "Preparing app, target web, and migration images"
prepare_application_images

step "10/20" "Validating runtime image contract"
validate_runtime_image_contract
info "App image contains the expected runtime artifacts."

step "11/20" "Ensuring postgres is healthy"
docker compose up -d "$POSTGRES_SERVICE"
wait_for_health "$POSTGRES_SERVICE" "$HEALTH_TIMEOUT_SECONDS"
verify_postgres_query
info "Postgres is healthy and accepting queries."

step "12/20" "Validating Prisma schema against committed migrations"
validate_prisma_schema_matches_migrations
validate_pending_migrations_blue_green_safe
info "Prisma schema matches the committed migration history."

step "13/20" "Running Prisma migrations"
docker compose --profile "$MIGRATE_SERVICE" run --rm "$MIGRATE_SERVICE"
verify_prisma_migration_status
info "Prisma migration status reports the database is up to date."

step "14/20" "Starting target web service"
docker compose up -d --force-recreate "$TARGET_SERVICE"
wait_for_health "$TARGET_SERVICE" "$HEALTH_TIMEOUT_SECONDS"
verify_internal_health "$TARGET_SERVICE"
info "Target web service is healthy before cutover."

step "15/20" "Refreshing cron leader on the new release before cutover"
docker compose up -d --force-recreate "$CRON_SERVICE"
wait_for_health "$CRON_SERVICE" "$HEALTH_TIMEOUT_SECONDS"
verify_internal_health "$CRON_SERVICE"
verify_cron_registration
info "Cron leader is healthy and scheduled jobs are registered before cutover."

# The seam #2352 slice 1 left here, filled by #2566. It sits AFTER both web
# instances are healthy and BEFORE the Caddy switch, which is the order the owner's
# decision sets out: migrate, start the target, pass readiness, discover, warm,
# verify the store, evaluate, and only then move traffic. A non-zero return from
# this step propagates through `set -e` and the ERR trap, so the cutover below
# never runs and the old colour keeps serving.
step "16/20" "Warming the new release and verifying its page cache before cutover"
run_warmup_gate

step "17/20" "Switching Caddy upstream to target web service"
docker compose up -d "$CADDY_SERVICE"
PREVIOUS_UPSTREAM_CONTENTS="$(cat "$PROJECT_DIR/$ACTIVE_UPSTREAM_FILE_REL" 2>/dev/null || true)"
write_active_upstream_file "$TARGET_SERVICE" "$CRON_SERVICE"
if ! reload_caddy; then
  restore_previous_upstream_file "$PREVIOUS_UPSTREAM_CONTENTS"
  reload_caddy >/dev/null 2>&1 || true
  echo "Failed to reload Caddy after writing the target upstream." >&2
  exit 1
fi
SWITCHED_TRAFFIC=1
verify_external_health "$TARGET_SERVICE"
verify_internal_health "$TARGET_SERVICE"
EXTERNAL_HEALTH_VERIFIED=1
info "External and direct target readiness checks passed after cutover."
drain_previous_connections "$BLUE_GREEN_DRAIN_SECONDS"

step "18/20" "Removing inactive web service containers"
cleanup_inactive_web_services

step "19/20" "Removing orphan containers"
remove_compose_orphans
info "Removed any orphaned Compose containers."

step "20/20" "Cleaning stale Docker cache after deploy"
prune_stale_docker_assets "after deploy"

# The completion line NAMES the state. A deploy that tolerated a failed public page, or
# skipped the gate, or could not identify the release it warmed, is not the same event
# as a clean one, and an operator reading the last line at 2am must not have to
# remember a warning from four steps ago to know which they got.
if [ -n "$WARMUP_WARNINGS" ]; then
  warn "Blue/green deploy complete WITH WARNINGS. See the summary below."
else
  info "Blue/green deploy complete."
fi

echo
echo "============================================"
echo "  Deploy complete. Current status:"
echo "============================================"
docker compose ps
echo
docker compose logs "$TARGET_SERVICE" --tail 80

# Last, deliberately: after the container table and the application logs, so it is the
# final thing on screen rather than the thing they scrolled past.
print_deploy_warning_summary || true
}

case "${1:-}" in
  --internal-blue-green-deploy)
    shift
    if [ "$#" -ne 0 ]; then
      echo "Unexpected arguments for --internal-blue-green-deploy: $*" >&2
      exit 2
    fi
    run_internal_blue_green_deploy
    ;;
  "")
    run_production_wrapper
    ;;
  *)
    echo "Usage: $0 [--internal-blue-green-deploy]" >&2
    exit 2
    ;;
esac
