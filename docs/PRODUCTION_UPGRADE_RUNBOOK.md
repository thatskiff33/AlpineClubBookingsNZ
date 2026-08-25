# Production Upgrade Runbook

This runbook takes an existing production deployment from a `v0.9.0`-era release
up to `v0.10.0` on the supported blue/green deploy path. It is written for the
operator of a private deployment fork whose production database still predates
the July migration wave, and it is deliberately generic: substitute your own
values for placeholders such as `<owner>` (GitHub owner) and
`https://your-domain.example` (your public domain).

It is a High-risk procedure against live club data. **The owner drives or
approves each step.** Do not run any step against production without the owner
present for the window. Read this whole document, complete the staging
rehearsal, then work top to bottom during the production window and fill in the
[Production execution record](#8-production-execution-record) as you go.

## 0. Scope and companion documents

- Version target: `v0.9.0`-era → `v0.10.0`. Confirm the exact
  tags/commit SHAs before you start (see [§1 pre-flight](#1-pre-flight)).
- Read alongside:
  - `docs/UPGRADING.md` — the fork-facing tag-to-tag upgrade guide and the
    v0.10.0 release notes (the source of truth for the two
    destructive/behaviour changes; published with the release).
  - `docs/BLUE_GREEN_MIGRATION_POLICY.md` — the migration compatibility contract
    and the deploy gate this runbook relies on.
  - `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` — the per-migration safety ledger the
    gate reads.
  - `DEPLOYMENT.md` — the supported blue/green deploy path and health endpoints.
  - `docs/MAINTENANCE.md` → "Quarterly Backup Restore Drill" — the restore-test
    tooling used in pre-flight.

### What does not change

The upgrade path does not alter the money or booking invariants: money stays in
integer cents end to end, and booking dates stay NZ date-only lodge nights. No
migration in the `v0.9.0 → v0.10.0` set rescales, rounds, or re-times either.
Reconciliation totals before and after the upgrade must match to the cent
(see the [§3 spot-check](#3-post-upgrade-checklist)).

---

## 1. Pre-flight

Complete every item below **before** touching the deploy. None of these steps
writes to production; the SQL is read-only.

### 1.1 Verified, restore-tested database backup (with S3 durability confirmed)

A backup you have never restored is a hope, not a backup.

1. Confirm backup **durability first**. Historically, an S3-less host wrote
   `pg_dump` artifacts to a RAM `tmpfs` that every redeploy wiped, while the
   backup job still reported daily SUCCESS — see issue **#1361**
   (`S3-less backups report daily SUCCESS while dumps sit on RAM tmpfs wiped
   every deploy; defaults ship backups OFF`). Before you rely on any backup for
   this upgrade, open **Admin → Integrations → Database Backups**
   (`/admin/backups`, #2095) and verify that the S3 destination is configured
   ("S3 durable"), that the last successful backup is recent, and that no
   "re-enter credentials" banner is showing — then confirm the latest artifact
   actually landed in durable S3 storage (not a tmpfs path that the deploy will
   erase).
2. Take a fresh backup immediately before the window, or confirm the most
   recent durable S3 artifact is the one you will restore from. **A `windowed`
   migration moves this step:** for
   [§2.4.1](#241-2520-drop-familygroupmemberrole) the snapshot is taken *inside* the
   traffic-off window, after every writer has stopped, so nothing lands between it
   and the migration. That is the owner's order and it governs. Run step 1 and step 3
   below against the most recent durable artifact **before** that window, and verify
   the in-window snapshot by integrity and completion instead — §2.4.1 step 7 gives
   the split and the exact commands.
3. **Restore-test it** with `scripts/backup-restore-drill.sh --from-dump`
   (see `docs/MAINTENANCE.md` → "Quarterly Backup Restore Drill"). Fetch the
   `.sql.gz` object with read-only S3 credentials **from a workstation, never
   the production host**, then run the drill against a throwaway Postgres 16
   container. The drill proves the dump restores, that Prisma migrations run
   forward on the restored data, and that the money-in-integer-cents sentinels
   hold. Record `Result: PASS` and the backup object id before proceeding.

> A backup that has not been restore-tested does not satisfy this step. The
> induction-item-results deletion in [§2](#2-migrate) is **not reversible** by
> the deploy — this backup is the only recovery path for it. Do not proceed
> without a PASS.

### 1.2 Predict the module-flip: `ClubModuleSettings.updatedByMemberId`

Migration `20260627120000_core_module_defaults_off` switches seven capability
modules **off** for any deployment whose singleton `ClubModuleSettings` row was
never admin-saved. Its `UPDATE` is gated on
`WHERE "id" = 'default' AND "updatedByMemberId" IS NULL`, so
`updatedByMemberId` predicts whether the flip will hit you.

Run this read-only SELECT against production before the window and capture the
output:

```sql
SELECT
  "updatedByMemberId",
  "kiosk",
  "chores",
  "financeDashboard",
  "waitlist",
  "xeroIntegration",
  "bedAllocation",
  "internetBankingPayments"
FROM "ClubModuleSettings"
WHERE "id" = 'default';
```

Interpretation:

- **`updatedByMemberId` IS NULL** → the migration will set all seven of
  `kiosk`, `chores`, `financeDashboard`, `waitlist`, `xeroIntegration`,
  `bedAllocation`, and `internetBankingPayments` to `false`. **Write down which
  of these seven are currently `true`** — you will re-enable exactly those in
  Admin > Modules in [§3](#3-post-upgrade-checklist).
- **`updatedByMemberId` IS NOT NULL** → the row was admin-saved; the migration
  leaves it untouched and no module flips. No post-upgrade re-enable is needed
  for this reason (still confirm the toggles in [§3](#3-post-upgrade-checklist)).

### 1.3 List in-flight inductions whose item results will be deleted

Migration `20260702100000_induction_workflow_types` **deletes**
`MemberInductionItemResult` rows and **NULLs** `selfAssessedAt` /
`selfAssessmentJson` for every `MemberInduction` in status `DRAFT` or
`IN_PROGRESS`. Completed historical inductions are preserved; only in-flight
per-item and self-assessment state is retired. **This deletion is not
reversible** except from the [§1.1](#11-verified-restore-tested-database-backup-with-s3-durability-confirmed)
backup.

Run this read-only SELECT before the window and capture the output. Consider
completing or exporting any listed induction first if its per-item detail
matters:

```sql
SELECT
  mi."id",
  mi."memberId",
  mi."kind",
  mi."status",
  mi."createdAt",
  COUNT(r."id") AS item_results_to_delete
FROM "MemberInduction" mi
LEFT JOIN "MemberInductionItemResult" r
  ON r."inductionId" = mi."id"
WHERE mi."status" IN ('DRAFT', 'IN_PROGRESS')
GROUP BY mi."id", mi."memberId", mi."kind", mi."status", mi."createdAt"
ORDER BY mi."memberId";
```

A non-empty result means item results and self-assessment state for those
inductions will be gone after [§2](#2-migrate). An empty result means nothing is
lost. Either way, record the count in the execution record.

### 1.4 Capture the current version/tag

Record the currently deployed release tag and commit SHA (the "from" version),
and the target `v0.10.0` tag and its resolved `origin/main` SHA (the "to"
version). The deploy script snapshots the resolved `origin/main` commit and
selects the matching GHCR image tags, so pin exactly which commit you are
deploying and note it in the execution record for rollback reasoning.

### 1.5 Confirm the staging dress rehearsal is recorded

Do not run production until the [§7 staging rehearsal record](#7-staging-rehearsal-record)
shows a PASS with a date. The rehearsal runs the same wave migrations against a
staging copy of live data; it is the evidence that the migrate step behaves on
your data shape.

### 1.6 Declare that this deployment is the live site (#3034)

Add this line to the production `.env` **before** you start, or the deploy aborts
in its own preflight at step 3 of 20:

```
APP_ENVIRONMENT_ROLE=production
```

**Exactly one such line.** The usual `.env` shapes are all accepted — an
`export ` prefix, spaces around the `=`, quotes round the value, a leading indent
— but a SECOND line assigning the same key is refused, in any of those shapes,
because Docker Compose would use the last one and you would not know which you
had deployed. Search the file rather than trusting the top of it.

Also make sure nothing has exported `APP_ENVIRONMENT_ROLE` into the shell you will
run the deploy from (`unset APP_ENVIRONMENT_ROLE` if in doubt): Compose prefers
the shell's value over the file's, and the deploy refuses when the two disagree.

An abort here is safe by design: the previous release is still serving, nothing
has been migrated and nothing has been switched. Fix the line and run the deploy
again. It is refused rather than defaulted because from this release on an
installation that has not declared itself resolves UNKNOWN and holds back member
email and Xero writes — see `docs/UPGRADING.md` and
`docs/guides/environment-role.md`.

On a **staging rehearsal** the value is `non-production`;
`docker-compose.staging.yml` already hard-codes it, so a rehearsal on that stack
needs nothing.

---

## 2. Migrate

Migrate via the supported blue/green deploy path. Run from the production host:

```bash
./scripts/run-production-blue-green-deploy.sh
```

The script re-enters itself with `--internal-blue-green-deploy` and runs a
20-step engine (`scripts/run-production-blue-green-deploy.sh`). The steps that
matter for this upgrade:

- **Step 12/20 — "Validating Prisma schema against committed migrations".**
  This runs `validate_pending_migrations_blue_green_safe`, which calls
  `scripts/validate-blue-green-migrations.sh` against every pending migration.
  This is the gate. It must pass green (see [§2.1](#21-the-validator-gate-is-expected-green)).
- **Step 13/20 — "Running Prisma migrations".** `prisma migrate deploy` runs
  through the `migrate` service, applying the pending migrations to the shared
  Postgres **while the old color can still be serving traffic**.
- **Step 14/20 / Step 15/20 — starts the new (target) web color and refreshes
  the cron leader on the new release, both before cutover.**
- **Step 16/20 — "Warming the new release and verifying its page cache before
  cutover".** The #2566 gate: it renders every eligible public page on the new
  colour, proves the page cache was populated for the addresses this release stores,
  and REFUSES the cutover on any critical-page failure. Still fully reversible — no
  traffic has moved. It also lengthens the migrate-to-cutover window by the time it
  takes, and `DEPLOY_WARMUP_TOTAL_TIMEOUT_SECONDS` (240s by default) bounds **one
  service's run**: the gate runs once per warmed service, which by default is the new
  colour **and** the `app` cron leader, so the default worst case is 2 x 240s = 480s.
  That matters for [§2.2](#22-agetier-not_applicable--deploy-in-a-quiet-window).
- **Step 17/20 — "Switching Caddy upstream to target web service".** This is
  the **cutover**: Caddy is repointed to the new color, external/internal health
  is verified, then the previous color's connections are drained. Everything
  before this step is reversible by aborting; see [§4](#4-rollback-plan).

### 2.1 The validator gate is expected green

`main` ledgers **all** pending `v0.9.0 → v0.10.0` migrations in
`docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`, including the two that a hot-table /
trigger scan flags:

- `20260702180000_add_two_factor_session_challenge` (FK to `Member`), and
- `20260704100000_defer_booking_guest_stay_range_triggers` (trigger swap on
  `Booking` / `BookingGuest`).

The validator's hot-table regex covers `CREATE`/`DROP TRIGGER` and
`CREATE CONSTRAINT TRIGGER`, and CI's `migration-drift` job runs
`scripts/check-migration-safety-coverage.sh` on every PR so a regex-matching
migration cannot merge without a ledger row. So step 12 is **expected to pass**.

**If step 12 fails at "missing ... entry for blue/green migration safety
review":** stop. Do **not** reach for `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1` —
that flag only bypasses the *potentially-breaking-SQL* warning
(`found_breaking`); it does **not** bypass a missing/malformed ledger entry
(`found_failure`), and it additionally requires a non-empty
`BLUE_GREEN_MIGRATION_OVERRIDE_REASON`. A missing-entry failure on a clean
`v0.10.0` checkout means your migration tree or ledger has drifted from
`origin/main` — reconcile the checkout against the release tag rather than
editing the ledger on the host. The gate fails **safe**: the old color keeps
serving and no schema change has been applied.

### 2.2 AgeTier `NOT_APPLICABLE` — deploy in a quiet window

The `v0.10.0` set includes the #1440 AgeTier work. The backfill migration
`20260707000100_backfill_org_age_tier_not_applicable` is ledgered
`old_code_compatible=no`. Its ledger row states:

> Single UPDATE flipping ADULT organisation-type members (legacy SCHOOL role or
> ORG access role) to the new NOT_APPLICABLE AgeTier value; touches only those
> rows (typically a handful per club) with brief row locks and no DDL. CAUTION:
> pre-#1440 Prisma clients cannot deserialize NOT_APPLICABLE, so old-color reads
> of the flipped rows (admin members list, that member's detail, school flows)
> can error between migrate and cutover — deploy in a quiet window and cut over
> promptly, or defer this migration until the old color drains (the UPDATE is
> idempotent and safe to run late).

The owner ratified the deploy strategy (owner decision record, 2026-07-07, on
epic #1438):

> **Quiet window**: ship both #1440 migrations normally, deploy at low traffic,
> cut over promptly (per the BLUE_GREEN_MIGRATION_SAFETY.tsv row; the
> defer-the-backfill option remains documented as the operator fallback).

and the Wave-4 operator reminder:

> #1440's migrations follow the ratified quiet-window plan — deploy at low
> traffic and cut over promptly (or defer
> `20260707000100_backfill_org_age_tier_not_applicable` until the old color
> drains; it is idempotent).

**Operator action for `v0.10.0`:** schedule this production window at **low
member-admin traffic**, and minimise the gap between step 13 (migrate) and step
17 (cutover) so the window where the old color could read a flipped
`NOT_APPLICABLE` row is as short as possible. If you cannot deploy in a quiet
window, the documented fallback is to defer only
`20260707000100_backfill_org_age_tier_not_applicable` until the old color has
fully drained onto the new runtime, then run that single migration late — it is
idempotent and safe to run once the new code is serving all traffic.

### 2.3 Verify the migrate step

Step 13 runs `verify_prisma_migration_status`; confirm the engine reports the
database is up to date and that the new color passes `/api/health/ready` before
cutover. Then let the warm-up gate (step 16) pass and step 17 perform the cutover.

### 2.4 Windowed migration deploy sequence

Use this instead of the normal blue/green flow whenever any pending migration is
declared `old_code_compatible=windowed` in the safety ledger. Three migrations are
in that class:

- `20260803010000_contract_subscription_lockout_drop_enabled` (#2543 / #2561) —
  covered immediately below;
- `20260803030000_contract_drop_family_group_member_role` (#2520) — covered in
  [§2.4.1](#241-2520-drop-familygroupmemberrole);
- `20260806010000_fence_hosting_coverage_delivery_claims` (#2596) — additive DDL,
  but an old hosting worker ignores the new tokens and can process a new worker's
  live claim, so mixed old/new workers are forbidden.

**If several are pending, they share ONE window.** `prisma migrate deploy` applies
them in the same command — you do not stop and start the application repeatedly. Work
the checks in [§2.4.1](#241-2520-drop-familygroupmemberrole) as well as the ones
here, and name both migrations in the override reason.

**Rolling a window containing #2596 back starts with its no-op `rollback.sql`
boundary:** stop all new app/worker processes, but retain its nullable columns and
applied history. Then the two schema-removal `rollback.sql` scripts run in reverse
order — `20260803030000` first, then `20260803010000`. Running only one leaves the other's column missing, so the
previous release is still broken; if the one you skip is `20260803010000`, what
stays broken is every booking write path. Spelled out at
[§2.4.1](#241-2520-drop-familygroupmemberrole)'s rollback boundary, and rehearsed
at [§7.2](#72-windowed-migration-rehearsal-20260803030000_contract_drop_family_group_member_role).

**And when both are pending, §2.4.1's ordering governs the combined window**, not
the ordering in the list immediately below. The two differ in one place: this list
takes the backup at step 2, before traffic is removed; §2.4.1 takes it at step 7,
*after* the app and every worker have stopped and no old connection remains. The
later position is strictly safer — the snapshot is a quiet point, with no writes
landing between the backup and the migration — and it is the order the owner
directed for #2520 (3 Aug 2026). Nothing else about this list changes, and it stands
as written for a window carrying only `20260803010000`.

**Why the normal flow does not work here.** Blue/green relies on the old colour and
workers remaining compatible while the new schema is applied. The first migration drops a column
the old colour's Prisma client still names, so the instant migrate commits, the old
colour raises on every read of `MembershipLockoutSettings` — and because the
booking gates resolve the club's lockout policy through that read, that is every
booking write path, not just the admin screen. There is no version of this deploy
where both colours work at once. #2596 adds only nullable columns, but its old worker
does not honour a new worker's claim token, which makes the mixed-runtime interval a
delivery-integrity failure rather than a schema error. The honest answer is a short
outage you control, rather than an outage the members discover.

**The sequence. Do not reorder it — each step exists because the next one is
irreversible without it.**

1. **Build and validate the new images first.** Finish and verify the build
   *before* touching the database. A build that fails after the column is dropped
   leaves you with no working release to start.
2. **Take a fresh backup, and verify it restores.** Immediately before migrating,
   not merely before the deploy. For an ordinary migration the rollback boundary is
   the cutover; for this one it is the migrate step, so this backup is the last
   point you can return to unconditionally. Follow
   [§1.1](#11-verified-restore-tested-database-backup-with-s3-durability-confirmed).
3. **Put the site into maintenance mode / remove user traffic.** Members must not
   be mid-booking when the schema moves.
4. **Stop the old app AND the background workers.** Both read this settings row.
   Leaving the workers running produces the same errors with nobody watching, and
   fills the logs with failures that look like the migration went wrong.
5. **Migrate.** Run the safety validator first, with
   `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1`, a
   `BLUE_GREEN_MIGRATION_OVERRIDE_REASON` that names this window, and
   `BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED=1` only after step 4 — it refuses
   otherwise, and refuses regardless if the `rollback.sql` is missing. The
   validator is a **separate script** that `prisma migrate deploy` knows nothing
   about, so in a hand-run window the operator invokes it or nothing does:
   [§2.4.1](#241-2520-drop-familygroupmemberrole) step 9 carries the exact two
   commands, and they are the same for this migration.
6. **Start the new release**, confirm `/api/health/ready`, then take the site out
   of maintenance mode.

Keep steps 5-6 as short as the plan allows. The three statements are metadata-only
on a single-row table, so the migration itself is quick; the window is dominated by
stopping and starting the application. That holds for this list, where the backup and
its restore test sit at step 2 — *before* traffic is removed — so the drill costs no
downtime. It does **not** hold for the combined window, whose backup moves inside the
traffic-off period: see [§2.4.1](#241-2520-drop-familygroupmemberrole) step 7 and its
window-length note before you announce a duration.

**The warm-up gate (step 16) runs inside this window too**, and it adds the time it
takes to render every public page — bounded by `DEPLOY_WARMUP_TOTAL_TIMEOUT_SECONDS`
(240s by default) **per warmed service**. The gate runs once per service, so budget
480s for the default pair (the new colour and the `app` cron leader), not 240s. Budget
for it rather than switching it off: in a window where the
old colour is already broken, "does the new release actually serve its public pages?"
is the most valuable question you can ask before opening the site again, and the
answer arrives while members are still held out. If the window is genuinely too tight,
lower the timeout and the concurrency rather than disabling the gate — but stay inside
the accepted ranges (`DEPLOY_WARMUP_TOTAL_TIMEOUT_SECONDS` 5-1800,
`DEPLOY_WARMUP_CONCURRENCY` 1-8; the full table is in `DEPLOYMENT.md` → "Pre-cutover
warm-up gate"). Outside them the deploy refuses before it starts and names the
setting; `DEPLOY_WARMUP_CONCURRENCY=0` is not how the gate is disabled.

**Rollback path.** Two options, in order of preference:

- **Forward.** If the new release starts, finish the deploy. This is almost always
  right: the schema is already migrated and the data is intact.
- **`rollback.sql`.** If the new release cannot start, run
  `prisma/migrations/20260803010000_contract_subscription_lockout_drop_enabled/rollback.sql`
  by hand as the migration role, then redeploy the previous release's images. It
  recreates `enabled` from `mode` (`NO_BLOCK` → false, `HARD_BLOCK` and
  `NON_MEMBER_PRICING` → true) and returns `mode` to nullable-without-default. Both
  directions were rehearsed against a production-shaped database
  ([§7.1](#71-windowed-migration-rehearsal-20260803010000_contract_subscription_lockout_drop_enabled)).
  Note that `_prisma_migrations` still records the migration as applied, so rolling
  *forward* afterwards means deleting that row or re-applying `migration.sql` by
  hand.
- **Restore the backup** only if the data itself is wrong, not merely the schema.

#### 2.4.1 #2520: drop `FamilyGroupMember.role`

`20260803030000_contract_drop_family_group_member_role` is the second `windowed`
migration. It is one statement — `ALTER TABLE "FamilyGroupMember" DROP COLUMN
"role"` — with no backfill and no DML of any kind.

**Owner authorisation.** The original plan was two releases: deploy the runtime
removal (PR #2565), soak seven days, then drop. The owner superseded that on
3 Aug 2026: the drop ships now, as part of the Tokoroa cutover, behind an accepted
maintenance window. No further owner approval is required to run it, provided this
sequence is followed.

**Why the normal flow does not work here.** The runtime removal was never deployed
on its own, so the release currently in production is the last tagged one, whose
Prisma client names the column freely. Measured against `v0.13.2`'s own
`prisma/schema.prisma` (`role String @default("MEMBER")`, no `@ignore`):

- `listOneStepPartnerCandidates` and the one-step path of `requestPartnerLink`
  put `role: "ADMIN"` in the **WHERE clause**, so they name the column directly —
  and the member profile page renders the first of those;
- every unnarrowed `find`/`create`/`update`/`upsert`/`delete` on the join table
  names every scalar in its `SELECT` or implicit `RETURNING`;
- a static `@default("MEMBER")` is materialised **client-side** as a bind
  parameter, so the column appears in the column list of every insert that client
  emits, even one that sets no role and narrows itself with `select`;
- an `include:` on the join table (admin family groups) and an explicit
  `role: true` (`GET /api/member/onboarding`) name it too.

So the moment the DROP commits, the previous release raises Postgres 42703 /
Prisma P2022 across the whole family surface: member profile, admin family groups,
member onboarding, family join/invite/removal, member merge, Xero member import
and nomination. There is no ordering that keeps both versions working.

**The sequence, in the owner's order. Do not reorder it.**

1. **Build, publish and verify the complete replacement image** — before the live
   site goes down. A build that fails after the column is dropped leaves no
   working release to start.
2. **Confirm the image carries both halves**: the no-role runtime code and this
   migration. Both checks have to run **inside the replacement app image**, because
   that is the only place `prisma/` and `node_modules/@prisma/client` exist
   (`Dockerfile`, the two `COPY --from=builder` lines for `./prisma` and
   `./node_modules`). The deploy host itself is documented as carrying **only Docker
   and Docker Compose** (`DEPLOYMENT.md` → "Prerequisites") — no Node, no repo
   `node_modules` — so pasted at the host shell these fail with
   `node: command not found` or `Cannot find module '@prisma/client'`. Run them
   through a throwaway container off that image. `--no-deps` keeps the database out
   of it; `APP_IMAGE` must already point at the published replacement tag, exactly as
   `scripts/run-production-blue-green-deploy.sh` exports it.
   ```bash
   # the migration is present
   docker compose run --rm --no-deps app \
     ls prisma/migrations/20260803030000_contract_drop_family_group_member_role/
   # and the runtime cannot name the column: no `role` in the client's scalar enum
   docker compose run --rm --no-deps app \
     node -e "const {Prisma}=require('@prisma/client');console.log(Object.keys(Prisma.FamilyGroupMemberScalarFieldEnum).join(','))"
   # expect: id,familyGroupId,memberId,joinedAt
   ```
3. **Announce or enable maintenance mode** and remove public traffic from the
   existing application.
4. **Stop all Tokoroa web processes.**
5. **Stop every background worker, scheduler, cron runner, queue consumer** and
   anything else that can reach the shared database. Leaving them up produces the
   same errors with nobody watching, and fills the logs with failures that look
   like the migration went wrong.
6. **Verify nothing old is still connected.** No application process, and no
   database connection capable of issuing application queries, may remain:
   ```sql
   SELECT pid, usename, application_name, client_addr, state,
          left(query, 80) AS query
   FROM pg_stat_activity
   WHERE datname = current_database()
     AND pid <> pg_backend_pid();
   ```
   Expect only your own admin session. Anything else is a process step 4 or 5
   missed — go back and stop it rather than migrating around it.
7. **Take and verify a fresh database backup**, immediately before migrating, not
   merely before the deploy. For an ordinary migration you can abort up to the
   cutover; for this one the point of no return is the migrate step, so this backup
   is the last unconditional way back.

   **Split the restore test from the snapshot, and do the expensive half before the
   window.** [§1.1](#11-verified-restore-tested-database-backup-with-s3-durability-confirmed)
   is not a dump-and-checksum step: its step 3 fetches the `.sql.gz` to a
   workstation and runs `scripts/backup-restore-drill.sh --from-dump` against a
   throwaway Postgres 16 container, replaying migrations forward and checking the
   money sentinels. On a production-sized database that is tens of minutes, and this
   step sits **after** maintenance mode and every process has stopped — so running it
   here in full puts the whole drill inside the outage, and creates pressure to skip
   the one safeguard §1.1 calls mandatory. Do it in two parts instead:

   - **Before the window** (no downtime): confirm S3 durability per §1.1 step 1, then
     run the full §1.1 step 3 restore drill against the most recent durable artifact.
     This is what proves the backup *pipeline* produces a restorable dump. Record
     `Result: PASS` and the object id.
   - **Here, inside the window**: take the fresh snapshot and verify the *artifact*,
     not the pipeline — it is minutes, not tens of minutes:
     ```bash
     gzip -t <dump>.sql.gz            # stream integrity; a truncated dump exits 1
     gunzip -c <dump>.sql.gz | tail -20 | grep 'PostgreSQL database dump complete'
     ls -l <dump>.sql.gz              # sane size against the previous artifact
     ```
     Both were measured on a `postgres:16` (16.14) dump: `gzip -t` exits 1 with
     `unexpected end of file` on a truncated file, and the completion marker is
     written by `pg_dump` only on a run that finished. **Not `pg_restore --list`** —
     these artifacts are plain gzipped SQL (`src/lib/backup.ts` runs `pg_dump` with
     no format flags, then gzip), and `pg_restore` refuses them outright with
     `input file appears to be a text format dump. Please use psql.` (measured).

   Budget the pre-window drill and this in-window verification separately when you
   schedule, and see the window-length note after step 14.
8. **Record the pre-migration checks.** Paste the output into the three windowed-
   migration rows of [§8](#8-production-execution-record) — the check output, the
   dump filename and where it is stored, and (at step 9) the override reason you
   actually used. After step 9 none of these can be recovered from the database,
   and the console scrollback is not a record.
   ```sql
   -- (a) row count
   SELECT COUNT(*) AS family_group_member_rows FROM "FamilyGroupMember";

   -- (b) distinct role values and their counts. FOUR labels ever existed and any
   --     of them can appear: 'MEMBER' (the column default and what the
   --     20260407120000 / 20260407200000 backfills wrote — usually the bulk),
   --     'ADMIN', 'LEAD' (only from the 20260408020000 dependents backfill), and
   --     'USER' (written by two live paths in the release you are replacing:
   --     createFamilyGroupFromSuggestion, i.e. any group created from a family
   --     suggestion, and the admin dependent-link route). Only 'ADMIN' was ever
   --     read by anything. A FIFTH value would be genuinely unexpected -- stop and
   --     escalate; the four above are not a reason to.
   SELECT "role", COUNT(*) AS rows
   FROM "FamilyGroupMember"
   GROUP BY "role"
   ORDER BY rows DESC, "role";

   -- (c) the column exists, and in the shape the rollback script restores
   SELECT column_name, data_type, is_nullable, column_default
   FROM information_schema.columns
   WHERE table_name = 'FamilyGroupMember' AND column_name = 'role';
   -- expect: role | text | NO | 'MEMBER'::text
   ```
   ```bash
   # (d) the replacement runtime cannot reference the column. This runs INSIDE the
   #     replacement image built at step 1 — the deploy host has only Docker and
   #     Docker Compose, so a bare `node -e` at the host shell fails with
   #     `node: command not found` (or `Cannot find module '@prisma/client'`). Same
   #     wrapper as step 2, and the same assertion CI pins in
   #     src/lib/__tests__/family-group-role-retirement.test.ts.
   docker compose run --rm --no-deps app \
     node -e "const {Prisma}=require('@prisma/client');const s=Object.keys(Prisma.FamilyGroupMemberScalarFieldEnum);if(s.includes('role'))throw new Error('ABORT: replacement client still names role');console.log('replacement runtime cannot name role:',s.join(','))"
   ```
   **(e) REQUIRED — dump the labels per row before they are destroyed.** This is the
   only thing that makes an exact restore possible: `rollback.sql` step 1 repopulates
   every row with `'MEMBER'`, which for a production row is a *substitute*, not the
   value it held, and a real number of production rows hold `'ADMIN'` (the release
   being replaced predates #2284 and still reads that label). `rollback.sql` step 3
   reads this file back.

   **The file has to land on the HOST, not inside a container.** `\copy` writes
   client-side, relative to the psql process's working directory — and on this host
   psql is inside the postgres container, so the obvious `\copy` form put
   the file at `/family-group-member-role-<DATE>.csv` in that container's writable
   layer: not the `postgres_data` volume, not any backup path, and gone the next time
   the deploy script recreates the container (measured on `postgres:16` 16.14; it
   reported `COPY` and nothing appeared on the host). Use server-side
   `COPY … TO STDOUT` and redirect on the host instead:
   ```bash
   docker compose exec -T postgres \
     psql -U tac -d tacbookings -v ON_ERROR_STOP=1 \
       -c 'COPY (SELECT "id", "role" FROM "FamilyGroupMember" ORDER BY "id") TO STDOUT WITH (FORMAT csv, HEADER)' \
     > ./family-group-member-role-$(date +%Y%m%d).csv
   wc -l ./family-group-member-role-*.csv   # expect step 8(a)'s row count + 1 header
   ```
   Then **move it off the host to wherever the backup lives** and record that
   location in [§8](#8-production-execution-record) — the answer to "where is it
   stored" has to survive the deploy, and the deploy script recreates and prunes
   containers at its steps 14/17/18/19.
9. **Run the safety validator, then apply the migration.** Two commands, in this
   order, both from the repository root on the deploy host.

   **Read this before pasting anything.** The validator is a **separate script**.
   It is not a Prisma plugin and it does not hook `prisma migrate deploy` — the
   only thing that runs it automatically is
   `scripts/run-production-blue-green-deploy.sh --internal-blue-green-deploy`
   (step 12/19), and that script performs the whole ordinary blue/green cutover,
   which is exactly what this window replaces. So in a hand-run window the
   operator runs it, or nothing does, and
   `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS` / `BLUE_GREEN_MIGRATION_OVERRIDE_REASON`
   passed to `prisma migrate deploy` alone are inert — they gate the validator, not
   Prisma.

   9(a) **Validate.** Name every pending migration's `migration.sql`. For this
   release the complete ordered set is six migrations; do not validate only the two
   windowed rows:
    ```bash
    ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1 \
    BLUE_GREEN_MIGRATION_OVERRIDE_REASON="#2543 + #2520 + #2596 windowed maintenance window <DATE>: public traffic removed, web and all workers stopped, no old connections, fresh verified backup taken, pre-migration checks recorded" \
    BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED=1 \
   ./scripts/validate-blue-green-migrations.sh \
     prisma/migrations/20260803010000_contract_subscription_lockout_drop_enabled/migration.sql \
     prisma/migrations/20260803020000_add_adult_member_hosting_enforced_and_host_scopes/migration.sql \
     prisma/migrations/20260803030000_contract_drop_family_group_member_role/migration.sql \
     prisma/migrations/20260803070000_add_hosting_coverage_incidents/migration.sql \
     prisma/migrations/20260806000000_add_hosting_notification_delivery_claim/migration.sql \
     prisma/migrations/20260806010000_fence_hosting_coverage_delivery_claims/migration.sql
   ```
   Expect exit 0 with the override reason echoed back as a `WARNING:` line. It
   exits 1 without all three acknowledgements, and exits 1 regardless if `rollback.sql` is
   missing beside a windowed migration — a documentation failure the override
   cannot rescue. Record the reason you actually used in
   [§8](#8-production-execution-record); all three directions were exercised in
   the [§7.2](#72-windowed-migration-rehearsal-20260803030000_contract_drop_family_group_member_role)
   rehearsal.

   9(b) **Migrate**, through the same dedicated compose service the deploy script
   uses at its step 13/19:
   ```bash
   docker compose --profile migrate run --rm migrate
   ```
   Do **not** substitute `npx prisma migrate deploy`. The migrate service runs
   `./node_modules/.bin/prisma migrate deploy` with the in-container
   `DATABASE_URL` and a 2-connection pool; the deploy host is documented as needing
   only Docker and Docker Compose (`DEPLOYMENT.md` → "Prerequisites"),
   carries no `DATABASE_URL` in shell scope, and the runner image deliberately
   deletes `npm`, `npx` and `corepack`, so `npx` is not available inside the image
   either.
10. **Verify the migrate step.** The column is gone and the history is right:
    ```sql
    -- expect zero rows
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'FamilyGroupMember' AND column_name = 'role';

    -- expect exactly one applied row, no rolled-back marker
    SELECT migration_name, finished_at, applied_steps_count, rolled_back_at
    FROM "_prisma_migrations"
    WHERE migration_name = '20260803030000_contract_drop_family_group_member_role';

    -- and the rest of the table is untouched
    SELECT COUNT(*) FROM "FamilyGroupMember";  -- matches step 8(a)
    ```
11. **Start the replacement web application and replacement workers only.** Never
    the old images — see the rollback boundary below.
12. **Smoke-test**, in this order:
    - sign-in;
    - viewing an existing family group (member side and **Admin → Family
      Groups**);
    - creating or updating family-group membership, where safely testable;
    - family requests and approvals (join / invite / removal);
    - member merge, and the other affected administration paths;
    - ordinary member and admin page operation, including the **member profile
      page** — that is where the old code's `role: "ADMIN"` read lived, so it is
      the most direct check that the replacement runtime does not repeat it;
    - worker and scheduled-job startup.
13. **Check the logs** — application, worker, Prisma and PostgreSQL — for
    missing-column, unknown-field or family-lifecycle errors. Grep for `42703`,
    `P2022`, `does not exist` and `Unknown field`.
14. **Restore public traffic** only after every check above passes.

Keep the interval between step 4 and step 11 as short as practical.

**How long the outage actually is, so you can announce it honestly.** The migration
itself is trivial: one metadata-only statement on a small cold table, PostgreSQL
marks the attribute dropped and performs no table rewrite. But the outage members
experience is step 3 to step 14, and the migration is the cheapest thing in it. What
dominates is the careful work either side of it: stopping every web process and
worker and confirming nothing is still connected (steps 4-6), taking and verifying
the snapshot (step 7), the four checks and the required per-row dump (step 8), then
starting the replacement release and working the seven-item smoke test and the log
sweep before traffic returns (steps 11-13). Time all of that on the staging
rehearsal and announce that figure, not the migration's. Do **not** describe this to
the club as "a few minutes"; the changelog entry deliberately does not, and the
scheduling note gives the shape rather than a number.

**Rollback boundary — read before you start.** Once the DROP commits:

- **Do not restart the old application version, and do not route traffic back to
  it.** Its client names a column that no longer exists; it will fail across the
  family surface, and re-pointing Caddy does not fix that.
- **Before starting any old image, keep the new runtime and cron/drain available.**
  Demote the club-wide ENFORCED policy **and every explicit lodge ENFORCED
  override** through the new Booking Policies UI, then prove no row still uses the
  new enum value:
  ```sql
  SELECT "id", "scopeKey", "lodgeId", "mode"
  FROM "AdultMemberHostingPolicy"
  WHERE "mode" = 'ENFORCED';
  ```
  This must return zero rows. The previous Prisma client does not know `ENFORCED`,
  and `loadAdultMemberHostingPolicy` is on every booking write path, so starting it
  while even one row remains is a booking outage. Prefer a forward-fix. If rollback
  is unavoidable, record the intended fallback for every returned club/lodge row
  and, while the replacement runtime is still available, save each as
  `ADMIN_REVIEW_REQUIRED` or `DISABLED`; then repeat the query. Do not guess a
  fallback or start the old runtime until the result is empty. If the replacement
  runtime cannot perform the reset, stop and use a separately reviewed operator SQL
  mapping or restore the verified backup. After the **last** override change, let
  the new hosting drain settle and require both queries below to return zero rows:
  ```sql
  SELECT "id", "memberId", "lodgeId", "attempts", "lastError",
         "claimToken", "claimExpiresAt"
  FROM "HostingCoverageReevaluation"
  WHERE "processedAt" IS NULL
  ORDER BY "enqueuedAt", "id";

  SELECT "id", "bookingId", "lodgeId", "stateKey", "openedAt"
  FROM "HostingCoverageIncident"
  WHERE "resolvedAt" IS NULL
  ORDER BY "openedAt", "id";
  ```
  Any row blocks rollback. A maximum-attempt or `lastError` re-evaluation may no
  longer be automatically claimable and needs forward recovery or a separately
  reviewed repair; an unresolved incident blocks even with an empty queue. Repeat
  the ENFORCED, unprocessed-work and unresolved-incident proofs after the last
  policy change. Only then stop every new worker and start the old-only release.
- A rollback to the old version requires **first** either running
  `prisma/migrations/20260803030000_contract_drop_family_group_member_role/rollback.sql`
  by hand as the migration role, **or** restoring the verified step 7 backup.
- **In a combined window, run BOTH migrations' `rollback.sql`, in the reverse of
  the order they were applied** — `20260803030000` (this one) first, then
  `20260803010000_contract_subscription_lockout_drop_enabled`. This one alone is
  not enough and the gap is worse than the one it fixes: the family surface comes
  back but `MembershipLockoutSettings.enabled` is still dropped, the previous
  release's client names that column on every read of the model, and the booking
  gates resolve the club's lockout policy through that read — so **every booking
  write path still fails**, on money, while the family pages look fine and suggest
  the rollback worked. The two touch different tables so neither order can corrupt
  the other, but reverse order is the rule to follow and the one that was
  rehearsed ([§7.2](#72-windowed-migration-rehearsal-20260803030000_contract_drop_family_group_member_role)).
  `20260803000000_subscription_lockout_three_way_mode` needs no reverse script: it
  is additive and the previous release's client never names `mode`.
- `20260803020000`, `20260803070000` and `20260806000000` are additive and need
  no reverse scripts. `20260806010000` is also additive but ships a mandatory,
  deliberately no-op `rollback.sql`: keep new runtime/cron available to demote all
  ENFORCED club/lodge rows, drain every re-evaluation and close every incident;
  only then stop new workers for old-only restart. Retain its nullable columns and
  applied migration history so future new-only roll-forward needs no schema/history repair. All four additions remain
  inert to the old client after the mandatory `ENFORCED` preflight above.
- `rollback.sql` recreates the column as `TEXT NOT NULL DEFAULT 'MEMBER'` —
  byte-identical to the shape
  `20260407120000_add_family_group_member_join_table` created and exactly what the
  previous release's client expects — and the constant default repopulates every
  existing row in that one statement.
- **The per-row values are not restored by script** and cannot be: PostgreSQL
  cannot un-drop a column. Every row comes back as `'MEMBER'`, which for a
  production row is a **substitute, not the value it held**. What makes it the safe
  substitute is that of the four labels that ever existed (`'MEMBER'`, `'ADMIN'`,
  `'LEAD'`, `'USER'`) only `'ADMIN'` was ever read by anything, so repopulating with
  `'MEMBER'` can only withhold a power and never grant one — fail-closed by
  construction. It is not free: the release being rolled back to predates #2284 and
  still reads the label, so with every row back as `'MEMBER'` nobody holds `'ADMIN'`,
  the one-step partner declaration finds no candidates and returns its 403 for a
  no-login target. Everything else about family groups is unaffected, because
  nothing else reads the value, and the ordinary consent round-trip still works. To
  get the real labels back, use the **required** step 8(e) dump with `rollback.sql`
  step 3, or the backup.
- **After a `rollback.sql`, the migration history lies, and nothing in the deploy
  path notices.** `_prisma_migrations` still records the migration as applied with
  `applied_steps_count = 1` and no rolled-back marker, so `prisma migrate status`
  answers *"Database schema is up to date!"* and `prisma migrate deploy` answers
  *"No pending migrations to apply."* — and the deploy script's own drift gate
  (`migrate diff --from-migrations prisma/migrations --to-schema
  prisma/schema.prisma`) also passes, because it compares committed history to the
  schema file and never reads the live database. All three were measured on the
  rolled-back database in the
  [§7.2](#72-windowed-migration-rehearsal-20260803030000_contract_drop_family_group_member_role)
  rehearsal. The one command that does see it is
  `prisma migrate diff --exit-code --from-config-datasource --to-schema
  prisma/schema.prisma`, which reports the leftover column and exits 2. Run that
  before you trust a rolled-back database.
- **Rolling forward: re-apply `migration.sql` by hand.** That is the recommended
  path of the two, and the shorter: the history row is already correct, so
  re-running the one `ALTER TABLE … DROP COLUMN "role"` as the migration role
  leaves history, schema and database agreeing with nothing to clear up
  afterwards. The alternative — `DELETE FROM "_prisma_migrations" WHERE
  migration_name = '20260803030000_contract_drop_family_group_member_role'` and
  then migrate again — also works and rewrites the history row, but it edits the
  migration history by hand for no gain. Both were rehearsed, and both ended with
  `migrate diff` reporting **no difference** and every row intact.
- **You do not have to roll the schema forward to start the replacement release.**
  Measured, not assumed: the replacement client reads and writes the join table
  normally against the *rolled-back* schema, because the restored column is
  `NOT NULL DEFAULT 'MEMBER'` and an insert that omits it takes the database
  default. So a rollback followed by a fix-and-restart of the replacement release
  is a working state, and the only thing outstanding is the leftover column and
  the drift it causes. Roll the schema forward once the release is stable rather
  than while you are still firefighting.

If the replacement application fails after the migration and cannot be corrected
promptly, choose one of exactly two paths: **roll forward** by fixing and starting
the replacement runtime, or **run the verified schema rollback / restore the
backup before restarting the previous version.** There is no third option in which
the old version runs against the migrated schema.

Both directions were rehearsed against a production-shaped database before merge
([§7.2](#72-windowed-migration-rehearsal-20260803030000_contract_drop_family_group_member_role)).

---

## 3. Post-upgrade checklist

Work these after a successful cutover.

### 3.1 Re-enable modules in Admin > Modules

If [§1.2](#12-predict-the-module-flip-clubmodulesettingsupdatedbymemberid)
predicted a flip (`updatedByMemberId` was NULL), the following seven toggles
were reset to **off** by `20260627120000_core_module_defaults_off`. Re-enable
in **Admin > Modules** exactly those that were `true` before the upgrade
(from your [§1.2](#12-predict-the-module-flip-clubmodulesettingsupdatedbymemberid)
capture), after confirming provider/setup readiness for each:

1. `kiosk`
2. `chores`
3. `financeDashboard`
4. `waitlist`
5. `xeroIntegration`
6. `bedAllocation`
7. `internetBankingPayments`

Saving the module page stamps `updatedByMemberId`, so this reset is a one-time
event, not a recurring one.

### 3.1a Confirm the environment role reads *production* (#3034)

Open **Admin > Setup** and read the **Production Or Non-Production** step. It
must say **production**, and **read the message rather than the tick**: a
*non-production* installation also shows a green tick there, because both are
validly configured states and the checklist cannot know which one this
installation is meant to be. The tick means "answered"; the message means "which
answer". **Admin > Setup & Configuration > Environment Safety**
(`/admin/environment`) says the same in more detail.

If it says anything else, member email and writes into the club's Xero
organisation are being held back. Fix `APP_ENVIRONMENT_ROLE` in the production
`.env` and restart.

### 3.2 Re-run the bed-allocation audit category backfill

`20260810020000_backfill_bed_allocation_audit_category` (#2751) moves the stored
audit `category` from `admin` to `lodge` on the bed-allocation and lodge-display
activity records written before #2730 changed where new ones are filed, so that
bed-allocation history reads as one run in the Category filter and in AI
Diagnostics instead of being split at the upgrade date.

`prisma migrate deploy` runs it **before** cutover, while the old colour is still
serving and still filing new bed-allocation records the old way. Every allocation
made in that window is written after the statement has already passed, so it keeps
`admin` permanently unless the statement runs again.

Run the whole `migration.sql` again, verbatim, against the production database
once cutover is complete:

```bash
psql "$DATABASE_URL" \
  -f prisma/migrations/20260810020000_backfill_bed_allocation_audit_category/migration.sql
```

It is idempotent, so this changes nothing anywhere it already ran: the `WHERE`
clause is the state the statement destroys, and its `AUDIT_CATEGORY_BACKFILLED`
record is written only when rows actually moved. Expect either a second such entry
in **Admin → Audit Log** naming the handful of window rows it picked up, or no new
entry at all — both are correct outcomes. Skipping this step is not a failure
either; it leaves those few records under the Admin filter, where **All** still
finds them.

### 3.3 Historical access-role/membership cleanup window

The temporary access-role and membership-type cleanup rehearsal applied only to
forks that deployed an intermediate `main` during the 2026-06-28 .. 2026-06-30
window. That fork migration window is closed, and the disposable-data rehearsal
note has been retired from the living documentation set. A fork upgrading from
a `v0.9.0`-era tag straight to `v0.10.0` does not need this check.

### 3.4 Spot-check money and integrations

- Open the **Xero reconciliation report** and confirm it reconciles; totals must
  match the cent. Money is integer cents — no rounding or rescale is introduced
  by this upgrade, so pre- and post-upgrade totals should agree exactly.
- Spot-check a handful of recent **bookings** and their **payments**: prices,
  captured amounts, and refunds/credits should read identically to before the
  upgrade.

### 3.5 Manual E2E-critical journeys

Drive each critical journey by hand against the live site
(`https://your-domain.example`):

1. **Login**, including **2FA** (the two-factor challenge/session tables ship in
   this release — confirm a 2FA-enrolled member can complete a challenge).
2. **Book** a lodge night (dates render as the expected NZ date-only nights).
3. **Pay** for a booking end to end.
4. **Admin approve** a booking/application.

Any failure here is a signal to consider [§4 rollback](#4-rollback-plan).

### 3.6 Fork automation note: removed `POST /api/bookings/cancel`

The body-based `POST /api/bookings/cancel` route has been removed. If any fork
automation, script, or integration still calls that endpoint, it will now 404 —
repoint it to the current cancellation surface before relying on the upgraded
deployment.

---

## 4. Rollback plan

Rollback follows `docs/BLUE_GREEN_MIGRATION_POLICY.md`. The policy's whole point
is that migrations preserve old-code/new-schema compatibility until the previous
color drains, which makes the rollback boundary the **cutover (step 17)**.

That boundary holds only while every pending migration really is old-code
compatible. It does **not** hold for a migration the ledger declares
`old_code_compatible=windowed`: once its migrate step commits, the old color is
already broken, so the boundary moves back to **step 13 (migrate)** and the
recovery paths are forward to cutover, the migration's own `rollback.sql`, or the
verified backup.

**The ledger now holds three real `windowed` rows**, and they are not the only
migrations in that class. Check for all four:

- `20260803010000_contract_subscription_lockout_drop_enabled` (#2543 / #2561) is
  declared `old_code_compatible=windowed`. It drops `MembershipLockoutSettings.enabled`,
  so the previous release's Prisma client raises on every read of that model the
  moment migrate commits — which means every booking write path on the old colour,
  not just the admin panel. It ships a tested `rollback.sql` and requires the
  maintenance-window sequence in [§2.4](#24-windowed-migration-deploy-sequence).
- `20260803030000_contract_drop_family_group_member_role` (#2520) is declared
  `old_code_compatible=windowed` too. It drops `FamilyGroupMember.role`, which the
  previous release's client names in ordinary projections, in insert column lists
  **and** in a `WHERE` clause (`role: "ADMIN"`), so the moment migrate commits the
  old version fails across the whole family surface — including the member profile
  page. It ships a tested `rollback.sql` and its own ordered sequence at
  [§2.4.1](#241-2520-drop-familygroupmemberrole).
- `20260806010000_fence_hosting_coverage_delivery_claims` (#2596) is declared
  `windowed` because of runtime protocol, not DDL: the old worker can ignore a new
  token-fenced claim. It ships a no-op `rollback.sql`; old/new worker overlap is
  forbidden in both deploy and rollback directions. Pending windowed migrations
  share **one** window.
- **`v0.10.0` has one migration in that class too**, declared before the value
  existed. `20260707000100_backfill_org_age_tier_not_applicable` is
  `old_code_compatible=no`, and its `lock_impact_plan` states plainly that
  "old-color reads of the flipped rows … can error between migrate and cutover"
  (quoted in full at [§2.2](#22-agetier-not_applicable--deploy-in-a-quiet-window)).

So do **not** check the ledger for a `windowed` row alone: check for a `windowed`
row **or** any `yes`/`no` row whose `lock_impact_plan` carries an old-code caveat
(`OLD-CODE CAVEAT`, `RESIDUAL WINDOW`, `CAUTION`, "until cutover", "idle or
routed"). `docs/BLUE_GREEN_MIGRATION_POLICY.md` → "Historical note" gives the
class rule and a starting-point filter.

### Before cutover (up to and including step 13/14/15/16)

**This subsection describes the ORDINARY blue/green deploy.** It does not apply to
a release carrying a `windowed` migration: there the old colour is deliberately
stopped before migrate, so there is no "old colour still serving" state to fall
back into. Use [§2.4](#24-windowed-migration-deploy-sequence) and, for #2520,
[§2.4.1](#241-2520-drop-familygroupmemberrole) instead.

The **old color is still serving traffic**. The rest of this set is
expand-shaped and old-code-compatible, so if the new color fails to come up
healthy, or the warm-up gate refuses, or you abort before step 17, you can stop the deploy and leave the old
color serving the already-migrated (backward-compatible) schema. This is a
blocked upgrade, not an outage. No traffic ever reached the new color.

**Except once step 13 has applied `20260707000100`.** From that point the old
color is reading `NOT_APPLICABLE` rows its Prisma client cannot deserialize, so
aborting leaves the admin members list, those members' detail pages and the
school flows erroring with no cutover coming — a blocked upgrade *and* a partial
outage. If the new color fails its health check after that migration has
committed, go **forward** to cutover if the new color can be made healthy;
otherwise restore from the pre-migrate backup. This is why [§2.2](#22-agetier-not_applicable--deploy-in-a-quiet-window)
offers the fallback of deferring that single migration until the old color has
fully drained: taking it keeps the whole window inside the ordinary
abort-is-safe boundary.

### After cutover (step 17 onward)

Traffic is on the new color. To fall back you re-point Caddy to the previous
color (the engine restores the previous upstream file on a failed reload; a
deliberate rollback is the same operation in reverse) while the old color
containers are still present. Because the schema is expand-only and
old-code-compatible, the previous color can serve against the migrated database —
with the same `20260707000100` exception: the flipped `NOT_APPLICABLE` rows stay
flipped, so a rolled-back old color still errors on the admin members list, those
members' detail pages and the school flows. Re-pointing Caddy restores every
other surface; treat those as still-down until you go forward again or un-flip the
rows as an owner-approved data operation (see below).

### What is NOT reversible by rollback

- **The induction item-results deletion** from
  `20260702100000_induction_workflow_types` is a hard `DELETE` (plus NULLed
  self-assessment fields). Re-pointing Caddy does **not** bring those rows back.
  The [§1.1](#11-verified-restore-tested-database-backup-with-s3-durability-confirmed)
  restore-tested backup is the **only** recovery path for that data.
- The `20260627120000` module-flip and the `20260707000100` AgeTier backfill are
  data changes, not schema removals; they are re-doable/idempotent rather than
  auto-reversed. Re-enable modules via Admin > Modules ([§3.1](#31-re-enable-modules-in-admin--modules)).
  Treat any need to un-flip AgeTier rows as an owner-approved data operation.
- **The `FamilyGroupMember.role` values dropped by `20260803030000`** are gone for
  good: PostgreSQL cannot un-drop a column, and `rollback.sql` can only recreate
  the column and refill it with the safe `'MEMBER'` default. Recovering the actual
  labels needs either the per-row `\copy` dump the pre-migration checks take
  ([§2.4.1](#241-2520-drop-familygroupmemberrole) step 8) or the
  [§1.1](#11-verified-restore-tested-database-backup-with-s3-durability-confirmed)
  backup. Nothing reads those labels — that is why the drop is safe — so this is a
  record-keeping loss, not a behavioural one, with the single fail-closed exception
  named in §2.4.1's rollback boundary.

If a rollback becomes necessary, capture evidence, re-point to the old color to
restore service, and escalate to the owner before any data-repair action.

---

## 5. Invariant reminders

- Money stays in **integer cents** everywhere; this upgrade introduces no
  rescaling or rounding. Reconciliation totals must be cent-identical before and
  after.
- Booking dates stay **NZ date-only lodge nights**; no migration re-times or
  re-zones them.
- The blue/green gate stays idempotent and fails safe; external provider calls
  stay outside long database transactions.

---

## 6. Sign-off gate

- [ ] [§1](#1-pre-flight) pre-flight complete: restore-tested backup PASS, S3
      durability confirmed (#1361), module-flip prediction captured, in-flight
      inductions listed, from/to versions pinned, staging rehearsal recorded.
- [ ] [§2](#2-migrate) migrate: validator gate green (step 12), migrations
      applied (step 13), AgeTier quiet-window observed, warm-up gate green (step
      16), cutover clean (step 17).
- [ ] [§3](#3-post-upgrade-checklist) post-upgrade: modules re-enabled,
      access-role audit run if applicable, money/Xero spot-check clean, all four
      critical journeys pass, fork automation repointed off the removed cancel
      route.
- [ ] Owner present for the window and signs off the
      [execution record](#8-production-execution-record).

---

## 7. Staging rehearsal record

The private deployment fork's **staging** environment has already run the July
wave migrations against a **live-DB snapshot** — that run is the dress
rehearsal for this upgrade. This is asserted **per the 2026-07-06 audit /
issue #1364**. The owner confirms the concrete date and outcome below before the
production window opens.

| Field | Value |
| --- | --- |
| Rehearsal environment | Private fork staging (live-DB snapshot) |
| Wave migrations applied | `v0.9.0`-era → `v0.10.0` set (all pending) |
| Rehearsal date | _<owner to confirm — YYYY-MM-DD>_ |
| Result (PASS/FAIL) | _<owner to confirm — must be PASS before production>_ |
| Notable findings / deviations | _<owner to confirm>_ |
| Confirmed by | _<owner>_ |

> A recorded PASS here is a precondition for [§2](#2-migrate). If the rehearsal
> has not been recorded, do not run production.

### 7.1 Windowed migration rehearsal: `20260803010000_contract_subscription_lockout_drop_enabled`

The repo's first `old_code_compatible=windowed` migration (#2543 / #2561) was
rehearsed both ways before merge, as the owner directive requires. Recorded here
because a windowed migration's rollback path is only a plan until somebody has run
it.

**Environment.** Throwaway PostgreSQL 16.14 container. The **full migration
history** applied to an empty database, then the demo seed, giving a
production-shaped dataset: 35 members, 19 bookings (every status), 40 booking
guests, 13 payments, 8 member subscriptions. The contract migration was held back,
so the starting point was the state the **expand** migration leaves:
`enabled BOOLEAN NOT NULL DEFAULT true` plus a nullable `mode` with no default.

That intermediate state is **not** a deployed release, and it matters where the
distinction lands. Both migrations ship in this one release, so the release actually
running in production has `enabled` and **no `mode` column and no
`SubscriptionLockoutMode` type at all**. The intermediate is nonetheless the correct
pre-state for the four cycles below, because it is exactly what
`prisma migrate deploy` finds when it reaches the contract migration — the expand
migration having just run ahead of it in the same command. Where the previously
deployed schema *is* the thing under test — the previous release's own client — it is
used instead, in "The windowed claim" below.

**Four deploy → rollback cycles**, one per pre-state a real club can hold. Each
applied `prisma migrate deploy`, asserted the post-state, then ran `rollback.sql`
and asserted the restored shape. 24 assertions, all PASS:

| Pre-state (previous release) | After migrate | After `rollback.sql` |
| --- | --- | --- |
| `enabled=false, mode=NULL` — club that deliberately switched the lockout OFF | `mode=NO_BLOCK` | `enabled=false` |
| `enabled=true, mode=NULL` — club that never opened the panel | `mode=HARD_BLOCK` | `enabled=true` |
| `enabled=true, mode=NON_MEMBER_PRICING` — mode already chosen | `mode=NON_MEMBER_PRICING` (not reset) | `enabled=true` |
| `enabled=true, mode=NO_BLOCK` — chosen mode disagrees with the stale boolean | `mode=NO_BLOCK` (chosen mode wins) | `enabled=false` |

Every cycle also confirmed `mode` became `NOT NULL` with
`DEFAULT 'HARD_BLOCK'::"SubscriptionLockoutMode"`, the `enabled` column count went
to zero, and the row's other settings were untouched
(`financialYearEndMonthOverride = 7`, `updatedAt = 2026-05-05 09:00:00` —
unchanged, because this is a schema migration and not an admin edit).

**App-level reads on the migrated schema** (new Prisma client, through the
functions every booking gate uses, on the club that had switched the lockout off):

```
raw row mode            = NO_BLOCK
raw row has 'enabled'   = false
loadMembershipLockout   = mode=NO_BLOCK yearEnd=7 textFallback=true
resolveSubscriptionMode = NO_BLOCK
peekSubscriptionMode    = NO_BLOCK
enforcementActive       = false
APP READ OK
```

**The windowed claim was verified, not assumed — and re-verified against the right
client.** The first pass used a client generated from the expand-only intermediate
schema, which names **both** `enabled` and `mode`. That exercises the dropped column,
but it is not the client an operator rolls back to. So the check was re-run with a
client generated from the previously deployed schema itself
(`git show origin/main:prisma/schema.prisma`), which names `enabled` and **does not
name `mode` anywhere**. Same throwaway container, migrations applied, one
`MembershipLockoutSettings` row (`mode = NO_BLOCK`, `financialYearEndMonthOverride = 7`,
`updatedAt = 2026-05-05 09:00:00`):

- against the **migrated** schema both a read and a write fail, which is what makes
  this migration `windowed` rather than `yes`:
  ```
  === previous-release client against the MIGRATED schema (mode NOT NULL, enabled dropped) ===
  READ FAILED:  [P2022] The column `MembershipLockoutSettings.enabled` does not exist in the current database.
  WRITE FAILED: [P2022] The column `MembershipLockoutSettings.enabled` does not exist in the current database.
  ```
- after `rollback.sql`, the same client reads *and writes* normally:
  ```
  === previous-release client against the ROLLED-BACK schema ===
  READ OK: {"id":"default","enabled":false,"financialYearEndMonthOverride":7,
            "textFallbackEnabled":true,"useFeeScheduleItemCodes":false,
            "updatedByMemberId":null,"createdAt":"2026-05-05T09:00:00.000Z",
            "updatedAt":"2026-05-05T09:00:00.000Z"}
  WRITE OK: enabled -> true
  ```
  Note what the read does **not** contain: `mode`. The previous release's client never
  names the column, which is why leaving it in place is safe — and why `rollback.sql`
  deliberately does not drop it, since after the backfill it is the only record of
  each club's policy.
- the restored column is byte-identical to the one `20260626120000` created,
  `enabled BOOLEAN NOT NULL DEFAULT true`, and the row's other values are untouched.
- the leftovers are exactly the two inert extras, measured rather than assumed.
  `prisma migrate diff` from the rolled-back database to the previous release's
  datamodel reports:
  ```
  ALTER TABLE "MembershipLockoutSettings" DROP COLUMN "mode";
  DROP TYPE "SubscriptionLockoutMode";
  ```
  That is the intended end state, not drift to chase, and `rollback.sql` says so where
  an operator will read it. (Measured before `main`'s unrelated #2553 hold-expiry
  migration was merged into this branch; that migration is additive and does not touch
  `MembershipLockoutSettings`, so the two leftovers above remain the complete list.)

**Backfill correctness** is additionally pinned by
`prisma/migration-verification/20260803010000_contract_subscription_lockout_drop_enabled.ts`,
executed against the same real PostgreSQL by
`src/lib/__tests__/data-migration-verification.realdb.test.ts`: 5 pre-states and
4 mutants, all detected — the inverted `CASE`, an unconditional `HARD_BLOCK`, a
dropped `WHERE "mode" IS NULL`, and leaving `mode` nullable — plus the runner's own
"migration not applied at all" mutant and its requirement that at least one mutant
be caught by a row **mismatch** rather than a raised error.

| Field | Value |
| --- | --- |
| Rehearsal environment | Throwaway PostgreSQL 16.14, full migration history + demo seed |
| Migration | `20260803010000_contract_subscription_lockout_drop_enabled` |
| Rehearsal date | 2026-08-03 |
| Result | **PASS** — 4/4 deploy+rollback cycles, 24/24 assertions, 55/55 fixture assertions |
| Notable findings | One, in the evidence rather than the migration. The first client check was generated from the expand-only intermediate schema, which is not a deployed release; re-run with the previously deployed schema's own client it fails on the migrated shape and reads *and writes* after `rollback.sql`, so the conclusion is unchanged and now rests on the right client. |
| Rehearsed by | Lane implementation session (pre-merge, on PR #2560) |

> This rehearsal used a demo-seeded database, not a production snapshot. Before the
> production window, re-run the same two steps (migrate, then `rollback.sql`)
> against a **restored copy of the production backup** — the settings row's real
> value is the one thing a seed cannot supply.

### 7.2 Windowed migration rehearsal: `20260803030000_contract_drop_family_group_member_role`

The repo's second `old_code_compatible=windowed` migration (#2520) was rehearsed
both ways before merge. Recorded here for the same reason as §7.1: a windowed
migration's rollback path is only a plan until somebody has run it.

**Environment.** Throwaway PostgreSQL 16.14 container (`postgres:16`, Debian
16.14-1). The **full migration history** applied to an empty database with the drop
migration held back, so the starting point is exactly what `prisma migrate deploy`
finds when it reaches it. Four `FamilyGroupMember` rows across two family groups,
covering `'MEMBER'`, `'ADMIN'` and `'LEAD'` plus the shape that matters most: one row
inserted *without naming the column*, so it took `'MEMBER'` from the database
default. `FamilyGroup.billingMembershipId` pointed at one of the rows, because
member-merge re-points that pointer and a `DROP COLUMN` must not disturb it.

**Those three are not all the labels**, and the earlier draft of this section wrongly
said they were. A fourth, `'USER'`, exists in production: the release being replaced
writes it from `createFamilyGroupFromSuggestion` (to every non-lead member of a group
created from a family suggestion) and from the `familyGroupMember.upsert` create arm
in the admin dependent-link route. A supplementary run covering all four is recorded
under "Supplementary run" below; it changed no conclusion, because a metadata-only
`DROP COLUMN` and a constant-default `ADD COLUMN` are both indifferent to the values
in the column.

**Pre-migration checks** — the same four the window prescribes at
[§2.4.1](#241-2520-drop-familygroupmemberrole) step 8, run here to prove the queries
are right before an operator depends on them:

```
 family_group_member_rows        role  | rows      column_name | data_type | is_nullable | column_default
--------------------------      --------+------     -------------+-----------+-------------+----------------
                        4        MEMBER |    2      role        | text      | NO          | 'MEMBER'::text
                                 ADMIN  |    1
                                 LEAD   |    1
```

The per-row `\copy` dump produced `id,role` for all four rows. The column's measured
shape is **`text | NO | 'MEMBER'::text`**, which is what `rollback.sql` claims to
restore and what `20260407120000_add_family_group_member_join_table` created.

**The `windowed` claim was verified, not assumed, against the right client.** A
Prisma client was generated from **`v0.13.2`'s own `prisma/schema.prisma`** — the
last tagged release, which is what production runs when this lands because the
runtime half was never deployed separately. That client's scalars are
`id,familyGroupId,memberId,role,joinedAt`. Three call shapes were exercised, one per
mechanism the ledger row names:

| Old-client call | Pre-migration | After migrate | After `rollback.sql` |
| --- | --- | --- | --- |
| unnarrowed `findMany` (names every scalar in the `SELECT`) | OK, 4 rows | **FAILED `[P2022]`** | OK, 4 rows |
| `where: { memberId, role: "ADMIN" }` (the one-step partner read) | OK, 1 row | **FAILED `[P2022]`** | OK, **0 rows** |
| `create` setting **no** role, narrowed to `select: { id: true }` | OK | **FAILED `[P2022]`** | OK |

```
=== previous-release (v0.13.2) client against the MIGRATED schema (role dropped) ===
old client scalars: id,familyGroupId,memberId,role,joinedAt
READ   FAILED: [P2022] The column `FamilyGroupMember.role` does not exist in the current database.
FILTER FAILED: [P2022] The column `FamilyGroupMember.role` does not exist in the current database.
WRITE  FAILED: [P2022] The column `role of relation FamilyGroupMember` does not exist in the current database.
```

The **write** result is the one worth reading twice: that call sets no role and
narrows itself with `select`, and it still fails — because a static
`@default("MEMBER")` is materialised client-side as a bind parameter, so the column
is in the `INSERT` column list regardless. That is the claim in the ledger row that
would have been easiest to get wrong, and it is measured here rather than reasoned
about.

**After migrate.** The column is gone, the four surviving scalars are
`id, familyGroupId, memberId, joinedAt`, `_prisma_migrations` records the migration
**once** with `applied_steps_count = 1` and no rolled-back marker, all **4 rows
survive**, and `FamilyGroup.billingMembershipId` still points where it did.
`prisma migrate diff` from the migrated database to this branch's
`prisma/schema.prisma` reports **"No difference detected"** — the schema-field
removal and the migration agree, which is what the CI drift gate checks.

**The replacement runtime cannot name the column**, asserted three ways:

- the generated client's `FamilyGroupMemberScalarFieldEnum` is exactly
  `id,familyGroupId,memberId,joinedAt`;
- **none** of the `FamilyGroupMember*` type blocks in the generated `index.d.ts`
  names `role`. **Counting method, stated once so a re-derivation lands on the same
  number:** count declarations of a `type` or `interface` whose name begins
  `FamilyGroupMember`, then brace-match each one's body and search it for the
  identifier `role`. In `node_modules/.prisma/client/index.d.ts` that is **98
  declarations** (97 distinct names — one name is declared twice), and **zero** of
  the 98 bodies names `role`. Count only distinct names and you get 97, which is why
  the method matters more than the figure;
- an unnarrowed `findMany` on the **replacement** client against the **migrated**
  database returns rows normally.

The exact enforcement is worth stating precisely, because the shorthand overstates
it and the difference is why the old delegate-scan guards could be retired:

| Call shape naming `role` on the replacement client | Result |
| --- | --- |
| `where: { role: "ADMIN" }` | **compile error** — `'role' does not exist in type 'FamilyGroupMemberWhereInput'` |
| `select: { id: true, role: true }` | compiles; **`PrismaClientValidationError`** at runtime, before any SQL |
| `create({ data: { …, role: "ADMIN" } })` | compiles; **`PrismaClientValidationError`** at runtime, before any SQL |

So **no call shape emits SQL naming the column** — there is no route to a Postgres
42703 from the replacement runtime — but only the `WHERE` shape is caught by `tsc`.
The other two fail loudly and unconditionally on first invocation instead. The
implicit hazard the old guard existed for (an `include:` naming the column with no
author intent) is structurally impossible now, which is the basis on which the
delegate scans were deleted from
`src/lib/__tests__/family-group-role-retirement.test.ts`.

**Rollback direction.** `rollback.sql` run by hand as the migration role:

- it restored `role | text | NO | 'MEMBER'::text` — **byte-identical** to the
  original column, confirmed by the script's own verification query;
- all **4 rows** came back populated, all `'MEMBER'`, in the one `ALTER TABLE`
  statement (constant default, no table rewrite);
- the `v0.13.2` client then read, filtered **and wrote** normally again;
- the filter returned **0 rows**, which is the documented cost measured rather than
  predicted: with every row back as `'MEMBER'` nobody holds `ADMIN`, so the
  one-step partner declaration finds no candidates and fails **closed**. Nothing
  else about family groups changed.

**The exact-value restore was exercised too**, since it is the only way
back to the real labels and a commented block nobody has run is not evidence. The
step-3 block in `rollback.sql`, run as a `psql -f` script (the `\copy`
meta-command needs a script file, not `-c`), loaded the pre-migration dump and
reported `UPDATE 2` — the two rows that differed — leaving
`fgm-admin=ADMIN, fgm-lead=LEAD, fgm-plain=MEMBER, fgm-default=MEMBER`, exactly the
pre-migration state.

**Roll-forward after a rollback was rehearsed too**, because it is prescribed in
four places (this section, §2.4.1's rollback boundary, `DEPLOYMENT.md`, and the
`rollback.sql` header) and a prescribed step nobody has run is not evidence. It was
also the direction with the nastiest surprise:

| Command, run on the rolled-back database | Answer |
| --- | --- |
| `prisma migrate status` | **"Database schema is up to date!"** |
| `prisma migrate deploy` | **"No pending migrations to apply."** |
| `migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma` (the deploy script's own gate, step 12/19) | **"No difference detected", exit 0** |
| `migrate diff --from-config-datasource --to-schema prisma/schema.prisma` | `[-] Removed column role`, **exit 2** |

One practical note on the third row, since it is the only command in this table an
operator cannot simply paste. `--from-migrations` replays the history into a shadow
database, so by hand it refuses with *"You must set `datasource.shadowDatabaseUrl`
in your `prisma.config.ts`"* unless `SHADOW_DATABASE_URL` is set — which is why it
is the deploy script's gate and not yours: that script creates a throwaway shadow
database and passes the variable itself
(`scripts/run-production-blue-green-deploy.sh`, `create_shadow_database`). The
command in the rollback boundary below, `--from-config-datasource`, needs no shadow
database and is the one to run by hand.

The first three are a **false all-clear**: `_prisma_migrations` still records the
migration as applied (`applied_steps_count = 1`, no rolled-back marker), and the
deploy script's drift gate compares committed history to the schema file, so it
never reads the live database at all. Only the database-vs-schema diff sees the
restored column. That is the command to run before trusting a rolled-back database,
and it is now named in the rollback boundary.

Both documented roll-forward paths were then run to completion:

| Roll-forward path | Result |
| --- | --- |
| re-apply `migration.sql` by hand as the migration role | column dropped again, history row untouched and already correct, `migrate diff` **no difference**, all rows intact |
| `DELETE` the `_prisma_migrations` row, then `prisma migrate deploy` | migration re-applied and the history row rewritten, `migrate diff` **no difference**, all rows intact |

Re-applying by hand is the recommended path: same end state, and it does not edit
the migration history. Two smaller measured facts came out of the same run. The
replacement client **works against the rolled-back schema** — an unnarrowed
`findMany` returned its rows and a `create` that omits the column succeeded, taking
`'MEMBER'` from the database default — so a rollback does not force a schema
roll-forward before the replacement release can start. And `rollback.sql` is **not
idempotent**: a second run fails with `ERROR: column "role" of relation
"FamilyGroupMember" already exists`, which is the safe direction (a loud refusal,
not a silent double-apply) but worth knowing at 2am.

**The schema-changing part of the combined-window rollback was rehearsed in reverse
order**, since this release carries two schema-removal windowed migrations and
rolling back only one is the failure mode the
rollback boundary now calls out. With both applied, running
`20260803030000/rollback.sql` and then
`20260803010000_contract_subscription_lockout_drop_enabled/rollback.sql` restored
`FamilyGroupMember.role` as `text | NO | 'MEMBER'::text` **and**
`MembershipLockoutSettings.enabled` as `boolean | NO | true`, with the settings row
mapping `HARD_BLOCK` back to `enabled = true` as its own script documents, and
every `FamilyGroupMember` row intact. The two touch different tables, so neither
order can corrupt the other; reverse order is the rule because it is the one that
generalises.

**The gates were exercised in all three directions**, not just the passing one:

| `scripts/validate-blue-green-migrations.sh` on this migration | Result |
| --- | --- |
| no override | **refuses**, exit 1 — names the `DROP COLUMN` and the `windowed` ledger declaration |
| override + reason but no `BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED=1` | **refuses**, exit 1 — the maintenance window is not operationally proven |
| override + reason + stopped-old-runtime acknowledgement | passes, exit 0, echoing the reason |
| override present but `rollback.sql` deleted | **refuses**, exit 1 — a documentation failure the override cannot rescue |

**Independently re-run before merge, from scratch.** Because everything above is
evidence for an irreversible change, the rehearsal was repeated on a *second*
throwaway container by a session that had not run the first one and treated the
recorded transcript as a claim to be refuted rather than a result to be trusted.
Same environment (`postgres:16`, measured `16.14 (Debian 16.14-1.pgdg13+1)`), full
history applied with the drop held back, four rows seeded the same way. Every
number and message above reproduced: the pre-migration checks (4 rows;
`MEMBER 2, ADMIN 1, LEAD 1`; `role | text | NO | 'MEMBER'::text`), the surviving
scalars after the drop (`id, familyGroupId, memberId, joinedAt`) with all four rows
and `FamilyGroup.billingMembershipId` intact, `rollback.sql` restoring
`text | NO | 'MEMBER'::text` with every row `'MEMBER'`, its second run refusing with
`column "role" of relation "FamilyGroupMember" already exists`, the exact-value
restore reporting `UPDATE 2` and returning `fgm-admin=ADMIN, fgm-lead=LEAD`, the
false all-clear on all three commands, `--from-config-datasource` exiting 2 with
`[-] Removed column role`, re-applying `migration.sql` by hand leaving no drift and
the history row untouched, and the validator refusing / passing / refusing again in
the three directions above (exit 1, 0, 1). The generated-client proof was re-derived
too: scalars `id,familyGroupId,memberId,joinedAt`, zero of the 98
`FamilyGroupMember*` blocks in the generated `index.d.ts` naming `role`, and a live
`tsc` probe confirming the asymmetry — `where: { role: "ADMIN" }` fails with
`TS2353 … 'role' does not exist in type 'FamilyGroupMemberWhereInput'` while
`select: { role: true }` compiles, exactly as the table above states. Nothing was
found that contradicted the record; the shadow-database note above was the only
thing added.

**Supplementary run: the fourth label, and where the dump actually lands** (same
`postgres:16` image, measured `16.14 (Debian 16.14-1.pgdg13+1)`, 2026-08-04). Two
claims in the record above needed measuring rather than reasoning about, and both are
now closed:

- **All four labels, not three.** Five rows seeded in the column's original
  `20260407120000` shape: `'ADMIN'`, `'LEAD'`, `'USER'`, `'MEMBER'`, plus one row
  inserted without naming the column. Step 8(b) returned
  `MEMBER 2, ADMIN 1, LEAD 1, USER 1`; 8(c) returned
  `role | text | NO | 'MEMBER'::text`. The `DROP COLUMN` then left
  `id, familyGroupId, memberId, joinedAt` with all **5 rows** intact, `rollback.sql`
  step 1 restored `text | NO | 'MEMBER'::text` with **every row `'MEMBER'`** —
  including the former `'USER'` row — and a second run refused with
  `column "role" of relation "FamilyGroupMember" already exists`. Identical behaviour
  to the three-label run, as expected of a metadata-only statement.
- **The step 8(e) dump has to be taken to a host path.** Run the way an operator on a
  Docker-only host must run psql, the old `\copy` form
  (`\copy (…) TO 'family-group-member-role-<DATE>.csv' CSV HEADER`) reported
  `COPY 5` and wrote the file to **`/family-group-member-role-<DATE>.csv` inside the
  postgres container's own writable layer** — confirmed absent from the host and
  absent from `/var/lib/postgresql/data`, so it is in neither the `postgres_data`
  volume nor any backup path, and it does not survive a container recreate. The
  step 8(e) replacement (`COPY … TO STDOUT WITH (FORMAT csv, HEADER)` redirected on
  the host) produced the same 88-byte CSV **on the host**. Copied back in and fed to
  `rollback.sql` step 3, it reported `COPY 5` / `UPDATE 3` and restored
  `fgm-admin=ADMIN, fgm-lead=LEAD, fgm-user=USER` exactly, leaving the two genuine
  `'MEMBER'` rows alone.
- **Backup verification inside the window.** `gzip -t` on a truncated `.sql.gz` exits
  1 with `unexpected end of file`; a complete dump carries
  `-- PostgreSQL database dump complete`. `pg_restore --list` does **not** work on
  these artifacts — it refuses with
  `input file appears to be a text format dump. Please use psql.` — which is why
  step 7 prescribes the first two and not the third.

| Field | Value |
| --- | --- |
| Rehearsal environment | Throwaway PostgreSQL 16.14, full migration history, rows covering `'MEMBER'` / `'ADMIN'` / `'LEAD'` + one database-default row; supplementary run adds `'USER'` |
| Migration | `20260803030000_contract_drop_family_group_member_role` |
| Rehearsal date | 2026-08-03, extended 2026-08-04 (roll-forward and combined rollback), independently re-run from scratch 2026-08-04, supplementary run 2026-08-04 (fourth label, dump location, backup verification) |
| Result | **PASS** — migrate, `rollback.sql` both ways, the exact-value restore, both roll-forward paths, the combined two-migration rollback in reverse order, and the supplementary four-label + host-side-dump run; no drift at the end of any path; all three validator directions as expected |
| Notable findings | Five, all in the documentation rather than the migration. (1) Earlier drafts said naming the column is "a compile error" on the replacement client. Measured, only the `WHERE` shape is; `select` and `create`-data compile and are rejected by the client before any SQL. The conclusion (no SQL can name the column) is unchanged, and the schema comment, migration header, domain invariant and guard test were corrected to say the measured thing. (2) After `rollback.sql`, `migrate status`, `migrate deploy` **and the deploy script's own drift gate** all report a clean database; only a database-vs-schema `migrate diff` sees the restored column. The rollback boundary now names that command. (3) The documented migrate command for the window was `npx prisma migrate deploy`, which neither runs the safety validator (a separate script, invoked only by the deploy script) nor exists on the deploy host or in the runner image. Step 9 was rewritten as an explicit validator call followed by the compose `migrate` service. (4) Every artefact claimed three labels ever existed. There are four — `'USER'` is written by two live paths in the release being replaced — so the enumeration, step 8(b)'s stated expectation and the rollback's reasoning were all corrected, and the "it is already the value" ground for `'MEMBER'` was withdrawn because #2565 was never deployed, which makes the set of rows it describes empty in production. The per-row dump was promoted from recommended to **required** on the same finding. (5) The dump landed inside the postgres container rather than on the host; step 8(e) now takes it host-side. |
| Rehearsed by | Lane implementation session (pre-merge, on the #2520 contract PR), then independently re-run from scratch by a second session that had not performed the first, then a supplementary run by the review-fix session |

> This rehearsal used seeded rows, not a production snapshot. Before the production
> window, re-run migrate and `rollback.sql` against a **restored copy of the
> production backup**. The real distribution of `role` values is the one thing a
> seed cannot supply — and it is exactly what step 8(b) records, since after the
> drop it cannot be recovered from the database at all.

---

## 8. Production execution record

Fill this in live during the production window.

| Field | Value |
| --- | --- |
| Execution date | _<YYYY-MM-DD>_ |
| Operator | _<name>_ |
| Owner present | _<name>_ |
| From version (tag / SHA) | _<...>_ |
| To version (tag / SHA) | _<v0.10.0 / SHA>_ |
| Backup object id (restore-tested) | _<...>_ |
| S3 durability confirmed (#1361) | _<yes/no>_ |
| Module-flip predicted (updatedByMemberId NULL?) | _<yes/no + toggles to re-enable>_ |
| In-flight inductions affected (count) | _<...>_ |
| Validator gate result (step 12) | _<green / details>_ |
| Windowed migration: pre-migration check output (§2.4.1 step 8) | _<paste 8(a) row count, 8(b) distinct role values + counts, 8(c) column shape, 8(d) replacement-client scalars>_ |
| Windowed migration: per-row role dump (§2.4.1 step 8(e), REQUIRED) | _<host filename + the durable location it was moved to, beside the backup>_ |
| Windowed migration: override reason used (§2.4.1 step 9a) | _<the exact BLUE_GREEN_MIGRATION_OVERRIDE_REASON string>_ |
| AgeTier plan (quiet window / deferred backfill) | _<...>_ |
| Cutover time (step 17) | _<HH:MM TZ>_ |
| Modules re-enabled | _<list>_ |
| Access-role audit run / result | _<n/a or PASS>_ |
| Money + Xero spot-check | _<clean / notes>_ |
| Critical journeys (login+2FA / book / pay / approve) | _<pass/fail each>_ |
| Post-checklist sign-off (owner) | _<name + time>_ |
