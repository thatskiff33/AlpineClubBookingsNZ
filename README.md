# AlpineClubBookingsNZ

AlpineClubBookingsNZ is an open-source booking, membership, payment, lodge, and finance
platform for small clubs. It is published as a real-world reference
implementation for a production Next.js application with payments, accounting,
email, scheduled jobs, and Docker-based deployment.

AlpineClubBookingsNZ is the open-source booking system originally built for and deployed
at [Tokoroa Alpine Club](https://tokoroa.org.nz).

The code is MIT licensed. Project branding, logos, copy, domains, and
operational content are included for context only; replace them before using a
fork for another organisation. See `NOTICE.md`.

## What It Does

- Member registration, profile management, family/dependent relationships, and
  membership nomination workflows
- Bed-capacity booking flow with date-only New Zealand lodge nights, per-guest
  stay ranges, waitlist, non-member holds, booking changes, cancellation rules,
  refunds, credits, promo codes, Stripe payments, and Xero-backed Internet
  Banking invoice payments
- Admin tools for members, CSV import, bookings, bed allocation, payments,
  seasons, policies, reports, email, audit logs, issue reports, waitlist,
  lodge, Xero operations, and hut leaders
- Admin-editable public website pages with sanitised HTML content, embed
  tokens for interactive sections, and a menu generated from page settings
  (see `CONFIGURATION.md`, "Website Page Content")
- Lodge kiosk with PIN access, arrivals/departures, chores, and issue reporting
- Xero integrations for operational accounting plus a separate finance Xero
  boundary and finance reports
- AWS SES email, SES SNS suppression feedback, Sentry/pino observability, cron
  jobs, PostgreSQL backups, and blue/green Docker deployment

## Stack

- Next.js 16 App Router, React 19, TypeScript
- PostgreSQL 16 and Prisma 7
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

## Adopting This For Your Club

1. Copy `.env.example` to `.env` and set the required local variables listed in
   `CONFIGURATION.md`.
2. Copy `config/club.example.json` to `config/club.json` and replace the club
   name, contact emails, public URL, beds, age tiers, and integer-cent rates.
   If `config/club.json` is absent, the app falls back to
   `config/club.example.json`.
3. Complete `/admin/site-style` after first sign-in to set public colours,
   fonts, and the database-stored logo. Replace the remaining images in
   `public/branding/` with your own favicon, Open Graph image, and public
   website photos. Keep the `*.example.*` files as reusable placeholders for
   forks.
4. Set deploy capability flags in `.env`: `FEATURE_KIOSK`,
   `FEATURE_CHORES`, `FEATURE_FINANCE_DASHBOARD`, `FEATURE_WAITLIST`,
   `FEATURE_XERO_INTEGRATION`, `FEATURE_BED_ALLOCATION`, and
   `FEATURE_INTERNET_BANKING_PAYMENTS`. Only the literal value `true` makes a
   module available to the deployment.
5. Set `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, and `SEED_LODGE_PASSWORD`,
   run the seed command, then change the seeded admin password on first login.
6. After sign-in, use **Admin > Modules** to set club-level activation for
   optional modules. Optional modules are active only when both the `.env`
   capability and the Admin Modules activation are enabled.
7. Use test/demo credentials for Stripe, Xero, SES, and Sentry until you are
   ready for a controlled deployment of your own environment.

You can use the setup helpers for a guided path:

```bash
npm run setup:check
npm run setup:wizard
```

The CLI only writes `config/club.json`. API keys, OAuth secrets, SMTP secrets,
and deployment secrets stay in environment variables. After migrations and seed
data are in place, log in as an admin and finish the in-app checklist at
`/admin/setup`, including booking policy, membership cancellation, email, and
provider readiness settings. Admin Setup and Admin Notifications also expose
the editable lifecycle email templates and delivery policies used for
membership cancellation, archive, and safe-delete review alerts.

See `CONFIGURATION.md` for the full environment and `config/club.json` schema
reference.

## Fresh Clone Setup

```bash
git clone https://github.com/thatskiff33/AlpineClubBookingsNZ.git
cd AlpineClubBookingsNZ
cp .env.example .env
cp config/club.example.json config/club.json
npm ci
npx prisma generate
npm run setup:check
```

Edit `.env` before running the app. For a local database-backed setup, set at
least `DATABASE_URL`, `DB_PASSWORD`, `AUTH_SECRET`, `NEXTAUTH_SECRET`,
`NEXTAUTH_URL`, `CRON_SECRET`, `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, and
`SEED_LODGE_PASSWORD`. External integrations can use test/demo credentials or
remain blank unless the feature under test requires them.

For a Docker-only local boot using example config, use the staging Compose
target:

```bash
cp .env.staging.example .env.staging
docker compose --env-file .env.staging -p tacbookings-staging \
  -f docker-compose.yml -f docker-compose.staging.yml up -d --build postgres app
docker compose --env-file .env.staging -p tacbookings-staging \
  -f docker-compose.yml -f docker-compose.staging.yml run --rm migrate
docker compose --env-file .env.staging -p tacbookings-staging \
  -f docker-compose.yml -f docker-compose.staging.yml exec app npx tsx prisma/seed.ts
```

The seed data creates the first admin account from those `SEED_ADMIN_*`
variables and marks it for password change on first login, and the shared
lodge kiosk account from `SEED_LODGE_PASSWORD`. Change those passwords
immediately in any shared or persistent environment.

The Docker-only app listens on `http://localhost:3001` by default.

If you prefer `npm run dev`, run a local PostgreSQL server that matches
`DATABASE_URL`, then apply migrations and seed from the host:

```bash
npm run db:migrate
SEED_ADMIN_EMAIL=admin@example.org \
SEED_ADMIN_PASSWORD=replace-with-a-local-password \
SEED_LODGE_PASSWORD=replace-with-a-local-kiosk-password \
  npm run db:seed
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

## For Maintainers

Use the public repository for generic AlpineClubBookingsNZ work and a private deployment
fork for club-specific configuration, branding, and production release work.

- Generic feature or fix: branch from public `main`, open a public PR, merge
  after CI, then pull public `main` into the private deployment fork and deploy
  from that fork.
- Club-specific change: branch, review, merge, and deploy inside the private
  fork. Keep private configuration, operational copy, service identifiers, and
  club data out of the public upstream.
- Production hotfix: fix and deploy from the private fork first, then port any
  generic part back to the public upstream in a separate PR.

CI should run in both repositories. Public CI should use
`config/club.example.json` and placeholder assets; private CI should use the
private fork's real `config/club.json`, private assets, and private CI secrets.

See `docs/ONGOING-DEVELOPMENT-WORKFLOW.md` for the full maintainer workflow.

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
The supported AlpineClubBookingsNZ deployment path uses the single blue/green
production deploy script:

```bash
./scripts/run-production-blue-green-deploy.sh
```

On `main`, GitHub Actions builds and publishes the app and migration images to
GHCR with commit-SHA tags. The production deploy script resolves `origin/main`,
pulls those exact images, re-enters its internal deploy-engine mode, runs
migrations, and switches Caddy after health checks pass.

The public image packages are `alpineclubbookingsnz-app` for the runnable web
application and `alpineclubbookingsnz-migrate` for Prisma migration runs.

Do not use live Stripe, Xero, SES, Sentry, or production database credentials in
forks or public CI. Configure your own service accounts and secrets.

## Documentation

- `docs/README.md` - documentation index and recommended reading paths
- `docs/IMPLEMENTATION_GUIDE.md` - adopter path from clone to local
  validation and first deployment
- `docs/ARCHITECTURE.md` - system structure, data model, business logic,
  integrations, cron, and deployment shape
- `CONFIGURATION.md` - environment variables, module controls, site style,
  and `config/club.json` schema
- `DEPLOYMENT.md` - reference Lightsail, Docker Compose, Caddy, blue/green, and
  recovery guide
- `docs/MAINTENANCE.md` - public maintenance, validation, CI, and release
  checklist
- `docs/cancellations.md` - membership cancellation refund, credit-note, and
  GST policy
- `docs/ONGOING-DEVELOPMENT-WORKFLOW.md` - public upstream and private fork
  development workflow
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
