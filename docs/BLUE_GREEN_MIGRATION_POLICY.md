# Blue/Green Migration Policy

Production deploys run Prisma migrations before the new web color receives traffic while the old color can still be serving requests against the shared Postgres database. Every committed migration must therefore preserve old-code/new-schema compatibility until the previous color has drained.

## Required Sequence

- Expand release: add nullable columns, new tables, new indexes, dual-write/backfill support, or compatibility views without removing the old shape used by the currently live app.
- Runtime release: move all reads and writes to the new shape while still tolerating the old one.
- Contract release: remove old columns, tables, indexes, enum values, token fields, or compatibility code only after the previous deployed runtime no longer depends on them.

Destructive contract migrations must name the previous expand/runtime release in `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` and must declare `old_code_compatible=yes` — meaning *genuinely* compatible, because the migration carries a compensating pattern (for example a `SET NOT NULL` paired with a same-column non-NULL `SET DEFAULT`, so an old color's omitted-column `INSERT` still succeeds).

If that cannot be true, the migration is not valid for a normal blue/green deploy and needs a separate maintenance/bootstrap plan. **Declare that plan in the ledger as `old_code_compatible=windowed`** — do not assert `yes` and leave the caveat to prose.

### `old_code_compatible`: the three values

The ledger's fourth column is a closed vocabulary, and the validator rejects anything else outright. It checks **every row in the file**, not only the rows of the migrations pending for a deploy: most ledgered migrations match none of the SQL patterns below, so before #2288 their fourth column was read by nothing and a near-miss spelling — `Windowed`, `WINDOWED`, `maybe`, blank — silently disarmed the declaration while the gate reported "safety check passed". The same pass rejects a **duplicate** row for one migration, because only the first row is ever read and a silently shadowed row is most likely to be the `windowed` one two lanes raced to write.

| Value | Meaning |
| --- | --- |
| `yes` | Genuinely old-code compatible. The previous color keeps working throughout migrate → cutover, because the migration is additive or carries a compensating pattern. |
| `windowed` | **Not** compatible. The previous color may error or violate a mixed-runtime protocol between migrate and cutover. Requires a maintenance window, the `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS` override, and `BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED=1` only after the old web color and all old workers have stopped. |
| `no` | The migration has no breaking SQL matched by the deploy guard, so there is nothing to acknowledge. Read the row's `lock_impact_plan` anyway — see the historical note below. |

A migration matching the guard's breaking patterns must be `yes` or `windowed`; `no` fails. `windowed` additionally requires the incompatibility **and** the window plan to be written into `lock_impact_plan`, so it cannot become a quieter way to say `yes`. A `windowed` row also forces the override and stopped-old-runtime acknowledgement even when no SQL pattern matched — a data-only migration can make the old client unable to deserialize rows, and an additive migration can introduce a claim protocol the old worker ignores. In both cases the ledger row is the only place that knows.

### A `windowed` migration moves the rollback boundary

For an ordinary migration the rollback boundary is the **cutover**: everything up to it is reversible by aborting, because the already-migrated schema still serves the old color (`docs/PRODUCTION_UPGRADE_RUNBOOK.md` [§4](PRODUCTION_UPGRADE_RUNBOOK.md#4-rollback-plan)).

For a `windowed` migration the boundary moves back to the **migrate step**. Once migrate commits, the previous color is already broken, so aborting the deploy no longer restores service — going back means going *forward* to cutover, or restoring from backup. Therefore:

- Take and verify a fresh database backup immediately before migrating, not merely before the deploy.
- Write a reverse script and keep it **beside the migration**, as `prisma/migrations/<migration>/rollback.sql`, so the schema change can be undone without a restore. **The validator enforces this**: a `windowed` row whose migration folder has no `rollback.sql` fails the gate as a documentation failure, at PR time and at deploy time, and the `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS` override does not rescue it. If the change genuinely cannot be reversed, commit a `rollback.sql` that says so and names the recovery path — an operator finding an empty folder mid-window is the failure this check exists to prevent. The file's *contents* are still inert: Prisma and every other gate address a migration folder by its `migration.sql` alone, so `rollback.sql` is never applied, never checksummed, and only ever run by an operator on purpose.
- Keep the migrate → cutover gap as short as the plan allows, and say in `lock_impact_plan` what the old color will do during it.

Historical note: before `windowed` existed the gate hard-required `yes`, so every breaking migration declared it whether or not it was true and the field carried no information for exactly the migrations that most needed scrutiny. Two classes of row predate the value and are more accurately `windowed`.

This note deliberately gives you the **class rule, not a list**. An enumeration here goes stale the moment somebody adds a row: an earlier draft of this note named four migrations when the ledger already held at least nine of them, including the enum rename #2288 was built around — and the artefact written to stop an auditor misreading the record was itself the misleading one. Read the classes off the ledger:

- **`yes` in the operator-acknowledgement sense.** A row whose `lock_impact_plan` tells the operator to keep old-colour traffic idle, drained, or routed to the new runtime, or names a surface that errors "until cutover". Most say so in the text — `OLD-CODE CAVEAT`, `RESIDUAL WINDOW`, or "`old_code_compatible=yes` is asserted in the promo-redesign sense". Do **not** filter by `phase`: the class is defined by the plan text, and while most of these are `contract`, `20260717170000_joining_fee_model` is an `expand` row whose caveat is money-affecting. `20260526120000_promo_code_per_individual_redesign` is the canonical row the later ones cite; `20260525010000_align_booking_change_request_with_review_queues` (the enum rename this rule came from), `20260708220200`, `20260708220300`, `20260709130000`, `20260714140000`, `20260717170000` and `20260719170000` are all in the class today.
- **`no` used to flag a genuinely incompatible *data* migration** that tripped none of the breaking patterns — `20260528120000_add_booking_admin_review_workflow` ("old code … is not treated as fully enum-compatible with backfilled `AWAITING_REVIEW` rows") and `20260707000100_backfill_org_age_tier_not_applicable` (pre-#1440 clients cannot deserialize `NOT_APPLICABLE`).

The `no` class needs no filter and cannot go stale: the ledger holds exactly two `no` rows in total, and both are named above. `awk -F'\t' '$4 == "no"' docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` proves it in one line.

For the `yes` class, a mechanical starting point — it is a **starting point, not a definition**, and you must read each row it returns:

```bash
awk -F'\t' '$4 == "yes" && $5 ~ /OLD-CODE CAVEAT|RESIDUAL WINDOW|CAUTION|until cutover|drained|idle or routed/' \
  docs/BLUE_GREEN_MIGRATION_SAFETY.tsv
```

It **over-collects**, because a caveat can be about the **new** colour rather than the draining one — `20260716140000_xero_member_grouping` and `20260729180000_add_payment_manual_mark_paid` both carry an `OLD-CODE CAVEAT` heading and are genuinely `yes` for the old colour. It can equally **under-collect**, because the wording is not standardised: the `no` row `20260528120000_add_booking_admin_review_workflow` states its incompatibility in prose that matches none of these phrases. The class is what the plan text *says*, not what the grep finds.

Every one of these rows is deliberately left as it was declared rather than rewritten: rewriting would falsify the record of what was declared at the time, and each row's `lock_impact_plan` already carries the real caveat. New rows use `windowed` for both cases.

### The first real `windowed` row, and what it demonstrates

`20260803010000_contract_subscription_lockout_drop_enabled` (#2543 / #2561) is the first migration declared `windowed` rather than back-fitted into `yes`. It is worth reading as the worked example, because it shows what the value buys and what it does not waive.

It drops `MembershipLockoutSettings.enabled` in the **same release** that added the `mode` column replacing it — the owner chose one release with a maintenance window over keeping dual-read/dual-write alive for a later contract release. So `previous_expand_release` names a migration that has *not* drained, which is precisely why `yes` would be false: the previous release's Prisma client names the dropped column on every read of that model, and the booking gates resolve the club's lockout policy through that read, so the old colour cannot take a booking between migrate and cutover. That claim was verified rather than asserted — a client generated from the previous schema fails with `The column MembershipLockoutSettings.enabled does not exist in the current database`, and recovers after `rollback.sql`.

Three things the declaration did **not** get out of, and should not have:

- **The expand/contract paperwork still applies.** `DROP COLUMN` matches the destructive-removal pattern, so the row is `phase=contract` with a real `previous_expand_release`. `windowed` describes compatibility, not sequencing; it is not a way to skip naming what came before.
- **`rollback.sql` is mandatory and unrescuable.** The validator fails a `windowed` row with no reverse script as a *documentation* failure, which `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS` cannot override. Deleting the file was tried during implementation to confirm the gate really bites.
- **The window has to be written down.** `lock_impact_plan` carries the incompatibility, the ordered deploy sequence (build images, verify a fresh backup, remove traffic, stop the old app *and* workers, migrate, start the new release), and the rollback mapping. The operator-facing version of the same sequence is in `DEPLOYMENT.md` → "Windowed migrations" and `docs/PRODUCTION_UPGRADE_RUNBOOK.md` → "Windowed migration deploy sequence"; the rehearsal transcript is recorded in that runbook's §7.1.

A backfill inside the same migration also makes it data-rewriting, so it carries a verification fixture under `prisma/migration-verification/` like any other. See "Data-migration verification" below.

### The second `windowed` row, and where it differs

`20260803030000_contract_drop_family_group_member_role` (#2520) is the second. It drops `FamilyGroupMember.role`, and its ledger row follows the first one's shape deliberately — same `phase=contract`, same mandatory `rollback.sql`, same written-down window, same verified-not-asserted claim (a client generated from `v0.13.2`'s own schema fails on the migrated shape and recovers after `rollback.sql`). Three differences are worth recording, because each is a shape a future `windowed` row may hit:

- **`previous_expand_release` had nothing truthful to name.** The runtime half this contracts against is PR #2565, which shipped **no migration at all** — it removed every reader and writer and added an `@ignore`, which changes no database state. So the field names an *adjacent* migration in the same release (the first windowed row above) and the `lock_impact_plan` carries the real sequencing fact. `previous_expand_release` is documentation the validator only checks for non-emptiness; when it cannot be true, say what is true in the plan column rather than inventing a folder. The narrower practice — one field, so name one migration and explain the rest in `lock_impact_plan` — is the #2130 contract row `20260721130000`, whose two dropped column groups had two different expand releases. Do **not** read that row as a precedent for this shape: its field names a real expand release that was already deployed (`20260717140000_pricing_rekey_by_membership_type`), and its row is `old_code_compatible=yes` on the strength of it. This is the first row where no expand-release folder exists at all, and the honest declaration that follows from that is `windowed`.
- **No DML, so no verification fixture.** The migration is one `DROP COLUMN` and rewrites no rows, so `scripts/check-data-migration-verification.sh` classifies it as shape-only and demands nothing. `windowed` and *data-rewriting* are independent properties.
- **The rollback restores the SHAPE but not the VALUES.** PostgreSQL cannot un-drop a column, so `rollback.sql` recreates it and refills every row with a single **safe compatibility value**. Where a `windowed` rollback cannot reconstruct history, the row and the script must both say which value was chosen, why it is safe, and what choosing it costs — here `'MEMBER'`, at the cost of one fail-closed convenience path on a rolled-back release. Reconstructing the privileged label by heuristic was considered and rejected: guessing in the granting direction is the one mistake a rollback script must not make.

  Two rules came out of getting this wrong first. **State the grounds that actually bear weight, and drop the ones that do not.** The first draft led with "it is the column's own default, so it is already the *actual* value of every row written since the runtime half" — which sounds like the strongest ground and is in fact empty here, because the runtime half was never deployed on its own and the window stops the old app before migrating, so no such row exists in production. The ground that carries the decision is that only the *privileged* label was ever read, which makes any inert label fail-closed whatever the row held. A safe-value argument that describes an empty set invites an operator to treat the value as free.

  **And be exhaustive about the label set before reasoning from it.** Every artefact in the first pass said three labels ever existed; a fourth was written by two live paths in the release being replaced. Enumerate from the migration history *and* from every writer in the tree's history, not from the schema comment.

  The paired practice is on the operator side: because the compatibility value is a substitute rather than the actual value, the runbook's pre-migration per-row dump is **required**, not recommended, and it has to land somewhere durable — the first draft's `\copy` wrote inside the database container, which the deploy recreates.

An owner directive can also move a migration *into* this class. #2520 was planned as an ordinary two-release retirement with a soak and an `old_code_compatible=yes` contract row; the owner replaced that with a windowed one-release drop on 3 Aug 2026. The schema comment and the domain-invariant text describing the old plan were **corrected** rather than left standing, on the same rule the #2561 correction used: the "leave rows as declared" convention above protects the historical record of what an operator actually deployed under, and nobody had deployed under the superseded plan.

## An epic's migrations arrive together, and that constrains what a child may do

Since #3002 an epic's children merge into an integration branch and the epic
reaches `main` as one merge, so **every migration in the epic lands in a single
deploy.** Two consequences bind each child:

- **No child may pair an expand with its own contract.** The contract release's
  whole definition is that the previous runtime *no longer depends* on what is
  being removed, and `previous_expand_release` has to name a migration that has
  actually drained. Inside one deploy nothing has drained. A contract half
  therefore waits for a release *after* the epic merges — which is a scheduling
  fact to plan for at the start of an epic, not a discovery to make at its end.
- **Each migration must be old-code compatible against the PRE-EPIC release**,
  not merely against its siblings. The colour draining at cutover is running the
  code from before the epic, so that is the client every migration in the epic
  has to stay readable by.

Because the whole set arrives at once, the epic's own pull request rehearses it:
apply every migration in the epic to a throwaway PostgreSQL holding pre-epic
data, then run the **previous release's** Prisma client against the migrated
schema. That is the technique both `windowed` rows above were verified with
rather than asserted, and with a whole epic in one deploy it is the only way to
prove the compatibility claim. Migration prefixes are reserved per child in the
epic body up front, and the duplicate-prefix check runs on every merge into the
integration branch rather than only at pull-request time.

### The expand/contract half is ENFORCED, not merely written here

`scripts/check-migration-safety-coverage.sh` fails when a migration **this change
adds** is `phase=contract` and its `previous_expand_release` names a migration
**this change also adds**. That is the mechanically decidable form of the rule
above, and it catches the same defect on an ordinary pull request as on an epic
branch. It runs in `migration-drift`, which is a required check.

The base it compares against is `--base <ref>` (or `MIGRATION_SAFETY_BASE_REF`),
default `origin/main`, by merge base. **The default is what gives it epic-wide
reach:** for a child targeting `epic/<n>`, the merge base of `origin/main` and
that child's head is the epic's branch point, so the added set is the whole epic
so far plus this child — a child adding a contract for an expand an *earlier*
child added fails at child-PR time, not only at `epic → main`. It **fails closed**
on an unresolvable ref, an all-zero SHA, unrelated histories, or a shallow clone;
that last one is why `migration-drift` checks out with `fetch-depth: 0`, because
on a depth-1 clone `git merge-base` does not error, it returns HEAD, and the
added set would come back empty over the very pair the check exists to catch.

**The acknowledgement, for the case the owner really does want.** A blanket
refusal would have blocked the two genuine `windowed` rows above — an
owner-chosen one-release drop behind a maintenance window — and a gate with no
way to say that gets deleted rather than satisfied. So the contract row's own
`lock_impact_plan` may carry:

```
SAME-RELEASE EXPAND/CONTRACT ACKNOWLEDGED: <at least 40 characters of reason>
```

A bare marker is refused; the reason is the point. It lives beside the window it
describes rather than in a separate allowlist that could drift, and every
acknowledgement is printed and counted in the check's summary, so it is never
silent. It is not a cheap escape either: **the check refuses an acknowledgement on a row
that does not declare `windowed`**, and the coverage check then demands that
row's `rollback.sql`. Both were an assertion until #3002's review — an
acknowledged row declaring `yes` shipped no reverse script, and a test was
asserting that defect rather than catching it.

**A `previous_expand_release` must name a migration that exists**, which check 5
enforces. It is not tidiness: check 4 decides whether the named expand is part of
this change by matching that string against directory names, so a dropped word in
a sixty-character hand-typed name silently turns the whole check off for that row,
and nothing else in the repository validated it. It applies to any row naming a
previous release rather than only a contract one — "if you name it, it must
exist" is a rule a reader can hold — and the failure offers the near-miss sharing
the same timestamp.

### Rehearsing an epic's deploy

```bash
npm run db:rehearse-epic -- --database-url <throwaway> [--base <ref>] [--seed-sql <file>]
```

Creates and drops its own scratch database, applies the base ref's migrations,
applies the migrations this change adds, generates a Prisma client from the
**base ref's** `prisma/schema.prisma`, and reads every model with it — which is
what proves the draining colour can still deserialise. It refuses to run against
anything that is not obviously disposable: the URL must be passed explicitly and
never falls back to `DATABASE_URL`; the host must be loopback; **port 5432 is
refused outright**; the URL may carry **no query string at all**, because
node-postgres reads `?host=` *and* `?port=` out of one and either walks straight
past the host and port checks; the **server** must hold no databases beyond the
one named and `postgres`; and the target itself must hold zero tables. The last
two came out of #3002's review — a maintenance database on a production cluster
is empty, so without them loopback-and-not-5432 was the only thing standing
between the script and `CREATE DATABASE` on a live server.

**What a green run does not prove**, because a rehearsal that overclaims is worse
than none: it does not exercise writes, the application's own query shapes, the
exact previously-released client binary, value decoding for a model that happens
to be empty, `rollback.sql`, or the operational sequence. The pre-epic state is
whatever the base migration chain itself plants, which is what a real install on
that release holds — the script reports the row count per model so that is
visible rather than assumed, and takes `--seed-sql` where a column *type* changed
and representative values matter.

It is **run by hand on the epic's pull request** rather than in CI. Automating it
would need a third service **server**, not merely another database on an existing
one: the cluster guard refuses a server holding databases it does not recognise,
and `migration-drift`'s is populated by the time that job runs. Plus a step-level
condition on whether the diff adds a migration. That is a reasonable thing to
build later; it is not a reason to skip the rehearsal now.

The full model, including merge authority and the narrow inert-child exception,
is [`agents/ISSUE_WORKFLOW.md`](agents/ISSUE_WORKFLOW.md) → "An epic reaches
`main` as ONE merge".

## Deploy Gate

`scripts/run-production-blue-green-deploy.sh --internal-blue-green-deploy` calls `scripts/validate-blue-green-migrations.sh` before `prisma migrate deploy`. The validator checks pending migration SQL for:

- destructive schema removals, renames, type changes, `SET NOT NULL`, and constraint drops
- **enum-value renames** — `ALTER TYPE … RENAME VALUE` (#2288). Renaming a value inside a Postgres enum is genuinely breaking: the draining old color keeps sending the old label and Postgres answers `invalid input value for enum`. It is caught by **two** patterns, exactly as `RENAME COLUMN` is: the bare phrase `RENAME VALUE`, plus `ALTER TYPE … RENAME` as the backstop for a statement wrapped between the two words. The backstop also closes a standalone **type** rename, `ALTER TYPE "X" RENAME TO "Y"`, which no pattern matched before. `ALTER TYPE … ADD VALUE` is additive and deliberately **not** matched, and neither is `ALTER INDEX … RENAME TO` — no application code references an index by name, so matching it would generate false positives forever and train operators to reach for the override.
- An enum-value rename is treated as **breaking but not as a destructive removal**, so it needs `old_code_compatible=yes`/`windowed` plus the override, not `phase=contract` with a named `previous_expand_release`. That is a deliberate carve-out from the contract-release definition above, which lists enum values among the shapes a contract release removes: renaming a label is not the same act as dropping one, and in practice an enum rename that matters travels with the column renames or drops that already put the migration in the destructive-removal set (`20260525010000` is exactly that). Recorded here so the call is not re-litigated per pull request.
- operations touching hot tables: `Member`, `Booking`, `Payment`, membership tables, finance token tables, and auth/action-token tables — including index, constraint, and trigger creation/removal (`CREATE`/`DROP TRIGGER`, `CREATE CONSTRAINT TRIGGER`) against those tables
- matching entries in `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`

Hot-table migrations require a lock-impact plan in the ledger. Potentially breaking migrations also require `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1` and a non-empty `BLUE_GREEN_MIGRATION_OVERRIDE_REASON` at deploy time, after the ledger records either why the active old color remains compatible (`old_code_compatible=yes`) or what the maintenance window is (`old_code_compatible=windowed`). A pending `windowed` row additionally requires `BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED=1`; set it only after traffic is removed, the old web color plus every old worker/scheduler/queue consumer are stopped, and no old database connection remains. The override alone cannot satisfy that operational boundary.

The breaking/hot-table scan is line-oriented, not a SQL parser: it reads every non-comment line of the pending `migration.sql`, case-insensitively, including lines inside a `DO $$ … $$` block. No single pattern can see a keyword *phrase* split across lines — `RENAME` at the end of one line and `VALUE` at the start of the next reads as neither. The two rename constructs therefore carry a **partner pattern** that matches the first line on its own: `ALTER TABLE … RENAME` behind `RENAME COLUMN`, and `ALTER TYPE … RENAME` behind `RENAME VALUE`. Both wraps are caught. Splitting *between* clauses is fine and is caught on the second line — `ALTER TYPE "X"` on one line and `RENAME VALUE 'a' TO 'b';` on the next.

The patterns without a partner (`DROP COLUMN`, `DROP TABLE`, `ALTER COLUMN … TYPE` and the rest) do still lose a mid-phrase wrap. No migration in this repo is written that way; keep it so.

## Session-clock DML gate

The validator separately blocks `CURRENT_TIMESTAMP` / `now()` written into an `INSERT` or `UPDATE` payload (issues #1656 / #1627). Session (database-local) time landing in a naive timestamp column renders local wall-clock on a non-UTC database and skews `createdAt` ordering — the defect that once let a same-day app-created lodge silently become the club default. DML must write an explicit UTC value instead, e.g. `timezone('UTC', statement_timestamp())` or a literal `'2026-01-01T00:00:00Z'`. A column `DEFAULT CURRENT_TIMESTAMP` is DDL, not a payload, and is fine. Statements are reconstructed dollar-quote-aware (arbitrary `$tag$…$tag$` bodies, so semicolons inside a quoted HTML payload do not fragment the statement); an unterminated dollar-quote fails the gate rather than passing unchecked. This gate is a **hard, non-overridable block**: `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1` does not waive it, and it is enforced at both deploy time and PR time (the coverage gate runs the validator with the breaking override set, so the session-clock block still fires). Migrations whose timestamp prefix sorts before the gate's baseline predate it and are exempt so committed history never retro-fails.

The rare reviewed exception is a name-keyed allowlist, `SESSION_CLOCK_DML_ACKNOWLEDGED` in `scripts/validate-blue-green-migrations.sh`, documented in the same spirit as the grandfathered timestamp prefixes: each entry is an exact migration folder name with a comment justifying why the session clock is harmless there — only for a cosmetic write on a cold table with no `createdAt`-ordering invariant to skew (e.g. `20260717180000_genericise_starter_lodge_copy`, which refreshes `updatedAt` on the cold `PageContent` table). The waiver is scoped to the session-clock gate only, never the destructive/hot-table checks, and prefer fixing the migration SQL to write explicit UTC over adding an entry.

## PR-time coverage gate

The deploy gate only inspects migrations still pending against the target database, so a regex-matching migration committed without a ledger entry stays invisible until a deploy aborts before cutover (that is exactly how a fork upgrading from `v0.9.0` was hard-blocked — see issue #1359). CI's `migration-drift` job therefore runs `scripts/check-migration-safety-coverage.sh` on every pull request. It is read-only and needs no database, and it fails the build when:

- any row in `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` declares an `old_code_compatible` outside `yes`/`no`/`windowed`, names no migration, or repeats a migration already named on an earlier row. This runs over the whole ledger and does not depend on which migrations are in scope below, so a mistyped `windowed` fails the pull request rather than the deploy,
- a committed migration at or after the ledger baseline (the earliest migration named in the ledger) matches the hot-table/breaking regexes but has no well-formed `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` entry — or is declared `windowed` and ships no `rollback.sql` beside its `migration.sql`, or
- a migration the change ADDS is a `phase=contract` whose `previous_expand_release` names a migration the change also adds — an expand and its own contract in one deploy (#3002). It compares against `--base`, default `origin/main`, and fails closed rather than guessing when it cannot read that base. See "The expand/contract half is ENFORCED" above for the acknowledgement marker that covers a deliberate windowed drop,
- any ledger row's `previous_expand_release` names a migration that does not exist — a typo there silently disables the check above for that row, or
- a new migration reuses an existing timestamp prefix. Prisma orders migrations by folder name, so a duplicate prefix sorts ambiguously. The historical duplicate prefixes that predate this gate are grandfathered in the script; any new collision fails CI. Always stamp a new migration with a timestamp later than every committed migration.

Add the ledger row (and, for destructive changes, follow the expand/contract sequence above) in the same pull request that adds the migration.

## Data-migration verification

Some migrations do not only change the *shape* of the database — they rewrite data a club has typed in. `Migration drift check` applies every migration to a real PostgreSQL, but the tables are **empty**, so a backfill, repair, or value transform matches no rows: the statement is proven to parse and proven to do nothing. Tests that string-match the SQL, or re-run its patterns in JavaScript, prove the patterns are what the author intended; JavaScript and PostgreSQL regular expressions differ on greediness, on newlines inside character classes, and on backslashes inside brackets, so they cannot prove PostgreSQL executes them the same way. Every defect the three review rounds found in #2269's migration was semantic, and none was reachable from empty tables (issue #2418).

**The rule: a data-rewriting migration ships a verification fixture in the same pull request.** `scripts/check-data-migration-verification.sh` — the read-only coverage gate, no database needed — enforces that a fixture *exists and is registered*. It runs as a step in `migration-drift`, a **required** status check, so a migration that rewrites club data without a fixture cannot merge. It runs a second time inside the `Data migration verification` job (fail-fast before the database comes up).

The `Data migration verification` job is the half that *executes* the fixtures against a real PostgreSQL and runs the mutants. **It is a required PR status check** — the owner action this document used to ask for has been taken, and the check is live in branch protection on `main`. A failing fixture (a wrong post-state, an undetected mutant) therefore blocks the merge on its own, and it also blocks the release: `publish-ghcr-images`, which pushes the image an operator deploys, lists the job in `needs:`, so a red fixture stops the image (#2418).

A migration counts as **data-rewriting** when any top-level statement:

- begins with `UPDATE`, `DELETE`, `TRUNCATE` or `MERGE` — these can only reach rows that already exist;
- begins with `INSERT` and derives values from existing rows (a `SELECT` anywhere in the statement) or resolves a conflict with `DO UPDATE`;
- begins with `WITH` and contains an `UPDATE`/`DELETE`/`INSERT`/`MERGE` (a data-modifying CTE);
- is an `ALTER TABLE ... ALTER COLUMN ... TYPE ...`, with or without a `USING` clause — the cast recasts every stored value in place, and an implicit assignment cast still rounds a numeric or truncates a timestamp (#2418);
- is a `DO` block containing any of the above (a PL/pgSQL body is opaque to a line-oriented gate, so it is classified conservatively); or
- is a bare `CALL`, or a top-level `SELECT`/`PERFORM` that invokes a routine the same migration **defines with a write in its body** — the "helper function plus one invocation" backfill runs its write at migration time (#2418).

A plain `INSERT ... VALUES` is deliberately **not** data-rewriting: it adds rows and cannot alter anything a club has typed. Neither is a `CREATE FUNCTION` body containing an `UPDATE` that is only **attached** with `CREATE TRIGGER` and never invoked in the migration — that defines future runtime behaviour, which the trigger suites cover instead. A comment cannot hide a statement either: the splitter skips `--` line comments and `/* */` block comments (nested), so `/* repair */ UPDATE ...` still classifies. Statements are reconstructed with the same dollar-quote-aware splitter the deploy gate uses (`scripts/lib/split-sql-statements.awk`), so both gates grade the same program.

### Writing a fixture

Add `prisma/migration-verification/<migration_name>.ts`, named exactly after the migration directory, and register it in that directory's `index.ts` (an unregistered fixture never runs, so the gate fails on one). A fixture declares, in data:

- `intent` — plain English: what the migration must do, and to whom.
- `cases` — each a pre-state (`seed` SQL) and the `expectations` that must hold afterwards, as named queries and the exact rows they must return. **The runner replays every earlier migration first**, so a case seeds rows on the real schema rather than inventing tables — and the strongest case seeds nothing at all, because the pre-state is then literally what a real install holds. Select timestamps through `to_char(...)`: a raw naive timestamp is resolved against the *client's* zone and would pass in UTC CI while failing on a Pacific/Auckland machine.
- `mutants` — deliberate breakages of the migration (an inverted `WHERE`, a dropped predicate, a row-scoped rewrite where the real one is value-scoped), each with the real-world harm it would cause. The runner applies each mutant and **requires at least one case to fail**; a mutant that goes undetected fails the build. It also runs one mutant nobody declares: not applying the migration at all. Without this, a post-state assertion that would pass either way — coverage that does not exist — sits green forever.
- `idempotentReRun` — true when running the whole migration twice must change nothing (a pure value-scoped repair). The runner then proves it.

`prisma/migration-verification/20260802110000_clear_waldvogel_lodge_address.ts` and `20260802140000_clear_starter_footer_affiliations.ts` are the reference implementations.

Run it locally against any throwaway database (the suite creates and drops its own, so the user needs `CREATEDB`):

```bash
DATA_MIGRATION_VERIFICATION_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
  npx vitest run src/lib/__tests__/data-migration-verification.realdb.test.ts
```

Without that variable the real-database checks do not run, but the suite still fails if CI stops running them — and it fails outright inside its own CI job when the variable is missing, so the arrangement that runs the fixtures cannot quietly come undone.

### Enforcement

Three things are enforced today, and there is no longer a pending owner action here:

- **Coverage** (a fixture exists and is registered) rides on the **required** `Migration drift check`, so no-fixture-no-merge bites immediately.
- **A failing fixture blocks the merge**: `Data migration verification` is itself a required status check on `main` — verified against the applied branch-protection configuration, not merely intended. `AGENTS.md` → "Completion and Merge" carries the authoritative table of what is required today, what is pending an owner action, and the `gh api` call that reads the live list.
- **A failing fixture blocks the release**: `publish-ghcr-images` depends on the `Data migration verification` job, so a red fixture also stops the image an operator would deploy.

Note that branch protection still has `enforce_admins` off, so an admin merge can bypass every check above.

**Limitation.** The migration under test is applied inside a transaction so each case can be rolled back, which means a migration that adds an enum value *and uses it* cannot be verified this way (PostgreSQL refuses `ALTER TYPE ... ADD VALUE` followed by use in one transaction block). Split such a change into two migrations, which the expand/contract sequence above wants anyway.

### The grandfather list

`scripts/data-migration-verification-grandfathered.txt` names the 87 data-rewriting migrations that shipped before this gate existed (recorded 2 August 2026; the list was 85 until the classifier was tightened to catch two historical `ALTER COLUMN ... SET DATA TYPE` migrations). The count is pinned in the script, so the list cannot grow unnoticed. Removing a name is how a historical migration gets retro-fitted: write the fixture, delete the line, drop the pinned count. A **new** migration can never be grandfathered: the gate refuses any entry whose timestamp prefix is at or after the day it was introduced, so a fresh data-rewriting migration must ship a fixture rather than buy its way out (#2418). A migration cannot be both grandfathered and verified — the gate fails on that, so the list can never decay into decoration.

## Historical Migrations

The April 2026 migration history contains single-step destructive changes that predate this policy. Those files are not edited retroactively because Prisma records migration checksums after deployment. If any environment still has one of those migrations pending, do not run it through the normal blue/green path; treat it as a bootstrap or maintenance migration with an explicit operator plan.
