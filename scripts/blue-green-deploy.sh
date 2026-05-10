#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="${PROJECT_DIR:-$HOME/TACBookings}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-180}"
PRUNE_UNTIL="${PRUNE_UNTIL:-12h}"
FORCE_NO_CACHE="${FORCE_NO_CACHE:-0}"
SKIP_APP_IMAGE_BUILD="${SKIP_APP_IMAGE_BUILD:-0}"
BLUE_GREEN_DRAIN_SECONDS="${BLUE_GREEN_DRAIN_SECONDS:-30}"
ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS="${ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS:-0}"
BLUE_GREEN_MIGRATION_OVERRIDE_REASON="${BLUE_GREEN_MIGRATION_OVERRIDE_REASON:-}"
MIGRATION_SAFETY_LEDGER="${MIGRATION_SAFETY_LEDGER:-docs/BLUE_GREEN_MIGRATION_SAFETY.tsv}"
BLUE_GREEN_RUNTIME_STATUS_COOKIE="${BLUE_GREEN_RUNTIME_STATUS_COOKIE:-}"

POSTGRES_SERVICE="postgres"
CRON_SERVICE="app"
CADDY_SERVICE="caddy"
MIGRATE_SERVICE="migrate"
BLUE_SERVICE="app_blue"
GREEN_SERVICE="app_green"
ACTIVE_UPSTREAM_FILE_REL="deploy/caddy/tacbookings-active.caddy"
READINESS_PATH="/api/health/ready"
RUNTIME_STATUS_PATH="/api/admin/runtime-status"

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

require_boolean_env_key() {
  local key="$1"
  local default_value="${2:-}"
  local value

  value="$(trim_whitespace "$(get_env_file_value "$key")")"
  if [ -z "$value" ]; then
    value="$default_value"
  fi

  case "$value" in
    true|false) ;;
    *)
      echo ".env entry must be true or false: $key" >&2
      return 1
      ;;
  esac
}

require_positive_integer_env_key() {
  local key="$1"
  local default_value="${2:-}"
  local value

  value="$(trim_whitespace "$(get_env_file_value "$key")")"
  if [ -z "$value" ]; then
    value="$default_value"
  fi

  if ! printf '%s' "$value" | grep -Eq '^[1-9][0-9]*$'; then
    echo ".env entry must be a positive integer: $key" >&2
    return 1
  fi
}

env_key_is_true() {
  local key="$1"
  local default_value="${2:-false}"
  local value

  value="$(trim_whitespace "$(get_env_file_value "$key")")"
  if [ -z "$value" ]; then
    value="$default_value"
  fi

  [ "$value" = "true" ]
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
  require_non_placeholder_env_key STRIPE_SECRET_KEY
  require_non_placeholder_env_key NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
  require_non_placeholder_env_key STRIPE_WEBHOOK_SECRET
  require_non_placeholder_env_key XERO_CLIENT_ID
  require_non_placeholder_env_key XERO_CLIENT_SECRET
  require_http_url_env_key XERO_REDIRECT_URI
  require_non_placeholder_env_key XERO_ENCRYPTION_KEY
  require_non_placeholder_env_key FINANCE_XERO_CLIENT_ID
  require_non_placeholder_env_key FINANCE_XERO_CLIENT_SECRET
  require_http_url_env_key FINANCE_XERO_REDIRECT_URI
  require_non_placeholder_env_key FINANCE_XERO_ENCRYPTION_KEY
  require_non_placeholder_env_key SMTP_HOST
  require_non_placeholder_env_key SMTP_PORT
  require_non_placeholder_env_key AWS_SES_ACCESS_KEY_ID
  require_non_placeholder_env_key AWS_SES_SECRET_ACCESS_KEY
  require_non_placeholder_env_key SES_SNS_TOPIC_ARN
  require_non_placeholder_env_key EMAIL_FROM
  require_non_placeholder_env_key LEGACY_DASHBOARD_EXPORT_TOKEN
  require_boolean_env_key BACKUP_ENABLED false
  require_positive_integer_env_key BACKUP_RETENTION_DAYS 7

  domain="$(trim_whitespace "$(get_env_file_value DOMAIN)")"
  require_domain_matches_url NEXTAUTH_URL "$domain"
  require_domain_matches_url XERO_REDIRECT_URI "$domain"
  require_domain_matches_url FINANCE_XERO_REDIRECT_URI "$domain"

  if env_key_is_true BACKUP_ENABLED false; then
    require_env_key BACKUP_CRON_SCHEDULE

    if [ -n "$(trim_whitespace "$(get_env_file_value BACKUP_S3_BUCKET)")" ]; then
      require_non_placeholder_env_key BACKUP_S3_BUCKET
      require_non_placeholder_env_key BACKUP_S3_ACCESS_KEY_ID
      require_non_placeholder_env_key BACKUP_S3_SECRET_ACCESS_KEY
    else
      warn "BACKUP_ENABLED=true with no BACKUP_S3_BUCKET. Backups will stay local to the app container."
    fi
  fi
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
  if ! grep -Fq "$domain" Caddyfile; then
    echo "DOMAIN=$domain does not appear in Caddyfile" >&2
    return 1
  fi

  docker run --rm \
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

build_images() {
  local cron_image_ref
  local target_image_ref
  local migrate_image_ref

  if [ "$SKIP_APP_IMAGE_BUILD" = "1" ]; then
    cron_image_ref="$(get_service_image_ref "$CRON_SERVICE")"
    target_image_ref="$(get_service_image_ref "$TARGET_SERVICE")"
    migrate_image_ref="$(get_service_image_ref "$MIGRATE_SERVICE")"
    info "Skipping app image build because SKIP_APP_IMAGE_BUILD=1."
    info "Reusing images: ${cron_image_ref}, ${target_image_ref}, ${migrate_image_ref}"
    return 0
  fi

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
  image_ref="${project_name}-${service}:latest"
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

  if env_key_is_true BACKUP_ENABLED false; then
    docker run --rm --entrypoint sh "$app_image_ref" -lc 'command -v pg_dump >/dev/null' >/dev/null || {
      echo "BACKUP_ENABLED=true but the app image does not contain pg_dump" >&2
      return 1
    }

    if [ -n "$(trim_whitespace "$(get_env_file_value BACKUP_S3_BUCKET)")" ]; then
      docker run --rm --entrypoint sh "$app_image_ref" -lc 'command -v aws >/dev/null' >/dev/null || {
        echo "BACKUP_S3_BUCKET is set but the app image does not contain the AWS CLI" >&2
        return 1
      }
    fi
  fi
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
      --to-schema-datamodel prisma/schema.prisma \
      --shadow-database-url "$shadow_database_url" 2>&1
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

  if [ -n "$expected_role" ] && ! printf '%s' "$payload" | grep -q "\"role\":\"${expected_role}\""; then
    echo "$source runtime payload did not report role=${expected_role}: $payload" >&2
    return 1
  fi

  if [ -n "$expected_cron_enabled" ] && ! printf '%s' "$payload" | grep -q "\"cronEnabled\":${expected_cron_enabled}"; then
    echo "$source runtime payload did not report cronEnabled=${expected_cron_enabled}: $payload" >&2
    return 1
  fi
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

  docker compose exec -T "$service" /bin/sh -lc '
role="${APP_RUNTIME_ROLE:-unknown}"
cron_enabled="${CRON_ENABLED:-true}"
case "$cron_enabled" in
  true|TRUE|1|yes|YES|on|ON) cron_json=true ;;
  *) cron_json=false ;;
esac
printf "{\"role\":\"%s\",\"cronEnabled\":%s}\n" "$role" "$cron_json"
'
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
  assert_runtime_identity "Internal ${service}" "$runtime_payload" "$expected_role" "$expected_cron_enabled"
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

  if [ -n "$BLUE_GREEN_RUNTIME_STATUS_COOKIE" ]; then
    runtime_url="https://${domain}${RUNTIME_STATUS_PATH}"
    runtime_payload="$(curl -fsS -H "Cookie: ${BLUE_GREEN_RUNTIME_STATUS_COOKIE}" "$runtime_url")"
    assert_runtime_identity "External runtime status" "$runtime_payload" "$expected_role" "$expected_cron_enabled"
  else
    warn "Skipping external runtime identity check because BLUE_GREEN_RUNTIME_STATUS_COOKIE is not set; public readiness no longer exposes deployment topology."
  fi
}

verify_cron_registration() {
  local logs=""
  local pattern
  local missing=""
  local waited=0
  local timeout="${CRON_REGISTRATION_TIMEOUT_SECONDS:-60}"
  local patterns=(
    "Scheduled pending booking confirmation"
    "Scheduled daily finance sync"
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
    "Scheduled waitlist processor"
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
    "Xero membership refresh registration" \
    "Scheduled Xero membership refresh" \
    "Xero membership refresh disabled by XERO_ENABLE_DAILY_MEMBERSHIP_REFRESH"
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
echo "  TACBookings: Blue/Green Deploy Script"
echo "============================================"

cd "$PROJECT_DIR"

ACTIVE_SERVICE="$(get_active_service)"
TARGET_SERVICE="$(choose_target_service "$ACTIVE_SERVICE")"

step "1/19" "Refreshing code (if appropriate)"
maybe_pull_latest

step "2/19" "Validating host deployment prerequisites"
validate_host_contract
info "Host has the required deployment commands."

step "3/19" "Validating deployment environment contract"
validate_env_contract
info ".env contains the required production settings."

step "4/19" "Validating repository deployment files"
validate_repo_contract
validate_caddy_contract
info "Docker, Prisma, and Caddy config files are present and valid."

step "5/19" "Validating Docker Compose configuration"
docker compose config -q
info "docker compose config is valid."

step "6/19" "Selecting target web service"
info "Current live upstream: ${ACTIVE_SERVICE}"
info "Target web service: ${TARGET_SERVICE}"

step "7/19" "Pruning stale Docker cache before build"
prune_stale_docker_assets "before build"

step "8/19" "Pulling infrastructure images"
docker compose pull "$POSTGRES_SERVICE" "$CADDY_SERVICE"

step "9/19" "Building app, target web, and migration images"
build_images

step "10/19" "Validating built runtime image contract"
validate_runtime_image_contract
info "Built app image contains the expected runtime artifacts."

step "11/19" "Ensuring postgres is healthy"
docker compose up -d "$POSTGRES_SERVICE"
wait_for_health "$POSTGRES_SERVICE" "$HEALTH_TIMEOUT_SECONDS"
verify_postgres_query
info "Postgres is healthy and accepting queries."

step "12/19" "Validating Prisma schema against committed migrations"
validate_prisma_schema_matches_migrations
validate_pending_migrations_blue_green_safe
info "Prisma schema matches the committed migration history."

step "13/19" "Running Prisma migrations"
docker compose --profile "$MIGRATE_SERVICE" run --rm "$MIGRATE_SERVICE"
verify_prisma_migration_status
info "Prisma migration status reports the database is up to date."

step "14/19" "Starting target web service"
docker compose up -d --force-recreate "$TARGET_SERVICE"
wait_for_health "$TARGET_SERVICE" "$HEALTH_TIMEOUT_SECONDS"
verify_internal_health "$TARGET_SERVICE"
info "Target web service is healthy before cutover."

step "15/19" "Refreshing cron leader on the new release before cutover"
docker compose up -d --force-recreate "$CRON_SERVICE"
wait_for_health "$CRON_SERVICE" "$HEALTH_TIMEOUT_SECONDS"
verify_internal_health "$CRON_SERVICE"
verify_cron_registration
info "Cron leader is healthy and scheduled jobs are registered before cutover."

step "16/19" "Switching Caddy upstream to target web service"
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

step "17/19" "Removing inactive web service containers"
cleanup_inactive_web_services

step "18/19" "Removing orphan containers"
remove_compose_orphans
info "Removed any orphaned Compose containers."

step "19/19" "Cleaning stale Docker cache after deploy"
prune_stale_docker_assets "after deploy"
info "Blue/green deploy complete."

echo
echo "============================================"
echo "  Deploy complete. Current status:"
echo "============================================"
docker compose ps
echo
docker compose logs "$TARGET_SERVICE" --tail 80
