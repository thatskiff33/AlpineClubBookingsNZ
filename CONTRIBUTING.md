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

These commands assume Node 24, pnpm 11 (see "Package manager: pnpm" below) and
PostgreSQL reachable at `DATABASE_URL`. For a Docker-only boot, use the staging
Compose path in `README.md`.

```bash
pnpm install --frozen-lockfile
pnpm exec prisma generate
cp .env.example .env
cp config/club.example.json config/club.json
# start or point DATABASE_URL at your local PostgreSQL before migration
pnpm run db:migrate
SEED_ADMIN_EMAIL=admin@example.org \
SEED_ADMIN_PASSWORD=replace-with-a-local-password \
  pnpm run db:seed
```

Use test or demo credentials for external services. Do not connect local work to
live Stripe, Xero, SES, Sentry, or production database resources unless you own
that deployment and have a written change plan. `CONFIGURATION.md` documents
the full environment and club config contract.

## Package manager: pnpm

Audience: Developer, Agent.

This repository installs its dependencies with pnpm, not npm (owner decision on
#3673). The reason is disk: every agent lane works in its own git worktree, and
npm put a full copy of the dependencies (about 1 GB) in each one. pnpm keeps one
shared content-addressable store per machine and hard-links packages into each
worktree's `node_modules`, so a new worktree costs little space and installs
mostly by linking.

**Getting it.** Once per machine, with Node 24 active: `npm install -g pnpm@11`
(or `corepack enable pnpm`). pnpm then switches itself to the exact version
pinned in `package.json` `packageManager`.

**The commands.** Older issues, PRs and changelog entries still show the npm
spelling; translate it like this:

| npm (before #3673) | pnpm (now) |
| --- | --- |
| `npm ci` | `pnpm install --frozen-lockfile` |
| `npm install` | `pnpm install` |
| `npm install <pkg>` / `npm install -D <pkg>` | `pnpm add <pkg>` / `pnpm add -D <pkg>` |
| `npm run <script>`, `npm test` | `pnpm run <script>`, `pnpm test` |
| `npm run <script> -- <args>`, `npm test -- <args>` | `pnpm run <script> <args>`, `pnpm test <args>` |
| `npm run <script> -- -- <args>` (the old PowerShell-portable form) | `pnpm run <script> <args>` |
| `npx <local tool>` (`prisma`, `tsx`, `vitest`, `playwright`, `knip`) | `pnpm exec <tool>` |
| `npx -y <pkg>@<version>` (a one-off download) | `pnpm dlx <pkg>@<version>` |
| `npm rebuild <pkg>` | `pnpm rebuild <pkg>` |
| `npm audit --audit-level=high` | `pnpm audit --audit-level=high` (reads `pnpm-lock.yaml`; no install) |

pnpm hands every option after the script name to the script, so no `--`
separator is needed, in PowerShell or Git Bash.

**npm refuses to install here, on purpose.** `.npmrc` sets `engine-strict=true`
and `package.json` `engines.npm` is a value no npm version satisfies, so
`npm install` or `npm ci` typed out of habit stops with an error before it
writes a `package-lock.json` or a `node_modules` tree (measured on npm 11.16:
`npm install` fails first on the `catalog:` dependencies with
`EUNSUPPORTEDPROTOCOL`, `npm ci` on the missing npm lockfile, and `EBADENGINE` is
the backstop behind both). `package-lock.json` is
git-ignored and CI fails a branch that carries one; `pnpm-lock.yaml` is the only
lockfile. `npm run` and `npx` may still happen to work, but they are not the
supported spelling.

**Where the settings live.** `pnpm-workspace.yaml` holds all of pnpm's
settings: `overrides` (the reasons for each are in
[`docs/MAINTENANCE.md` → "The override register"](docs/MAINTENANCE.md#the-override-register)),
`catalog` (the one written range for a dependency an override pins others to),
`allowBuilds` (the only packages allowed to run install scripts, each pinned to
the exact version reviewed; pnpm fails the install with `ERR_PNPM_IGNORED_BUILDS`
on any other package or version, so a new one — or a Dependabot bump of one —
is a reviewed edit there), `nodeLinker`, `verifyDepsBeforeRun` and
`enableGlobalVirtualStore`. `.npmrc` exists for npm only.

**Bumping a package that runs an install script.** The `allowBuilds` packages
(`@prisma/engines`, `@sentry/cli`, `esbuild`, `prisma`, `unrs-resolver`) are
approved at one exact version each. Dependabot groups them, and the packages
that pull them in, into their own `install-scripts` PR, so the ordinary
minor-and-patch group is not held up. When a bump fails the install with
`ERR_PNPM_IGNORED_BUILDS <name>@<version>`:

1. Read what that version's install script does (its `package.json`
   `scripts.preinstall`/`install`/`postinstall`, and the file it runs).
2. If it is acceptable, change that one line of `allowBuilds` in
   `pnpm-workspace.yaml` to the new version and run `pnpm install`.
3. Commit it on the Dependabot branch. Dependabot then stops rebasing that PR,
   so merge it promptly or recreate it with `@dependabot recreate`.

A new package that wants an install script is added the same way, at an exact
version; one whose script is not needed is listed as `false`, like `core-js`.

**A run never installs by itself.** `verifyDepsBeforeRun: error` makes
`pnpm run`/`pnpm exec` stop with `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN` when
`node_modules` no longer matches `package.json`, the lockfile or
`pnpm-workspace.yaml`, instead of pnpm 11's default of quietly running a
non-frozen install that can rewrite `pnpm-lock.yaml`. When you see it, run
`pnpm install` yourself (after a `main` merge, `pnpm install --frozen-lockfile`).
Agents install only when authorised (`AGENTS.md` → "Orchestration Model").

**Removing a worktree.** Use `pnpm run worktree:remove <path>`, run from outside
that worktree, not a bare `git worktree remove`, which fails half-way on pnpm's
junctions and follows any other link it meets: see
[`docs/agents/CODEX_WORKFLOW.md`](docs/agents/CODEX_WORKFLOW.md) §3.

**The strict layout.** `nodeLinker: isolated` (owner decision on #3673) means
code sees only the packages it declares. An import must name a package listed in
`package.json` `dependencies` or `devDependencies`; an undeclared ("phantom")
import that npm's flat tree let work by accident fails. Fix it by declaring the
package with `pnpm add`, never by switching the layout to `hoisted`.

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
- Hand-edit `prisma/schema.prisma`; never run `pnpm exec prisma format`. The
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

**Automated agents** follow `AGENTS.md` → "Per-issue pipeline": focused local
checks (Prisma generation, lint, typecheck, related and named tests, mutation
checks), then a draft PR whose CI runs the full suite and build. They run the
full gate below only to diagnose a CI failure or when CI is unavailable.

**Human contributors** may run the focused checks and rely on PR CI in the same
way, or run the full gate before opening a PR:

```bash
pnpm run audit:deps            # the same gate CI runs, with the same threshold
pnpm run lint
DATABASE_URL=postgresql://user:pass@localhost:5432/tacbookings pnpm exec prisma validate
DATABASE_URL=postgresql://user:pass@localhost:5432/tacbookings pnpm run knip
pnpm test
pnpm run build
git diff --check
```

For UI and accessibility changes, use the staging workflow described in
`docs/STAGING_ACCESSIBILITY.md`. Do not run broad browser automation against a
live production site.

### Tests never see the real date

`pnpm test` runs with "today" frozen at **1 July 2026**
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

`pnpm run knip` is a blocking CI check (the `verify` job runs `pnpm exec knip` after
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

Automated agents follow the `AGENTS.md` "Completion and Merge" merge gate, the
one statement of who may merge what. Always merge with a merge commit; never
squash or force-push.

### Branch protection

`main` is branch-protected; force-pushes and branch deletions are blocked. The
code-owner requirement was removed on 7 Oct 2026 (#3959); who may merge what is
`AGENTS.md` → "Completion and Merge". What is applied today is below, followed by
the owner's checklist for rebuilding it.

#### Required checks applied today

| Required check | Status | Job | What it gates |
| --- | --- | --- | --- |
| `verify` | applied | `ci.yml` → `verify` | lint, typecheck, knip, build, PR-body gates, and a fail-closed same-attempt poll of four independent full-suite test shards (#3431). It no longer runs the dependency audit (#2946) |
| `Migration drift check` | applied | `ci.yml` → `migration-drift` | migrations reproduce `schema.prisma`; real-Postgres lock harnesses |
| `Data migration verification` | applied | `ci.yml` → `data-migration-verification` | data-rewriting migrations against realistic pre-state |
| `Static analysis gate` | applied | `ci.yml` → `static-analysis` | Semgrep: four registry packs **plus** `.semgrep/rules/**` and their fixtures |
| `Playwright E2E` | applied | `e2e.yml` → `playwright` | the browser suite |
| `E2E multi-lodge` | applied | `e2e.yml` → `multi-lodge` | the multi-lodge browser suite |
| `Secret scan (gitleaks)` | applied | `ci.yml` → `secret-scan` | the PR's own commits, `main`'s history including merge commits, and the checked-out tree (#2686) |
| `Image security gate (Trivy CRITICAL)` | applied | `ci.yml` → `docker-image-security` | CRITICAL image vulnerabilities. HIGH stays advisory (#2686) |
| `Dependency audit` | applied | `ci.yml` → `dependency-audit` | `pnpm audit --audit-level=high`. Split out of `verify` (#2946), where a failing audit skipped lint, the ratchet, `prisma generate`, typecheck, knip, `pnpm test` and the build on every branch (#2945) |

**Adding a required context is a three-step sequence, and doing it out of
order breaks every open pull request** — whenever a job producing a required
context is added or renamed. A branch predating the merge produces none of the
new names, and a required check that has never reported sits on
"Expected — waiting for status" forever:

1. merge the change that adds or renames the job;
2. then add that job's context to branch protection;
3. then merge the new `main` into every open pull request branch, oldest first,
   following [`AGENTS.md` → "Safety"](AGENTS.md#safety) for branch-history handling.

**Between step 1 and step 2 the new context is a red check, not a merge
block.** Splitting out `Dependency audit` (#2946) opened exactly such a gap:
`verify` had stopped running the audit, so a high advisory reddened a check
nothing enforced. Close such a window promptly.

**Read the applied list rather than trusting this table** — but an agent
session cannot: the machine account holds `push`, not `admin`, so the endpoint
404s for it. **That 404 means "not permitted", never "not protected"**; check
`gh api user -q .login` first. Ask the owner to run:

```bash
gh api repos/thatskiff33/AlpineClubBookingsNZ/branches/main/protection \
  --jq '{checks: .required_status_checks.contexts,
         strict: .required_status_checks.strict,
         approvals: .required_pull_request_reviews.required_approving_review_count,
         code_owners: .required_pull_request_reviews.require_code_owner_reviews,
         dismiss_stale: .required_pull_request_reviews.dismiss_stale_reviews,
         enforce_admins: .enforce_admins.enabled}'
```

A second trap: this repository also carries a *ruleset*, "Protect Main
Branch", whose enforcement is `disabled`. Rulesets never appear at the
endpoint above, so editing one changes nothing while appearing to work;
`gh api repos/<owner>/<repo>/rules/branches/main` lists what a ruleset really
applies — currently `[]`.

Measured 19 Aug 2026: the nine contexts above, `strict: false` (requiring
up-to-date branches serialises the queue behind full re-runs),
`required_approving_review_count: 0` (a pull request is required, a human
approval is not — #2713/#2948), `enforce_admins: false`. Code-owner review
and stale-approval dismissal were applied on 2 Oct 2026 (#3341) and removed by
the owner on 7 Oct 2026 (#3959); "Rebuilding the code-owner configuration"
below is kept as the record of how to re-apply it, should the owner choose to.

**Advisory, and deliberately NOT required** — a finding is investigated, but
it cannot block a merge: `CodeQL`, `Analyze (javascript-typescript)` and
`Analyze (actions)` (GitHub code scanning **default setup**, configured in
repository settings, not a workflow file — there is no `codeql.yml`
and adding one would require disabling default setup); `Semgrep OSS`
(the code-scanning check GitHub raises from `Static analysis gate`'s
SARIF — not a second scan);
`semgrep-cloud-platform/scan` (a Semgrep AppSec Platform App
configured outside this repository); `dependency-review`;
`Markdown relative-link check (offline)`; `Scheduled secret sweep` (#2852),
weekly and unrequirable; and the clock-rollover canary, which
its own workflow comment says must never become a pull-request check.
Measured on fork PRs #2782/#2813, the CodeQL contexts do not appear at
all — a second reason they can never be required.

**Never put a job-level `if:` or `needs:` on a required check.** A skipped job
DOES report a status — measured on push `66448740c`, where `dependency-review`
and `gitleaks-pr-diff` both skipped via a job-level `if:` and both reported
one; only a workflow-level `on:` filter produces none. The hazard is that
GitHub counts a `skipped` required check as **satisfying** branch protection,
so an `if:` on a security gate makes it vacuously green and the merge button
turns on. `needs:` does the same when an upstream job fails. Put the condition
on the STEP instead, where a skip leaves the job a real pass or failure.

Because `enforce_admins` is off, an admin merge can land `main` red; compare
against `main`'s own latest CI before calling a failure pre-existing. Require
each required check present on the **exact current head SHA**: a conflicted
PR gets no `pull_request` runs, so `gh pr checks` can read green off an older
head, and an empty failure list is not a passing run (#2641).

#### Rebuilding the code-owner configuration

What is owned is `.github/CODEOWNERS` itself: the money surface (#3341) and,
since the owner's
[third decision on #3843](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3843#issuecomment-5967784861),
the dependency-audit security gate — `dependency-mitigations.d/`, `patches/`,
`scripts/ci/dependency-mitigation.mjs` and `scripts/ci/audit-dependencies.mjs`
— because a mitigation record can turn the required `Dependency audit` check
green. Since #3853, every `.github/workflows/**` file and `.npmrc` are also
owned because they control required CI gates and install behaviour. `package.json`,
`pnpm-workspace.yaml`, and `pnpm-lock.yaml` are deliberately not owned, so
ordinary dependency bumps need no Approve.

**Applied by the owner on 2 Oct 2026** (owner decisions of 26 Sep 2026 on
#3341: code-owner review, option A; stale approvals dismissed on push). Step 4's
test passed on #3807/#3808, recorded on #3341; the steps stay here so the
configuration can be rebuilt. Agents
must not make this change; it is a repository setting.

1. Once the pull request that adds `.github/CODEOWNERS` has reached `main`
   (GitHub reads the file from the pull request's base branch), open
   Settings → Branches → the classic rule for `main`. Not the ruleset called
   "Protect Main Branch": it is disabled, and editing it changes nothing.
2. Under "Require a pull request before merging":
   - tick **Require review from Code Owners**;
   - tick **Dismiss stale pull request approvals when new commits are pushed**;
   - leave **Require approvals UNTICKED**. The API reports that as
     `required_approving_review_count: 0`; ticking it offers no 0 and sets 1,
     which is the repo-wide review step 5 forbids.

   Change nothing else, and save.
3. Read the settings back with the `gh api` command under "Required checks
   applied today" above. Expect `approvals: 0`, `code_owners: true` and
   `dismiss_stale: true`, with the nine checks unchanged.
4. Test it on two throwaway branches off `main`, each opened as a pull request
   by `thatskiff33-agents` (GitHub never counts a code owner's approval of
   their own pull request):
   - **A** changes one line of an owned file, for example a blank line at the
     end of `docs/invariants/money.md`;
   - **B** changes one line of an unowned file, for example `docs/README.md`.

   Expected: once its checks pass, **A** reports "Review required" from
   `@thatskiff33` and stays blocked for the agent account, while **B** can be
   merged. Then Approve **A**, confirm it unblocks, push a second commit to it,
   and confirm the Approve is dismissed and it blocks again. Record what
   actually happened on #3341, then close both pull requests unmerged and
   delete the branches.
5. **If A is not blocked while approvals are unticked, do not tick them.** A
   count of 1 requires an approval on every pull request, which is the
   repo-wide review the 18 Aug 2026 decision rejected and #3341 kept out of
   scope. Record the result on #3341 and bring the trade-off back to the owner
   as a decision instead.

Once it is on, a code-owned pull request **you author yourself** can only merge by
admin bypass: GitHub never counts the sole code owner's Approve of their own
pull request.
