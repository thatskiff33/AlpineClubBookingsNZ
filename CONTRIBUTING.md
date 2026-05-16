# Contributing

TACBookings is a production-shaped reference implementation for a club booking,
membership, payment, and finance platform. Contributions should keep the app
safe for real operational use while remaining understandable for public readers.

## Local Setup

These commands assume PostgreSQL is reachable at `DATABASE_URL`. For a
Docker-only boot, use the staging Compose path in `README.md`.

```bash
npm ci
npx prisma generate
cp .env.example .env
cp config/club.example.json config/club.json
# start or point DATABASE_URL at your local PostgreSQL before migration
npm run db:migrate
SEED_ADMIN_EMAIL=admin@example.org \
SEED_ADMIN_PASSWORD=replace-with-a-local-password \
  npm run db:seed
```

Use test or demo credentials for external services. Do not connect local work to
live Stripe, Xero, SES, Sentry, or production database resources unless you own
that deployment and have a written change plan. `CONFIGURATION.md` documents
the full environment and club config contract.

## Development Rules

- Read the Next.js versioned docs in `node_modules/next/dist/docs/` before
  changing framework APIs.
- Keep money values in integer cents.
- Keep booking dates as New Zealand date-only values unless a feature explicitly
  requires time-of-day semantics.
- Keep external payment, accounting, and email calls outside long database
  transactions where possible.
- Do not add plaintext token storage; bearer tokens should be stored hashed or
  encrypted as appropriate for their use.
- Update docs when public setup, deployment, architecture, or environment
  contracts change.

## Validation

Run the relevant focused tests first, then the full gate before opening a PR:

```bash
npm audit --audit-level=high
npm run lint
DATABASE_URL=postgresql://user:pass@localhost:5432/tacbookings npx prisma validate
npm test
npm run build
git diff --check
```

For UI and accessibility changes, use the staging workflow described in
`docs/STAGING_ACCESSIBILITY.md`. Do not run broad browser automation against a
live production site.

## Pull Requests

For public contributions:

1. Fork the repository or create a branch in a clone you control.
2. Keep changes focused on one bug, feature, or documentation task.
3. Do not include real member data, payment data, accounting exports, tokens,
   credentials, production logs, or screenshots containing private information.
4. Run the validation commands below and include the results in the PR body.
5. Call out any migration, environment, deployment, or external-service changes
   explicitly.

Each PR should include:

- a concise summary of the user-facing or operational change
- validation commands and results
- migration notes, if schema or data behaviour changes
- deployment or configuration notes, if environment variables or external
  service settings change

Keep unrelated refactors out of feature and bugfix PRs.
