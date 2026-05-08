#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${STAGING_APP_URL:-}"
PATHS="${STAGING_A11Y_PATHS:-/,/login,/register,/forgot-password,/faq,/contact}"
OUT_DIR="${STAGING_A11Y_OUT_DIR:-reports/lighthouse/staging}"
LIGHTHOUSE_BIN="${LIGHTHOUSE_BIN:-}"

if [ -z "$BASE_URL" ]; then
  echo "STAGING_APP_URL is required, for example https://staging.tokoroa.org.nz" >&2
  exit 1
fi

case "$BASE_URL" in
  http://*|https://*) ;;
  *)
    echo "STAGING_APP_URL must start with http:// or https://" >&2
    exit 1
    ;;
esac

case "$BASE_URL" in
  http://tokoroa.org.nz*|https://tokoroa.org.nz*|http://www.tokoroa.org.nz*|https://www.tokoroa.org.nz*)
    echo "Refusing to run staging accessibility checks against production: $BASE_URL" >&2
    exit 1
    ;;
esac

if [ -z "$LIGHTHOUSE_BIN" ]; then
  if command -v lighthouse >/dev/null 2>&1; then
    LIGHTHOUSE_BIN="lighthouse"
  else
    LIGHTHOUSE_BIN="npx --yes lighthouse@12"
  fi
fi

mkdir -p "$OUT_DIR"

IFS=',' read -r -a path_items <<< "$PATHS"
for raw_path in "${path_items[@]}"; do
  path="$(printf '%s' "$raw_path" | xargs)"
  [ -n "$path" ] || continue

  case "$path" in
    /*) url="${BASE_URL%/}${path}" ;;
    http://*|https://*) url="$path" ;;
    *) url="${BASE_URL%/}/$path" ;;
  esac

  slug="$(printf '%s' "$url" | sed -E 's#^https?://##; s#[^A-Za-z0-9._-]+#-#g; s#^-+|-+$##g')"
  echo "Running Lighthouse accessibility check for $url"
  # shellcheck disable=SC2086
  $LIGHTHOUSE_BIN "$url" \
    --only-categories=accessibility \
    --chrome-flags="--headless=new --no-sandbox" \
    --output=html \
    --output=json \
    --output-path="$OUT_DIR/$slug" \
    --quiet
done

echo "Lighthouse reports written to $OUT_DIR"
