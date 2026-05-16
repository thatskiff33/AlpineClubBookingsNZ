# TACBookings

TACBookings is the Tokoroa Alpine Club booking, membership, payment, lodge, and
finance platform. It is published as a real-world reference implementation for
a small club running a production Next.js application with payments,
accounting, email, scheduled jobs, and Docker-based deployment.

The code is MIT licensed. Tokoroa Alpine Club branding, logos, copy, domains,
and operational content are included for context only; replace them before
using a fork for another organisation. See `NOTICE.md`.

## What It Does

- Member registration, profile management, family/dependent relationships, and
  membership nomination workflows
- Bed-capacity booking flow with date-only New Zealand lodge nights, waitlist,
  non-member holds, booking changes, cancellation rules, refunds, credits,
  promo codes, and Stripe payments
- Admin tools for members, bookings, payments, seasons, policies, reports,
  email, audit logs, issue reports, waitlist, lodge, and hut leaders
- Lodge kiosk with PIN access, arrivals/departures, chores, and issue reporting
- Xero integrations for operational accounting plus a separate finance Xero
  boundary and finance reports
- AWS SES email, SES SNS suppression feedback, Sentry/pino observability, cron
  jobs, PostgreSQL backups, and blue/green Docker deployment

## Stack

- Next.js 16 App Router, React 19, TypeScript
- PostgreSQL 16 and Prisma 6
- Auth.js / NextAuth credentials sessions
- Stripe PaymentIntents, SetupIntents, and webhooks
- Xero OAuth, webhooks, retry queues, local caches, and metering
- AWS SES email and S3 backup storage
- Tailwind CSS, Radix UI, Recharts, Vitest, ESLint
- Docker Compose and Caddy for production-style deployment

## Requirements

- Node.js 24 LTS
- npm 11 or newer
- Docker and Docker Compose for local PostgreSQL or production-style runs

## Fresh Clone Setup

```bash
git clone https://github.com/thatskiff33/TACBookings.git
cd TACBookings
cp .env.example .env
npm ci
npx prisma generate
```

Edit `.env` before running the app. For a local database-backed setup, set at
least `DATABASE_URL`, `DB_PASSWORD`, `AUTH_SECRET`, `NEXTAUTH_SECRET`,
`NEXTAUTH_URL`, and `CRON_SECRET`. External integrations can use test/demo
credentials or remain blank unless the feature under test requires them.

Start PostgreSQL, apply migrations, and seed local data:

```bash
docker compose up -d postgres
npm run db:migrate
npm run db:seed
```

The seed data includes a local admin account:

```text
support@tokoroa.org.nz / admin123
```

Change that password immediately in any shared or persistent environment.

Start the app only in local or non-production environments:

```bash
npm run dev
```

## Daily Commands

```bash
npm audit --audit-level=high
npm run lint
DATABASE_URL=postgresql://user:pass@localhost:5432/tacbookings npx prisma validate
npm test
npm run build
```

This repository uses a current Next.js version. Before changing framework APIs,
read the relevant versioned guide in `node_modules/next/dist/docs/`.

## Docker

Build the production image locally:

```bash
docker build -t tacbookings:local .
```

Run the full Compose stack for production-style testing:

```bash
docker compose up -d --build
docker compose run --rm migrate
docker compose ps
```

For accessibility or release-review checks, use the non-production staging
target:

```bash
cp .env.staging.example .env.staging
docker compose --env-file .env.staging -p tacbookings-staging \
  -f docker-compose.yml -f docker-compose.staging.yml up -d --build postgres app
```

See `docs/STAGING_ACCESSIBILITY.md` for the staging URL, auth path, and
Lighthouse workflow.

## Deployment

Production deployment is documented as a reference in `DEPLOYMENT.md`.
The supported TACBookings deployment path uses the blue/green wrapper:

```bash
./scripts/run-production-blue-green-deploy.sh
```

On `main`, GitHub Actions builds and publishes the app and migration images to
GHCR with commit-SHA tags. The production wrapper resolves `origin/main`, pulls
those exact images, runs migrations, and switches Caddy after health checks
pass.

Do not use live Stripe, Xero, SES, Sentry, or production database credentials in
forks or public CI. Configure your own service accounts and secrets.

## Documentation

- `docs/ARCHITECTURE.md` - system structure, data model, business logic,
  integrations, cron, and deployment shape
- `DEPLOYMENT.md` - reference Lightsail, Docker Compose, Caddy, blue/green, and
  recovery guide
- `docs/MAINTENANCE.md` - public maintenance, validation, CI, and release
  checklist
- `docs/STAGING_ACCESSIBILITY.md` - non-production staging and accessibility
  verification workflow
- `docs/BLUE_GREEN_MIGRATION_POLICY.md` - migration safety policy for
  blue/green deploys
- `docs/AUDIT_RETENTION_ARCHIVE_RUNBOOK.md` - audit-log retention and optional
  archive database behaviour
- `docs/finance-dashboard/README.md` - finance reporting architecture and
  contract index

## Contributing and Security

Read `CONTRIBUTING.md` before opening a PR. Report suspected vulnerabilities
privately using `SECURITY.md`; do not post secrets, personal data, payment
details, or accounting records in public issues.
