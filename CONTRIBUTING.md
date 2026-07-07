# Contributing

AlpineClubBookingsNZ is a production-shaped reference implementation for a club booking,
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
- Hand-edit `prisma/schema.prisma`; never run `npx prisma format`. The
  formatter realigns column whitespace across models a change does not touch,
  which inflates diffs, creates merge-conflict surface for concurrent schema
  PRs, and makes `git blame` noisier. Existing realignment churn is accepted
  once landed — do not ship whitespace-only reverts (#1567).
- Update docs whenever a feature is added, changed, or removed, and when public
  setup, deployment, architecture, or environment contracts change. Ship the
  README, `docs/` guides, and implementation notes in the same PR as the code.

## Validation

Run the relevant focused tests first, then the full gate before opening a PR:

```bash
npm audit --audit-level=high
npm run lint
DATABASE_URL=postgresql://user:pass@localhost:5432/tacbookings npx prisma validate
DATABASE_URL=postgresql://user:pass@localhost:5432/tacbookings npm run knip
npm test
npm run build
git diff --check
```

For UI and accessibility changes, use the staging workflow described in
`docs/STAGING_ACCESSIBILITY.md`. Do not run broad browser automation against a
live production site.

### Dead-code gate (knip)

`npm run knip` is a blocking CI check (the `verify` job runs `npx knip` after
the typecheck step). It fails the build if a pull request adds an unused file,
export, type, or dependency, so remove dead code in the same PR that orphans it.
Like the test suite, knip needs `DATABASE_URL` set to any value (an unreachable
dummy is fine) so `prisma.config.ts` resolves; without it knip errors on the
Prisma schema.

When knip reports a **false positive** — a file or export that is genuinely used
but through a path knip cannot statically trace (a shell script, a Playwright
`testMatch` regex, a framework convention export, a documented operator CLI) —
add a justified carve-out to `knip.jsonc` rather than deleting live code:

- Prefer an `entry` declaration for a file that is a real entry point (a script,
  a runtime hook, a tool invoked outside the import graph).
- Use a file-scoped `ignoreIssues` rule (for example
  `"path/to/file.ts": ["exports"]`) for a specific export/type/duplicate that is
  intentionally kept. Prefer file-scoped rules over directory globs, and never
  disable an issue type globally.
- Every entry and ignore entry gets a one-line comment explaining why it is
  safe. Decisions the owner has already accepted keeping (shadcn `ui/*` idiom
  exports, Next/NextAuth convention exports, type-only exports, e2e test-seam
  helpers) are recorded in issue #1129 / PR #1178.

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

## Merging

Automated agents follow the `AGENTS.md` "Completion and Merge" risk gate: at the
successful end of a meaningful piece of work they push the branch, open a PR,
monitor CI to green (fixing failures), and then merge with a merge commit.
Eligible Low/Medium-risk PRs merge autonomously once CI passes; Critical and
High-risk changes — security, payments, booking, membership, Xero/Stripe/SES/
Sentry, schema/migrations, deployment, or data integrity — wait for explicit
owner approval. Always merge with a merge commit; never squash or force-push.
