# #3679 validation preparation

Read-only preparation, 2 Oct 2026 NZ. This is a command inventory, not final
compose approval or fresh validation evidence. No pnpm command, test, tracked
edit, commit, GitHub write, database or container operation was performed.

## Current preparation refresh

Re-opened actual source at origin/main 9cd9a646cc4e96261e56676b81fc00d73e0aff1d
and epic 50e461ca2acb133dd97ff23fbadad2eb7f1c7bcd. #3719 has merged into epic;
#3754 and approved residual #3794 remain prerequisites. #3784 has merged main.
The older snapshot/prerequisite notes below are historical. Seed now exists at
`handoff/3678-codex/evidence/3679-rehearsal-seed.sql`; 10 INSERT model/column lists
and eight JSON literals were checked against latest main without DB execution.
Whole-epic runtime rehearsal and exact final compose review remain missing.

The added main migration 20261016010000_add_edit_review_charge_raise_claim is
shape-only: one table, existing BookingModification FK, token/time consistency
and positive intended amount CHECKs. It alters no seeded model scalar column.
After final main sync this migration belongs to the BASE chain, not this wave's
ADDED set. Current Prisma dependency remains 7.10.0; the dependency residual
changes fast-uri only. Read the actual eventual base rather than pinning this
head after main advances. Empty EditReviewChargeRaiseClaim is disclosed as
column-only read proof; it does not need invented paid settlement/claim data
for the school migration rehearsal.

## Sources and heads

Read the actual AGENTS/core, issue threads #3679 (zero comments) and #3678
(three comments), testing census-selection/merge rules, blue-green policy,
rehearsal CLI implementation/docblock, pending-adult ledger/rollback/runbook,
and existing lane checkpoints. Issues were read with
`node scripts/issue-thread.mjs 3679` and `node scripts/issue-thread.mjs 3678`.

Snapshot refs (branches were moving during preparation):

- origin/main: 27a8d82d5c76ab4f3d2e3e02ae7217d5636a22dc.
- origin/epic/3678-officer-quote-school-wave: cdb71ab161d592870ad5b2920920d916170c4bd6.
- #3413: 6020ef8622c831a3fc99d72e94a241bff02b60d3.
- #3414: 2a01f0419b5f786e1d74455ab65bcca88034955d (in progress).

Final selection and reviewers must re-read the actual integrated head after
both children and the final main sync. Compare the ENTIRE `origin/main...HEAD`
diff, not just the last merge. Select disk-reading tests whole-file, including
composed paths, directories walked, and components rendered by changed UI.
`test:related` is additional coverage and cannot select those disk readers.

## Prerequisites still missing

- All children merged into epic and last main sync, including #3783 residual
  dependency repair and latest independent main changes.
- Dedicated compose branch/worktree with orchestrator-prepared physical
  node_modules, Node24/pnpm11, and branch-specific Prisma Client.
- Fresh labelled lane-owned Postgres16 cluster for epic rehearsal. Existing
  [lane container omitted] contains codex_local and scratch DBs; the rehearsal refuses a
  server with other databases. Do not touch [lane container omitted].
- Final pre-epic synthetic seed file and rehearsal transcript. No existing
  compose/old-client seed or whole-epic transcript was found in checkpoint or
  #3413 artifact listings. Existing child realDB evidence is not that rehearsal.
- Exact integrated-head independent review, final required CI, owner approval
  on the integration PR. This preparation satisfies none of those gates.

## Commands on final compose worktree

Capture full SHAs before and after verification. Run coherent named groups
serially with `--maxWorkers=1`; do not run the entire local test suite. Prefixes
below are relative to the FINAL compose worktree. Define group arrays as shown:

```powershell
$lib = 'src/lib/__tests__/'
$core = @(
  'advisory-lock-guard','raw-sql-shape-guard','client-server-boundary-census',
  'cli-server-only-reach-census','ssot-authority-default-guard',
  'ssot-comment-stripper-guard','date-only-encoding-guard',
  'club-time-escape-hatch-census','club-module-settings-select-guard',
  'app-currency-import-census','money-seam-mock-census'
) | ForEach-Object { "$lib$_.test.ts" }
pnpm exec vitest run @core --maxWorkers=1

$booking = @(
  'booking-request-version-fence-contracts','lodge-admission-lock-contract',
  'bed-allocation-lock-topology-contract','adult-member-hosting-call-sites',
  'adult-member-hosting-deletion-barrier','adult-member-hosting-retry-boundaries',
  'booking-owner-census','organisation-reader-contract',
  'member-dietary-access-census','night-occupancy-census',
  'guest-stay-expansion-census','booking-guest-night-price-source-census',
  'booking-guest-night-adjustment-census','booking-money-writer-census',
  'booking-money-build-up-reader-census','booking-ledger-census',
  'booking-ledger-append-only-census','hut-leader-assignment-source-immutability-census',
  'custodian-write-path-contract','lodge-booking-readiness',
  'group-discount-edit-switch-census','subscription-lockout-call-sites'
) | ForEach-Object { "$lib$_.test.ts" }
pnpm exec vitest run @booking --maxWorkers=1

$comms = @(
  'audit-writer-census','bed-allocation-audit-category-backfill',
  'email-delivery-boundary-census','env-delivery-census',
  'email-message-token-contract','email-render-gate-contract',
  'environment-role-inference-census','ordinary-admin-lodge-scope-contract',
  'admin-route-area-matrix','rate-bearing-membership-type-census',
  'unverified-write-copy-contract','require-admin-mock-forwarding-contract'
) | ForEach-Object { "$lib$_.test.ts" }
pnpm exec vitest run @comms --maxWorkers=1

$ui = @(
  'src/components/admin/__tests__/view-only-banner-contract.test.ts',
  'src/components/__tests__/club-format-provider-mount-census.test.tsx',
  'src/components/__tests__/club-time-provider-mount-census.test.tsx',
  'src/components/__tests__/booking-no-emails-ui-contract.test.ts',
  'src/components/ui/__tests__/placeholder-styling-contract.test.ts',
  'src/lib/__tests__/money-number-input-guard.test.ts',
  'src/lib/__tests__/money-input-component-guard.test.ts',
  'src/lib/__tests__/money-cents-guard.test.ts',
  'src/lib/__tests__/cents-display-guard.test.ts',
  'src/lib/__tests__/cents-in-prose-guard.test.ts',
  'src/lib/__tests__/cancellation-policy-client-contract.test.ts'
)
pnpm exec vitest run @ui --maxWorkers=1
```

These groups include changed censuses, source-tree walkers and component
consumers beyond the changed file-name matches. Final selectors should inspect
new candidate files added by latest main, not delete a failing named guard or
copy a child's stale count. Also inspect `dataset-reset-contract`,
`review-findings-contracts`, `app-theme-layout-contract`,
`final-a11y-presentation-contract` and `operator-cents-message-census` against
the final diff; add only the assertions that reach actual changed surfaces.

Focused cross-child behavior:

```powershell
$behavior = @(
  'booking-request','booking-request-quotes','school-booking-request',
  'booking-request-corrections','booking-request-malformed-stored-data',
  'booking-request-pending-adult-reservations','school-pending-adult-resolution',
  'pending-school-adults-gate','booking-request-public-routes',
  'admin-booking-request-correction-routes','config-transfer-club-settings',
  'cron-quote-expiry-reminders','booking-exception-reservation-capacity',
  'capacity','admin-pending-counts'
) | ForEach-Object { "$lib$_.test.ts" }
pnpm exec vitest run @behavior --maxWorkers=1
pnpm exec vitest run src/components/ui/money-input.test.tsx src/lib/__tests__/money-input-validation-ui.test.tsx src/lib/__tests__/public-booking-requests-panel-emptied-total.test.tsx src/components/admin/booking-requests/__tests__/booking-request-correction-editor.test.tsx src/components/admin/booking-requests/__tests__/resolve-pending-school-adults.test.tsx src/components/admin/booking-policies/__tests__/save-view-only-gating.test.tsx --maxWorkers=1
```

Both-parent resolution checks must prove these combinations, not only execute
unchanged child tests: `guests.length + pendingAdultCount` with canonical
`lodgeGuestLimitMessage`; accepted quote retains the unnamed-adult hold until
real names and officer approval; policy OFF retains named teacher guests and
Organisation/Xero contact while producing no assignments/PINs; MoneyInput
preserves quote blank/zero validation, pending count controls and private
teacher policy/public timing settings. Mutation probes are justified only for
a new or altered guard/behavior-bearing resolution; restore and prove green.

Final local gates after db:generate: `pnpm run lint --quiet`,
`pnpm run typecheck` (NODE_OPTIONS=--max-old-space-size=8192), `pnpm run knip`,
`pnpm run quality:budget --base origin/main`, `pnpm run docs:indexcheck`,
`pnpm run docs:linkcheck`, `pnpm run ci:workflowcheck`, `git diff --check`,
and `pnpm run pr:check <body-file> --base origin/main`. Capture command/result
and SHA. CI owns full shards/build/browser/static/security gates.

## Whole-epic migration rehearsal

Use `postgres:16-alpine`, matching .github/workflows/ci.yml drift/data services.
Root creates named labelled cluster with loopback non5432 port (for example
55479), POSTGRES_DB=postgres, synthetic user/password only, no extra database.
Before rehearsal verify only postgres plus templates exist and public schema
has no tables. Fresh cluster is essential; do not repurpose an existing lane.

Root-owned creation example (not executed by this preparation):

```powershell
docker run --name [lane container omitted] --label agent-lane.issue=3679 -e POSTGRES_USER=codex -e POSTGRES_PASSWORD=codex -e POSTGRES_DB=postgres -p 127.0.0.1:55479:5432 -d postgres:16-alpine
docker exec [lane container omitted] pg_isready -U codex -d postgres
```

Canonical entry is `scripts/rehearse-epic-deploy.ts`, package command
`pnpm run db:rehearse-epic`. It requires explicit `--database-url`, alternatively
EPIC_REHEARSAL_DATABASE_URL; it NEVER uses DATABASE_URL. No query parameters.

```powershell
pnpm run db:rehearse-epic --database-url postgresq[historical local path omitted] --base <final-pre-epic-main-sha> --seed-sql <compose-worktree>/.artifacts/3679-pre-epic-seed.sql
```

The CLI obtains BASE schema/migrations through git, applies base chain, seeds,
then both wave additions and generates a separate BASE Prisma client in its
scratch directory. No separate old-client worktree/install is required. It
uses installed Prisma7.10.0, not the exact previously released client binary;
compare base package/lock version and disclose any difference. It drops its
own scratch database/client unless --keep-scratch. If keeping scratch, later
runs will correctly refuse the now nonempty cluster until root cleans its own
known scratch. Do not set --keep-scratch without a concrete follow-on check.

Seed source: derive synthetic pre-epic rows from the `seed` SQL in
`prisma/migration-verification/20261101020000_add_pending_school_adult_capacity.ts`
(existing SCHOOL request), and the #3416 policy verification fixture. Extract
PRE-MIGRATION seed only; do not paste `afterMigration`/new-column assertions.
Include request/quote/lodge data needed for the actual cross-child checks and
record seeded model counts. File does not yet exist. Base migrations already
plant starter settings/lodge rows; empty affected models prove only column
lists, not value decoding.

Both new migrations should be exercised as a set: 20261101010000 teacher
policy plus 20261101020000 pending-adult capacity. #3413 is honestly ledgered
expand/windowed: old-schema reads can pass yet old capacity readers cannot see
reservation rows. A green generic read rehearsal does NOT establish rolling
runtime compatibility or waive stopping old web/workers. Scope is documented
in BLUE_GREEN_MIGRATION_POLICY, the CLI docblock, #3413 ledger and runbook.

Run migration safety gates via explicit Git Bash executable (PowerShell `bash`
can resolve WSL and skip git-aware worktree checks). Read their help/source
before supplying arguments; check-migration-safety-coverage accepts --base.
validate-blue-green-migrations requires window override/reason and
BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED=1 even for this additive windowed row.
These local acknowledgements describe synthetic rehearsal, never actual
production drain. Check duplicate prefixes and both ledger entries.
Exact override environment names are ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1,
BLUE_GREEN_MIGRATION_OVERRIDE_REASON='Local disposable #3679 rehearsal; no old
app or worker process is attached', BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED=1.
Run coverage as `scripts/check-migration-safety-coverage.sh --base origin/main`;
run validator with the two newly added migration.sql paths, using explicit
Git Bash. Scope override variables to this command and clear them afterward.

After generic rehearsal completes, use the fresh cluster for separate realDB
scratch suites, which create/drop their own database:

```powershell
$env:DATA_MIGRATION_VERIFICATION_DATABASE_URL = 'postgresq[historical local path omitted]'
pnpm exec vitest run src/lib/__tests__/data-migration-verification.realdb.test.ts -t '20261101010000|20261101020000' --maxWorkers=1
pnpm exec vitest run src/lib/__tests__/school-pending-adult-resolution.realdb.test.ts --maxWorkers=1
```

The latter proves concurrent naming/cancel waiting, atomic prices/capacity,
transaction rollback, reverse refusal for count-only and reservation-only,
and empty reverse success. Generic CLI does not execute rollback.sql or writes.
Re-read exact final suite for these claims before reporting. Operational
rollback disables writes, resolves/cancels all pending adults, proves BOTH
count queries zero, then reverse SQL, before any old runtime restarts.

## Existing evidence pointers (historical, not final-head proof)

- `handoff/3678-codex/evidence/3413.md`: exact 18-suite command, 444 tests,
  migration/realDB commands, counterpart PR audit and later129 sync tests.
- `[dedicated worktree]/.artifacts/3413-final-contracts.json` (exists).
- `[dedicated worktree]/.artifacts/3413-final-lifecycle.json` (exists).
- `[dedicated worktree]/.artifacts/3413-resolution-realdb.json` (exists).
- `[dedicated worktree]/.artifacts/3413-migration-tests.json` (exists).
- `[dedicated worktree]/.artifacts/3413-counterpart-3715.json`,
  `3413-counterpart-3735.json`, `3413-counterpart-3740.json` (exist).
- `handoff/3678-codex/evidence/3414.md`: prior UI/typecheck/doc gate evidence;
  its open#3627 status is historical and must not be reused as current.
- `handoff/3678-codex/evidence/3414-epic-merge.log`,
  `handoff/3678-codex/evidence/3414-db-generate.log` (exist).
- `handoff/3678-codex/evidence/3679-compose-plan.md`: working blueprint only.

No prior whole-epic old-client rehearsal evidence located. Final handoff must
distinguish fresh integrated checks from these child results and state manual
UI, deployment stop/drain and real-provider checks not performed.

## Orchestrator execution correction

Use pnpm run test:named with explicit selected file paths for tree-reading suites, per AGENTS and scripts/run-named-tests.mjs. The preparation examples use raw vitest; that invocation can silently omit a nonexistent path. Resolve every selected path and use the fail-closed wrapper on the final tree. The wrapper accepts paths only; run serial groups by explicit path without passing Vitest flags as paths.

