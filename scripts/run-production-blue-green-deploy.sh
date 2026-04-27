#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_REPO="${SOURCE_REPO:-$HOME/TACBookings}"
DEPLOY_REF="${DEPLOY_REF:-origin/main}"
FETCH_LATEST="${FETCH_LATEST:-1}"
DEPLOY_WORKSPACE_ROOT="${DEPLOY_WORKSPACE_ROOT:-$HOME/tacbookings-deployments}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-$(basename "$SOURCE_REPO" | tr '[:upper:]' '[:lower:]')}"
SYNC_SOURCE_REPO_AFTER_DEPLOY="${SYNC_SOURCE_REPO_AFTER_DEPLOY:-1}"
PRUNE_STALE_DEPLOY_WORKSPACES="${PRUNE_STALE_DEPLOY_WORKSPACES:-1}"

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
    ./scripts/blue-green-deploy.sh
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
echo "  TACBookings: Production Blue/Green Deploy Wrapper"
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

step "3/8" "Resolving deploy commit"
resolve_ref

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
