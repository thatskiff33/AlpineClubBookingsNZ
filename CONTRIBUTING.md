# Contributing

AlpineClubBookingsNZ is a production-shaped reference implementation for a club booking,
membership, payment, and finance platform. Contributions should keep the app
safe for real operational use while remaining understandable for public readers.

This page is the canonical contribution process — setup, standards, and how to
get a change reviewed and merged. For the wider map of what to read *before*
changing a given area, start at
[`docs/contributors/README.md`](docs/contributors/README.md), the contributor
index: it names the agent contract, the invariants, the architecture and the
per-area technical references, and it links back here rather than restating any
of this.

Adopting the platform for a club rather than changing it? That is a different
path: [`docs/adopters/README.md`](docs/adopters/README.md).

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
- Build those cents at one of two boundaries, never inline (#2685). An amount a
  PERSON typed goes through `parseDecimalDollarsToCents` in
  `src/lib/money-input.ts` (or `parseSignedDecimalDollarsToCents` where a
  negative is a real amount), which reads the digit groups as integers rather
  than scaling a decimal through a double. It returns `null` for anything
  outside the grammar, and that `null` must reach the person as a visible
  validation error — never a substituted `0`, a `null` payload field, or a
  silently retained previous value. An amount an accounting provider has already
  parsed into a number, such as a Xero API amount, has no decimal text left to
  read, so it goes through `providerAmountToCents` in
  `src/lib/money-provider-amount.ts` instead; its `Math.round(value * 100)` is
  frozen, because that is what live reconciliation computes. Lint and
  `src/lib/__tests__/money-cents-guard.test.ts` enforce this over non-test code
  in `src/`, `scripts/` and `prisma/`. The rule matches the composition, not
  `parseFloat` by name, so percentages and `Math.round(n * 100) / 100` rounding
  stay legal. A site that genuinely needs an exemption is added to the exported
  `MONEY_GUARD_EXEMPTIONS` array in `eslint.config.mjs` with a written reason —
  never an `eslint-disable`. That array is the list the guard test READS, so
  adding an entry is a move that passes CI rather than one that trades a lint
  failure for a test failure.
- Keep booking dates as New Zealand date-only values unless a feature explicitly
  requires time-of-day semantics.
- Never hand-write a date-only encoding. `formatDateOnly`, `formatMonthOnly` and
  `dateOnlyFromIsoString` in `src/lib/date-only.ts` are the only place in `src/`
  that may write `toISOString().slice(0, 10)`, and an `eslint` rule refuses the
  spellings it names across `src/`, `scripts/` and `prisma/` (#2684) — the ISO
  cut in every `slice`/`substring`/`substr`/`replace` form, `.split("T")` taken
  with `[0]`, `.at(0)` or `.shift()`, the same cut assembled through a local, and
  a date key built from `getUTCFullYear()`-style parts. It reads syntax, so it is
  a guard rather than a sandbox: `eslint.config.mjs` lists beside the rule both
  what it catches and the forms that still get past it. Pick the helper that
  matches what the value MEANS: `formatDateOnly` for a `@db.Date` calendar day
  (INV-DATE-010 says the stored value is an encoding rather than a moment;
  INV-DATE-019's first exact boundary, with INV-DATE-026, is what blesses reading
  it back in UTC — do not cite 010 for a decode, #3080),
  `formatDateOnlyForTimeZone` for a real instant such as
  `createdAt`, whose UTC day is the previous New Zealand day all morning, and
  `todayDateOnlyForTimeZone` / `getTodayDateOnly` for "today" (INV-DATE-019).
  Do not wrap an encoder in an exported one-line rename, and do not rebuild the
  truncation inside a helper of your own — that is how a whole class of these
  went unaudited, and `date-only-encoding-guard.test.ts` refuses both.
- Keep external payment, accounting, and email calls outside long database
  transactions where possible.
- Never type a raw-SQL result and read it. `$queryRaw<SomeRow[]>` is an
  unchecked cast — raw SQL returns the *physical* column names, so a name the
  type gets wrong arrives as `undefined` rather than as an error, and that
  silently disabled a promo cap and a discount for months (#2289). Taking a row
  lock? Use `$executeRaw` on a statement that selects a constant
  (`SELECT 1 … FOR UPDATE`) and read what you need through the Prisma model.
  Genuinely cannot express it through a model? Validate the rows with
  `decodeRawRows` from `src/lib/raw-sql-rows.ts`, which also documents what
  Postgres really sends (`COUNT(*)` is a BigInt; `numeric` is a
  `Prisma.Decimal`). Lint and
  `src/lib/__tests__/raw-sql-shape-guard.test.ts` both enforce this over
  non-test code in `src/`, `scripts/` and `prisma/`, in either call form —
  a tagged template or a `Prisma.sql` composition passed to the call. Tests are
  deliberately exempt: a test's raw statement runs against a throwaway database
  and its result is asserted on the spot.
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
- Write the changelog entry as a `changelog.d/` fragment, not as an edit to
  `CHANGELOG.md` (see below).

## Changelog Entries

Changelog entries are written **one file per pull request** in `changelog.d/`,
because every branch editing the top of `CHANGELOG.md` made concurrent branches
conflict on that file daily (#2452).

1. Add `changelog.d/<pr-number>-<short-slug>.md` — for example
   `changelog.d/2448-booking-request-tolerant-reads.md`.
2. Write the entry exactly as it should appear in the release notes: one or more
   top-level `- ` bullets, opening with a bold plain-English headline that ends
   with the issue number in brackets. No headings, no version, no date.
   [`changelog.d/README.md`](changelog.d/README.md) carries the full house style
   and a worked example.
3. If the change genuinely needs no entry — a pure internal refactor, a
   comment-only change — put the no-entry marker documented in
   `changelog.d/README.md` on its own line in the pull request body instead.

The `verify` job fails a pull request that changes anything under `src/` or
`prisma/` (test files aside) and carries neither a fragment nor that marker.
Documentation-only, test-only, and workflow-only pull requests are never asked
for one. During the transition a pull request that still edits `CHANGELOG.md`
directly also passes, and `CHANGELOG.md merge=union` in `.gitattributes` (#2451)
keeps those merges conflict-free.

At release time the maintainer compiles the fragments into a version section
(`docs/MAINTENANCE.md`, "Public Reference Release Checklist"):

```bash
node scripts/release/compile-changelog.mjs 0.14.0 --dry-run   # show the plan
node scripts/release/compile-changelog.mjs 0.14.0             # write it
```

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

### Tests never see the real date

`npm test` runs with "today" frozen at **1 July 2026**
(`2026-07-01T00:00:00.000Z` — midday in NZ, so a UTC runner and an NZ club agree
on the calendar day). It is installed once for every test file in
`vitest.clock-setup.ts`, and only `Date` is faked, so real timers still drive awaited
promises.

Write date fixtures relative to that instant and they stay correct for good:
`2026-08-01` is the future, `2026-06-01` is the past. Do not write a fixture
against the real clock, and do not opt a file out because it wants a *different*
fixed date — pin that one in the file's own `beforeAll`, which wins over the
default. Use a `beforeEach` instead if the suite also hands the clock back with
`vi.useRealTimers()`, because the re-freeze restores the default instant rather
than your pin. Measure elapsed time with `realElapsedMs` from
`src/lib/__tests__/helpers/clock.ts`; under the freeze `Date.now()` is a
constant, so a `Date.now()` stopwatch reads `0` and a `Date.now()` deadline never
expires.

A file that genuinely needs the real wall clock calls
`optOutOfFrozenClock("<reason>")` at module top level and is added to the counted
allowlist in `src/lib/__tests__/frozen-test-clock.test.ts`. The
`Clock rollover canary` workflow — on pushes to `main`, nightly, and on manual
dispatch, but deliberately never as a pull-request check — re-runs the suite with
the machine's **real** clock wound forward by a day, a month and a year, which a
frozen test cannot notice and an escaped one can, to catch anything the freeze
misses.

`docs/TESTING.md` has the full convention, the `TEST_CLOCK_OFFSET_DAYS` /
`TEST_CLOCK_ISO` overrides for reproducing a specific rollover locally, and why
this exists (four separate calendar rollovers turned CI red on every open branch
at once).

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
- a `changelog.d/` fragment, or the no-entry marker in the PR body
- validation commands and results
- migration notes, if schema or data behaviour changes
- a verification fixture for any migration that **rewrites existing data** (a
  backfill, repair, or value transform), under `prisma/migration-verification/`.
  CI runs those against a real PostgreSQL holding realistic pre-state, and fails
  the build naming the migration when one ships without a fixture. See
  [`docs/BLUE_GREEN_MIGRATION_POLICY.md`](docs/BLUE_GREEN_MIGRATION_POLICY.md)
  → "Data-migration verification"
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
