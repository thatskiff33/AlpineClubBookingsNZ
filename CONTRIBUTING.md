# Contributing

TACBookings is a production-shaped reference implementation for a club booking,
membership, payment, and finance platform. Contributions should keep the app
safe for real operational use while remaining understandable for public readers.

## Local Setup

```bash
npm ci
npx prisma generate
cp .env.example .env
docker compose up -d postgres
npm run db:migrate
npm run db:seed
```

Use test or demo credentials for external services. Do not connect local work to
live Stripe, Xero, SES, Sentry, or production database resources unless you own
that deployment and have a written change plan.

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

Each PR should include:

- a concise summary of the user-facing or operational change
- validation commands and results
- migration notes, if schema or data behaviour changes
- deployment or configuration notes, if environment variables or external
  service settings change

Keep unrelated refactors out of feature and bugfix PRs.
