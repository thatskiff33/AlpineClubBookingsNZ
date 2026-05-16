#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Phase 9 repository split helper.

This script prepares the private deployment fork and the public-bound overlay
removal. It refuses to run unless called with:

  bash scripts/phase-9-split.sh --execute

Environment overrides:
  PUBLIC_REPO_DIR=/home/ubuntu/TACBookings
  PRIVATE_REPO=thatskiff33/TACBookings-tokoroa
  PRIVATE_REPO_DIR=/home/ubuntu/TACBookings-tokoroa
  BACKUP_DIR=/home/ubuntu/TACBookings.backup-pre-split
  PUBLIC_BRANCH=main
USAGE
}

if [[ "${1:-}" != "--execute" ]]; then
  usage
  exit 64
fi

PUBLIC_REPO_DIR="${PUBLIC_REPO_DIR:-/home/ubuntu/TACBookings}"
PRIVATE_REPO="${PRIVATE_REPO:-thatskiff33/TACBookings-tokoroa}"
PRIVATE_REPO_DIR="${PRIVATE_REPO_DIR:-/home/ubuntu/TACBookings-tokoroa}"
BACKUP_DIR="${BACKUP_DIR:-/home/ubuntu/TACBookings.backup-pre-split}"
PUBLIC_BRANCH="${PUBLIC_BRANCH:-main}"
PRIVATE_REMOTE_URL="${PRIVATE_REMOTE_URL:-}"

OVERLAY_FILES=(
  "config/club.json"
  "config/features.json"
  "public/branding/favicon.ico"
  "public/branding/favicon.png"
  "public/branding/logo.png"
  "public/branding/og-image.png"
  "public/branding/lodge.jpg"
  "public/branding/ski-field.jpg"
  "public/branding/snowboarder.jpg"
  "public/branding/sunset.jpg"
)

OVERLAY_DIRS=(
  "seeds/tokoroa"
)

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

run() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
  "$@"
}

append_ignore_entry() {
  local entry="$1"
  if ! grep -Fxq "$entry" "$PUBLIC_REPO_DIR/.gitignore"; then
    printf '%s\n' "$entry" >>"$PUBLIC_REPO_DIR/.gitignore"
  fi
}

need_cmd git
need_cmd gh
need_cmd npm
need_cmd cp
need_cmd du
need_cmd df
need_cmd awk

git -C "$PUBLIC_REPO_DIR" rev-parse --git-dir >/dev/null 2>&1 || fail "PUBLIC_REPO_DIR is not a Git repository: $PUBLIC_REPO_DIR"
[[ ! -e "$BACKUP_DIR" ]] || fail "Backup path already exists: $BACKUP_DIR"
[[ ! -e "$PRIVATE_REPO_DIR" ]] || fail "Private repo dir already exists: $PRIVATE_REPO_DIR"

current_branch="$(git -C "$PUBLIC_REPO_DIR" branch --show-current)"
[[ "$current_branch" == "$PUBLIC_BRANCH" ]] || fail "Expected $PUBLIC_REPO_DIR on $PUBLIC_BRANCH, got $current_branch"

git -C "$PUBLIC_REPO_DIR" fetch origin "$PUBLIC_BRANCH"
local_head="$(git -C "$PUBLIC_REPO_DIR" rev-parse "$PUBLIC_BRANCH")"
origin_head="$(git -C "$PUBLIC_REPO_DIR" rev-parse "origin/$PUBLIC_BRANCH")"
[[ "$local_head" == "$origin_head" ]] || fail "$PUBLIC_BRANCH is not up to date with origin/$PUBLIC_BRANCH"
[[ -z "$(git -C "$PUBLIC_REPO_DIR" status --porcelain)" ]] || fail "Public checkout has uncommitted changes"

if gh repo view "$PRIVATE_REPO" >/dev/null 2>&1; then
  fail "Private repository already exists: $PRIVATE_REPO"
fi

source_kb="$(du -sk "$PUBLIC_REPO_DIR" | awk '{print $1}')"
available_kb="$(df -Pk "$(dirname "$BACKUP_DIR")" | awk 'NR == 2 {print $4}')"
buffer_kb=$((1024 * 1024))
if (( available_kb < source_kb + buffer_kb )); then
  fail "Not enough free disk for backup. Need at least $((source_kb + buffer_kb)) KB, available $available_kb KB"
fi

printf 'Creating backup at %s\n' "$BACKUP_DIR"
run cp -a "$PUBLIC_REPO_DIR" "$BACKUP_DIR"

public_remote_url="$(git -C "$PUBLIC_REPO_DIR" remote get-url origin)"
if [[ -z "$PRIVATE_REMOTE_URL" ]]; then
  if [[ "$public_remote_url" == git@github.com:* ]]; then
    PRIVATE_REMOTE_URL="git@github.com:${PRIVATE_REPO}.git"
  else
    PRIVATE_REMOTE_URL="https://github.com/${PRIVATE_REPO}.git"
  fi
fi

printf 'Creating private repository %s\n' "$PRIVATE_REPO"
run gh repo create "$PRIVATE_REPO" --private --description "Private deployment fork for TACBookings"

printf 'Cloning public repository into private deployment directory\n'
run git clone "$public_remote_url" "$PRIVATE_REPO_DIR"
run git -C "$PRIVATE_REPO_DIR" remote rename origin upstream
run git -C "$PRIVATE_REPO_DIR" remote add origin "$PRIVATE_REMOTE_URL"
run git -C "$PRIVATE_REPO_DIR" push -u origin "$PUBLIC_BRANCH"

printf 'Removing private overlay from public tracking while keeping files locally\n'
existing_overlay=()
for path in "${OVERLAY_FILES[@]}"; do
  if git -C "$PUBLIC_REPO_DIR" ls-files --error-unmatch "$path" >/dev/null 2>&1; then
    existing_overlay+=("$path")
  fi
done

for path in "${OVERLAY_DIRS[@]}"; do
  if git -C "$PUBLIC_REPO_DIR" ls-files "$path" | grep -q .; then
    existing_overlay+=("$path")
  fi
done

if (( ${#existing_overlay[@]} > 0 )); then
  run git -C "$PUBLIC_REPO_DIR" rm --cached -r -- "${existing_overlay[@]}"
fi

append_ignore_entry ""
append_ignore_entry "# Private deployment overlay"
append_ignore_entry "/config/club.json"
append_ignore_entry "/config/features.json"
append_ignore_entry "/public/branding/favicon.ico"
append_ignore_entry "/public/branding/favicon.png"
append_ignore_entry "/public/branding/logo.png"
append_ignore_entry "/public/branding/og-image.png"
append_ignore_entry "/public/branding/lodge.jpg"
append_ignore_entry "/public/branding/ski-field.jpg"
append_ignore_entry "/public/branding/snowboarder.jpg"
append_ignore_entry "/public/branding/sunset.jpg"
append_ignore_entry "/seeds/tokoroa/"

printf '\nPublic repository status after overlay removal:\n'
git -C "$PUBLIC_REPO_DIR" status --short

cat <<'NEXT_STEPS'

Next steps for the human operator:
1. Review the public repository diff.
2. Commit the overlay removal on a reviewable branch or through the protected
   main process.
3. In the private fork, run:
     git fetch upstream main
     git pull upstream main
     npm ci
     npx prisma generate
     npm run lint
     DATABASE_URL="postgresql://user:pass@localhost:5432/tacbookings" npx prisma validate
     npm test
     npm run build
4. Confirm private config and branding still exist in the private fork.
5. Deploy from the private fork only during an approved deployment window.
NEXT_STEPS
