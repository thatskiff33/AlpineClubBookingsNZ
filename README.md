# TACBookings

TACBookings is the Tokoroa Alpine Club booking and membership platform. It is a Next.js 16 App Router application with PostgreSQL, Prisma, NextAuth/Auth.js credentials sessions, Stripe payments, Xero integration, AWS SES email, finance reporting, and Docker Compose deployment for the production Lightsail host.

## Requirements

- Node.js 20.9 or newer
- npm
- Docker and Docker Compose for local PostgreSQL and production-style builds

## Fresh Clone Setup

```bash
git clone https://github.com/thatskiff33/TACBookings.git
cd TACBookings
cp .env.example .env
npm ci
npx prisma generate
```

Edit `.env` before running the app. For local development, the minimum values are `DATABASE_URL`, `NEXTAUTH_SECRET`, `AUTH_SECRET`, `CRON_SECRET`, and any integration keys required for the feature you are testing. The default `.env.example` database URL targets PostgreSQL on `localhost:5432`.

Start PostgreSQL, apply migrations, and seed local data:

```bash
docker compose up -d postgres
npm run db:migrate
npm run db:seed
```

Run the development server:

```bash
npm run dev
```

Open `http://localhost:3000`. The seed account is `support@tokoroa.org.nz` / `admin123`; change the password immediately in any shared or persistent environment.

## Daily Commands

```bash
npm test          # Vitest unit and route coverage
npm run lint     # ESLint
npm run build    # Prisma generate + Next production build
npm audit --audit-level=high
```

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

The production Compose model includes `app` as the cron leader and warm fallback, `app_blue` / `app_green` as web-only blue/green slots, `postgres`, `caddy`, and a `migrate` profile service.

For accessibility or release-review checks, use the non-production staging target:

```bash
cp .env.staging.example .env.staging
docker compose --env-file .env.staging -p tacbookings-staging \
  -f docker-compose.yml -f docker-compose.staging.yml up -d --build postgres app
```

See `docs/STAGING_ACCESSIBILITY.md` for the staging URL, auth path, and Lighthouse workflow.

## Deployment

Production deploys use the blue/green wrapper documented in `DEPLOYMENT.md`:

```bash
./scripts/run-production-blue-green-deploy.sh
```

Do not deploy production by running a plain `docker compose up -d --build` on the live host unless you are intentionally bypassing the blue/green process for an incident response.

## Key Documentation

- `DEPLOYMENT.md` - Lightsail, Caddy, Docker Compose, blue/green deploy, and recovery
- `docs/STAGING_ACCESSIBILITY_RUNBOOK.md` - staging target, auth path, and Lighthouse/print accessibility evidence flow
- `docs/ARCHITECTURE.md` - system architecture, core data model, integrations, cron, deployment
- `docs/STAGING_ACCESSIBILITY.md` - non-production staging target and accessibility verification workflow
- `docs/CI_SECURITY_GATES.md` - CI security controls and GHAS risk acceptance
- `docs/PRODUCTION_DEPENDENCY_AUDIT.md` - dependency audit state and accepted Auth.js/Nodemailer peer mismatch
- `docs/HASHED_TOKEN_MIGRATION.md` - token hash-at-rest migration
- `docs/finance-dashboard/README.md` - finance dashboard operator and agent handoff
