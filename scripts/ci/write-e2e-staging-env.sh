#!/usr/bin/env bash
# Writes the `.env.staging` file every CI job that drives the E2E compose stack
# needs, and refuses to write one carrying a live Stripe key.
#
# ONE HOME, because there are now three callers (`e2e.yml` → `playwright` and
# `multi-lodge`, and `e2e-rollover-proof.yml`) and the file they need is
# identical in every value. It used to be a copied heredoc per job; the two
# copies were byte-identical in their values and had already drifted in their
# comments, which is how the next difference would have gone unnoticed
# (`INV-SSOT`). A `.env` for a test stack is exactly the kind of thing where one
# job quietly gains a variable and another does not, and the symptom is a spec
# failing in one workflow and passing in the other.
#
# Inputs, both optional, from the environment:
#   STRIPE_TEST_SECRET_KEY / STRIPE_TEST_PUBLISHABLE_KEY — genuine Stripe
#   *test-mode* keys. Absent, placeholders are written and the payment specs
#   skip themselves. A live key is refused rather than written.
#
# Usage: bash scripts/ci/write-e2e-staging-env.sh [output-path]
set -euo pipefail

cd "$(dirname "$0")/../.."

OUT="${1:-.env.staging}"

STRIPE_SK="${STRIPE_TEST_SECRET_KEY:-sk_test_e2e_placeholder}"
STRIPE_PK="${STRIPE_TEST_PUBLISHABLE_KEY:-pk_test_e2e_placeholder}"
case "$STRIPE_SK" in sk_live*) echo "Live Stripe key in secrets — refusing" >&2; exit 1;; esac
case "$STRIPE_PK" in pk_live*) echo "Live Stripe key in secrets — refusing" >&2; exit 1;; esac

cat > "$OUT" <<EOF
STAGING_HTTP_PORT=3001
STAGING_POSTGRES_PORT=5433
# Declare the stack a copy (ENV-SAFETY 1 #3034, epic #2986). The
# docker-compose.staging.yml \`app\` service hard-codes non-production, so this
# line is not what keeps the suite off the UNKNOWN fail-closed path — the
# override is. It is here because the BASE compose file passes
# \${APP_ENVIRONMENT_ROLE} through with no default, and an unset variable makes
# Compose emit four "variable is not set" warnings on every invocation
# (measured). A workflow log full of warnings that mean nothing is how a warning
# that means something gets missed.
APP_ENVIRONMENT_ROLE=non-production
NEXTAUTH_URL=http://localhost:3001
AUTH_TRUST_HOST=true
DB_PASSWORD=e2e-ci-db-password
AUTH_SECRET=e2e-ci-auth-secret-0123456789abcdef0123456789abcdef
NEXTAUTH_SECRET=e2e-ci-auth-secret-0123456789abcdef0123456789abcdef
SEED_ADMIN_EMAIL=e2e-admin@example.org
SEED_ADMIN_PASSWORD=e2e-ci-seed-password
SEED_LODGE_PASSWORD=e2e-ci-lodge-password
# Stamp the club theme completed so the public site renders its real
# header/footer/title chrome (not the "getting ready" holding page); the
# club-identity smoke spec asserts on that public chrome. Inert for the
# multi-lodge project, which runs no such spec — and kept identical anyway,
# because a stack that differs between jobs is a stack nobody can reason about.
SEED_THEME_COMPLETE=1
STRIPE_SECRET_KEY=$STRIPE_SK
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=$STRIPE_PK
STRIPE_WEBHOOK_SECRET=whsec_e2e_placeholder
XERO_ENABLE_DAILY_MEMBERSHIP_REFRESH=false
XERO_ENABLE_LIVE_MEMBER_GROUP_LOOKUPS=false
XERO_ENABLE_AUTOLOAD_XERO_CONTACT_GROUPS=false
SMTP_PORT=587
# Route outbound mail to the mailpit SMTP capture container (defined in
# docker-compose.staging.yml) so the email-code two-factor spec can read the code
# back over its HTTP API. USE_AWS_SES must be false so exactly one provider flag
# is set, and all four SMTP_RELAY vars must be present or every send throws.
USE_AWS_SES=false
USE_SMTP_RELAY=false
# ENV-SAFETY 2 (#3035): a non-production installation suppresses every send
# unless its transport is DECLARED to be a capture mailbox, so this flag — not
# USE_SMTP_RELAY — is what lets mailpit see anything at all.
USE_LOCAL_CAPTURE=true
EMAIL_SERVER_HOST=mailpit
EMAIL_SERVER_PORT=1025
EMAIL_SERVER_USER=e2e
EMAIL_SERVER_PASSWORD=e2e
MAILPIT_HTTP_PORT=8025
EMAIL_FROM=e2e@example.org
XERO_MOCK_API_ORIGIN=http://localhost:3001
XERO_MOCK_INTERNAL_ORIGIN=http://127.0.0.1:3000
CRON_SECRET=e2e-ci-cron-secret
CRON_ENABLED=false
LOG_LEVEL=info
EOF

echo "Wrote $OUT"
