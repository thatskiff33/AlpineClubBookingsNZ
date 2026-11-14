#!/usr/bin/env bash
set -Eeuo pipefail

# First Bootstrap's live-site role gate (#4980; ENV-SAFETY 1, #3034;
# INV-CONFIG-003).
#
#   bash scripts/check-environment-role.sh
#
# Run from the repository root, where `.env` lives, before the first
# `docker compose up`. It exits 0 only when `.env` declares
# APP_ENVIRONMENT_ROLE=production, and otherwise exits 1 with the same refusal the
# blue/green deploy prints at step 3, because it IS that check:
# `require_environment_role_env_key` from scripts/lib/environment-role-check.sh,
# which the deploy script sources too. There is deliberately no second copy.
#
# Why First Bootstrap needs it: `.env.example` ships `non-production` (right for a
# laptop), and First Bootstrap starts the live site with plain `docker compose`,
# never through the deploy script. A live site brought up from the template
# unchanged believes it is a copy, so it emails no member and replaces the email
# addresses on the club's real Xero contacts.
#
# Plain bash, no Node or pnpm, because First Bootstrap runs it on a host that has
# neither installed yet. It never reads the hostname, DOMAIN or NEXTAUTH_URL:
# nothing infers the role (INV-CONFIG-003).

ROLE_CHECK_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib"
# shellcheck source=scripts/lib/compose-env-file.sh
. "$ROLE_CHECK_LIB_DIR/compose-env-file.sh"
# shellcheck source=scripts/lib/environment-role-check.sh
. "$ROLE_CHECK_LIB_DIR/environment-role-check.sh"

if [ ! -f .env ]; then
  echo "No .env in $(pwd)." >&2
  echo "Run this from the repository root after 'cp .env.example .env'," >&2
  echo "and set APP_ENVIRONMENT_ROLE=production in it for the club's live site." >&2
  exit 1
fi

require_environment_role_env_key

echo "APP_ENVIRONMENT_ROLE=production: .env declares this installation the club's live site."
