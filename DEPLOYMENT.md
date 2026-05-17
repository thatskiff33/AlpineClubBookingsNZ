# Deployment Reference

This guide describes the AlpineClubBookingsNZ production deployment shape. It is a
reference for operators adapting the project to their own infrastructure.

Do not reuse another club's credentials, domains, payment accounts, accounting
tenants, email identities, Sentry projects, or database backups in a fork.
Create your own service accounts and secrets.

## Target Architecture

- Ubuntu 24.04 host with Docker and Docker Compose
- Caddy reverse proxy on ports 80 and 443
- PostgreSQL 16 in Docker
- Next.js app and migration images built by GitHub Actions and pulled from GHCR
- Optional S3-compatible storage for PostgreSQL backups
- Stripe, Xero, SES, and Sentry configured through environment variables

Production Compose services:

- `postgres` - database
- `app` - cron leader and warm fallback web upstream
- `app_blue` / `app_green` - web-only blue/green slots
- `caddy` - public reverse proxy and health-aware upstream routing
- `migrate` - explicit Prisma migration runner

## Prerequisites

- A host sized for your traffic and runtime memory needs
- DNS control for your deployment domain
- Docker and Docker Compose installed
- GHCR read access for private image packages, unless the image packages are
  public
- A PostgreSQL backup and restore plan
- Stripe live or test account, depending on environment
- Xero app or demo tenant, depending on environment
- SES or another SMTP-compatible transactional email service
- Sentry project, if source maps and runtime error reporting are desired

## Environment

Start from `.env.example` and the configuration reference:

```bash
cp .env.example .env
```

See `CONFIGURATION.md` for every supported environment variable and
`config/club.json` field.

Generate unique secrets:

```bash
openssl rand -base64 48   # AUTH_SECRET and NEXTAUTH_SECRET
openssl rand -base64 24   # CRON_SECRET
openssl rand -base64 24   # DB_PASSWORD
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

The Node command produces a 64-character hex key suitable for Xero token
encryption variables.

Minimum production categories:

- Database: `DATABASE_URL`, `DB_PASSWORD`
- Auth: `AUTH_SECRET`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `AUTH_TRUST_HOST`
- Public app: `DOMAIN`, `NEXT_PUBLIC_CONTACT_EMAIL`
  `DOMAIN` is the root public host consumed by `Caddyfile` through the
  `{$DOMAIN}` placeholder. Caddy derives `www`, `bookings`, `dashboard`, and
  `xero-mcp` subdomains from that value.
- Feature flags: `FEATURE_KIOSK`, `FEATURE_CHORES`,
  `FEATURE_FINANCE_DASHBOARD`, `FEATURE_WAITLIST`, and
  `FEATURE_XERO_INTEGRATION` must be explicit `true` or `false` values.
- Stripe: `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`,
  `STRIPE_WEBHOOK_SECRET`
- Operational Xero: `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`,
  `XERO_REDIRECT_URI`, `XERO_ENCRYPTION_KEY`, optional `XERO_WEBHOOK_KEY`
- Finance Xero: `FINANCE_XERO_CLIENT_ID`, `FINANCE_XERO_CLIENT_SECRET`,
  `FINANCE_XERO_REDIRECT_URI`, `FINANCE_XERO_ENCRYPTION_KEY`
- Email: `SMTP_HOST`, `SMTP_PORT`, `AWS_SES_ACCESS_KEY_ID`,
  `AWS_SES_SECRET_ACCESS_KEY`, `EMAIL_FROM`, `SES_SNS_TOPIC_ARN`
- Cron and backups: `CRON_SECRET`, `BACKUP_*`, optional
  `AUDIT_ARCHIVE_DATABASE_URL`
- Admin health: optional `CRON_LEADER_RUNTIME_STATUS_URL` when the cron leader
  is not reachable from web containers at
  `http://app:3000/api/deploy/runtime-status`
- Observability: `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ORG`,
  `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN`

Do not commit `.env` files or production secrets.

## GitHub Container Registry

GitHub Actions publishes production images after CI passes on `main`:

```text
ghcr.io/<owner>/tacbookings-app:<commit-sha>
ghcr.io/<owner>/tacbookings-migrate:<commit-sha>
```

If those packages are private, log in to GHCR once on the production host as
the same Linux user that runs deployments. Use a token with only
`read:packages` access:

```bash
echo "$GHCR_READ_TOKEN" | docker login ghcr.io -u <owner> --password-stdin
```

Do not store that token in the repository or `.env`.

## First Bootstrap

From the target host:

```bash
git clone https://github.com/<owner>/AlpineClubBookingsNZ.git AlpineClubBookingsNZ
cd AlpineClubBookingsNZ
cp .env.example .env
cp config/club.example.json config/club.json
# edit .env with your own values
# edit config/club.json with your club identity, beds, and rates
docker compose up -d --build postgres
docker compose run --rm migrate
docker compose up -d --build app app_blue app_green caddy
docker compose ps
```

Create or seed accounts only for the intended environment. The demo seed admin
from `prisma/seed.ts` is controlled by `SEED_ADMIN_EMAIL` and
`SEED_ADMIN_PASSWORD`; it is for local and staging use and must be changed
before any shared environment is exposed.

## Routine Production Deploy

The supported AlpineClubBookingsNZ deploy path is:

```bash
./scripts/run-production-blue-green-deploy.sh
```

The wrapper snapshots the resolved `origin/main` commit into a clean deployment
workspace, selects the matching GHCR image tags, copies the environment file,
preserves Caddy upstream state, runs the blue/green deployment, then
fast-forwards the clean checkout after success.

For a fork, set `GHCR_APP_IMAGE_REPOSITORY` and
`GHCR_MIGRATE_IMAGE_REPOSITORY` if your image names differ from the defaults.

The low-level deployment runner:

- pulls the app and migration images for the resolved commit SHA
- skips local Docker builds when `APP_IMAGE` and `MIGRATE_IMAGE` are supplied
- validates pending migrations against the blue/green migration policy
- runs Prisma migrations through the `migrate` service
- starts the inactive color slot with `CRON_ENABLED=false`
- waits for `/api/health/ready`
- updates Caddy upstream routing
- verifies the public domain is serving the target runtime through
  `/api/deploy/runtime-status`, authenticated with the existing `CRON_SECRET`
  as the `x-cron-secret` header
- drains the previous slot

If `APP_IMAGE` and `MIGRATE_IMAGE` are not supplied, the low-level runner keeps
the old local-build path for bootstrap, staging, and recovery work.

## Migration Safety

Read `docs/BLUE_GREEN_MIGRATION_POLICY.md` before deploying schema changes.
Migrations must be compatible with old and new app versions during cutover.

Potentially breaking migrations require explicit operator acknowledgement with:

```bash
ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1
BLUE_GREEN_MIGRATION_OVERRIDE_REASON="..."
```

Use this only with a written rollback and lock-impact plan.

## Staging

Use staging for browser checks, accessibility review, and integration rehearsal.

```bash
cp .env.staging.example .env.staging
docker compose --env-file .env.staging -p tacbookings-staging \
  -f docker-compose.yml -f docker-compose.staging.yml up -d --build postgres app
docker compose --env-file .env.staging -p tacbookings-staging \
  -f docker-compose.yml -f docker-compose.staging.yml run --rm migrate
```

See `docs/STAGING_ACCESSIBILITY.md` for route coverage and Lighthouse guidance.
Use Stripe test mode, Xero demo credentials, non-production email settings, and
synthetic data.

## Backups

The app can run scheduled PostgreSQL dumps to S3-compatible storage when
`BACKUP_ENABLED=true`. Configure:

- `BACKUP_S3_BUCKET`
- `BACKUP_S3_REGION`
- `BACKUP_S3_ACCESS_KEY_ID`
- `BACKUP_S3_SECRET_ACCESS_KEY`
- `BACKUP_RETENTION_DAYS`
- `BACKUP_CRON_SCHEDULE`
- optional `BACKUP_RESTORE_VALIDATION_URL`

Operators should also keep provider-level snapshots or equivalent independent
backups. Test restore procedures before relying on backups.

## Webhooks

Configure webhook endpoints for the deployed domain:

- Stripe: `/api/webhooks/stripe`
- Xero: `/api/webhooks/xero`
- SES SNS: `/api/webhooks/ses-sns`

Keep webhook secrets in `.env`. Rotate them if they are exposed.

## Health Checks

Use these endpoints for smoke tests and load-balancer readiness:

```bash
curl -fsS https://your-domain.example/api/health
curl -fsS https://your-domain.example/api/health/ready
```

`/api/health/ready` is the readiness endpoint used by blue/green cutover.

## Rollback

Preferred rollback is to route Caddy back to the previous healthy color while it
is still running. If schema changes have already applied, rollback must respect
the migration policy and any compatibility constraints in the migration PR.

Keep deploy logs, the target commit SHA, migration output, and health-check
results with the release record.
