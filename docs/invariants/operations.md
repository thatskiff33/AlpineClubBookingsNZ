# Operations

Audience: Developer, Agent.

Prefixes defined in this file: **`INV-OPS`** — raw SQL result shapes, raw SQL
construction and row locking, the client/server bundle boundary, production
deployment including the worked windowed column drop, changing what values
already stored in a column mean, and what may be used as test input — and
**`INV-LOCK`** (#2722), the two-tier advisory-lock protocol: which tier a writer
takes, the order it takes them in, and the registration every global site
carries. `INV-LOCK` sits here because advisory locking is the sibling of the row
locking `INV-OPS-001` already governs, and both are read by the same person on
the same day; [`SCHEME.md`](SCHEME.md) §1.2 already reserved the prefix for
exactly this — "this codebase's 'lock' means an advisory row lock", which is why
subscription lockout takes `INV-LOCKOUT` instead. The concrete lock families,
their keys and their composed orders stay in
[`docs/CONCURRENCY_AND_LOCKING.md`](../CONCURRENCY_AND_LOCKING.md), which expands
these rules against real writers rather than restating them.

Read this file when you are writing raw SQL, taking a row lock or an advisory
lock, adding an import to a `"use client"` module, dropping a column, changing
the meaning of a stored value (an audit `category`, a status string) so that the
rows already written no longer match the code, deploying to production, or
choosing credentials or data for CI and local validation.

`INV-OPS-005` to `INV-OPS-011` are the `FamilyGroupMember.role` column drop,
re-homed here from `membership-lifecycle.md` by #2706: they are migration
policy — Prisma `@ignore` behaviour, what a generated client can emit, the
`old_code_compatible=windowed` ledger row, the `rollback.sql` and the operator
sequence — rather than membership lifecycle. The membership-lifecycle rules they
sat beneath stay where they were.

Index: [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) — every `INV-*` ID
with a one-line description of what it covers. ID scheme and allocation rules:
[`SCHEME.md`](SCHEME.md).

Every heading below whose whole text is an `INV-*` ID defines that invariant. IDs
are permanent: never renumbered, never reused. **The text under each ID is a
verbatim move from the source document and must not be reworded in place** —
only the ID heading lines were added.

`INV-OPS-012` (#2751) is the exception, because it was written here rather than
moved into the restructure: there is no source text to preserve it against, so it
is corrected and extended like any other prose, in its own reviewable change. See
[`SCHEME.md`](SCHEME.md) §3 — the no-rewording rule governs transcriptions, not
rules first written here. #2765 extended it with the measured-audience half.

## INV-OPS-001

- **Raw SQL never declares its own result shape (#2289).** `$queryRaw<SomeRow[]>`
  is an unchecked CAST: raw SQL returns the *physical* column names while the
  type argument declares whatever the author believed, and nothing verifies the
  two agree — not the compiler (the cast silences it) and not the tests (a mocked
  Prisma returns the author's own wrong belief). Where they disagreed in a live
  deployment every property arrived `undefined`, which is quietly falsy in
  exactly the comparisons that guard money: a promo's total-redemption cap never
  fired (`undefined !== null` true, `n > undefined` false) and FREE_NIGHTS promos
  applied no discount at booking creation (`?? 0`), while the quote path — an
  ordinary mapped Prisma read — showed the member one.

  Two disciplines close it, and both are enforced. **Lock raw, read typed:** a
  raw statement taken for a row lock selects a CONSTANT through `$executeRaw`
  (`SELECT 1 … FOR UPDATE`) and the data is read back through the Prisma model
  under that same lock — one extra round trip, and Prisma owns the mapping so the
  names cannot drift. The two statements are behaviour-identical to one
  `SELECT the-columns … FOR UPDATE` *while the lock matches a row*; where the
  lock key is MUTABLE, the affected-row count `$executeRaw` returns must also be
  checked, because `FOR UPDATE` locks nothing when it matches nothing and the
  follow-up read (READ COMMITTED, fresh snapshot) could otherwise return a row
  nothing holds a lock on. Only `booking-create-promo.ts` locks on a mutable key
  (`PromoCode.code`); every other site keys on an immutable cuid.
  **Validate what you cannot model:** a statement Prisma genuinely cannot express
  (only the rate limiter's atomic `CASE … RETURNING` upsert) passes its rows
  through `decodeRawRows` (`src/lib/raw-sql-rows.ts`), which throws naming the
  offending column — and which also records what Postgres really sends on this
  stack, since `COUNT(*)`/`int8` arrive as a **BigInt** (arithmetic on which
  throws) and `numeric`/`decimal` as a **`Prisma.Decimal`**.

  `eslint` `no-restricted-syntax` rules refuse the type argument and a
  `SELECT *` in a raw statement — in either call form, tagged template or
  `Prisma.sql` composition — across non-test code in `src/`, `scripts/` and
  `prisma/`; `src/lib/__tests__/raw-sql-shape-guard.test.ts` scans the same three
  directories, pins the per-file inventory of raw READS, requires at least one
  `decodeRawRows()` call per raw read or a documented opt-out (only the two
  `SELECT 1` connectivity probes), and holds every `FOR UPDATE` to `$executeRaw`
  over a constant. Tests are exempt from both by design. Full protocol in
  `docs/CONCURRENCY_AND_LOCKING.md` -> "Lock raw, read typed".

## INV-LOCK-001

- **The narrow tier is the default; the global key is deliberate (#1881, #2722).**
  Two transaction-scoped advisory tiers serialise booking work. **Tier 1** is a
  scoped key — the per-lodge capacity key, or a per-member, per-date or
  per-subject key — and is what a writer takes whenever its contention domain can
  be named. **Tier 2** is the single global key `pg_advisory_xact_lock(1)`, and a
  writer takes it when it must exclude a counterpart in another scope that no
  narrow key covers. That is booking-status and settlement-money transitions
  (cancel, capture/settle, hold-release, refunds, credit restore, group
  settlement and its reaper); the bed-allocation writers — inventory, placement,
  move, range, explicit auto-allocation, approval and reviewed removal — whose
  rows a lifecycle prune can remove, even though they move no money themselves;
  and the capacity-adjacent writers whose counterpart is one of those, such as
  roster eligibility and requested-room editing. The list is the current
  population, not a closed vocabulary: what makes a site legitimate is naming the
  cross-scope counterpart, which is why every one of them is registered
  (`INV-LOCK-003`) rather than matched against a list. The key is not legacy and
  reaching for it is not itself a defect — reaching for it with no such
  counterpart is, and so is taking a narrow key where one exists.

## INV-LOCK-002

- **A writer that needs both takes Tier 2 first, then Tier 1, and never
  reconstructs the per-lodge key by hand.** Global before per-lodge, everywhere,
  so composing the two can never deadlock; several keys of one family are taken
  in sorted key order for the same reason. The global key needs no helper and has
  none — it is the literal `1`, written inline as `` tx.$executeRaw`SELECT
  pg_advisory_xact_lock(1)` ``, and there is nothing about it to get wrong. The
  per-lodge key is the opposite: it is minted only by `acquireLodgeCapacityLock`
  (`src/lib/lodge-capacity-lock.ts`, re-exported by `capacity.ts`), and
  `hashtextextended` is *called* in no other non-test file under `src/`, so every
  participant provably shares one key instead of an ad-hoc reconstruction that
  could drift from it. Among the bed-allocation writers, member merge is the one
  documented writer that takes the lodge tier and deliberately not the global key
  (#2595) — it runs on a 120s budget. That is an exception to the bed-allocation
  cohort, not a general licence: a writer whose contention domain is genuinely
  scoped takes the narrow tier alone by default (`INV-LOCK-001`) and needs no
  decision at all.

## INV-LOCK-003

- **Every Tier-2 call site in non-test `src/` is registered, individually, with
  its own reason (#2722).** `GLOBAL_LOCK_SITE_REGISTRY` in
  `src/lib/__tests__/advisory-lock-guard.test.ts` is where that reason is
  registered and enforced; where a narrative page discusses one of these sites at
  length it must agree with the entry, never contradict it. A site is identified
  by the symbol containing it rather than by its line, so a refactor that moves a
  function carries its reason with it untouched. Two shapes are identified
  differently and deliberately: an App Router handler keys on its method and route
  path, because `POST` is a framework name and the URL is the real identity, and
  where two modules use one private helper name the entry is file-qualified —
  those entries are the ones a file split has to update, and the guard refuses an
  ambiguous entry rather than binding a reason to whichever site it found first.
  The census is closed-world in five directions and each is a CI failure: an
  unregistered Tier-2 site, a registration matching no live site, a registered
  site whose call changed tier, a duplicate or ambiguous entry, and an advisory
  key the scan cannot classify — which fails as Tier 2 rather than being counted
  as scoped. Adding a site
  means classifying the writer and naming the counterpart it excludes — never
  editing a count, which is what coupled approval to file layout before #2722.

## INV-LOCK-004

- **A read taken while a lock is held goes through the caller's transaction
  client, never the module-level one (#3110).** The policy readers are shaped for
  this in two ways. Three families take a trailing `db` that an in-transaction
  caller MUST supply: `validateMinimumStay` (`booking-policies.ts`),
  `loadAdultMemberHostingPolicy` (`adult-member-hosting-review.ts`), and the
  three cancellation and non-member-hold readers in `cancellation.ts`. Two more
  cannot take one - the subscription-lockout mode and the club timezone - and are
  resolved before the transaction opens and passed in as a value instead. Which shape a
  reader gets is decided by whether it is keyed by state the transaction re-reads
  under the lock: if it is, the read must move with that state and the client is
  threaded; if it is not, hoisting it out is both cheaper and safe. The reasoning,
  the writer inventory and the pool-starvation argument live in
  `docs/CONCURRENCY_AND_LOCKING.md` -> the five "Which client reads ..." sections
  and are deliberately not restated here. Pinned by
  `cancellation-policy-client-contract.test.ts`,
  `adult-member-hosting-call-sites.test.ts`,
  `payment-link-expiry-club-zone.test.ts`, and the two minimum-stay call-site
  tests. The first of those is allowlist-free in both directions - it reads the
  transaction spans off the source and separately requires any reader called
  inside a client-taking helper to pass that client on - so a new
  in-transaction call site is a CI failure rather than the next audit's finding.

## INV-OPS-014

- **The statement handed to a raw `Unsafe` call is visibly static at the call
  site (#2686).** `$queryRawUnsafe` and `$executeRawUnsafe` take a plain
  `string`, so Prisma sends exactly what that string says and there is no
  parameter binding left between the value and the database.

  The invariant is stated as a property of the CALL SITE rather than as a list
  of forbidden constructions, and that is deliberate. An enumeration of ways to
  build a string — interpolation, `+`, `.concat()` — is open-ended, and whatever
  is not enumerated passes: measured against the ways this codebase writes the
  same defect, the first version of the guard caught 3 of 13, missing the most
  natural one of all, which is to build the string one statement earlier and
  pass it by name. So: a literal passes, a constant holding a literal passes
  (constant propagation folds it), and anything a reader cannot see the value of
  at the call site is reported, whether or not anyone thought of it.

  Three safe forms remain, and the guard's message names all of them: the tagged
  templates `` $queryRaw`… ${value} …` `` and `` $executeRaw`…` ``, where every
  `${}` becomes a bound parameter; `Prisma.sql` composition; and `Prisma.raw()`
  for an identifier already validated against a fixed allowlist. All three are
  in the must-pass fixtures.

  **Aliasing the method is itself the violation.** `const run =
  prisma.$executeRawUnsafe.bind(prisma)` puts the statement and the call that
  sends it in two different places, and by the time the call reads `run(sql)`
  there is nothing at the call site to review. `acb-unsafe-raw-sql-alias` reports
  the line that creates the alias.

  Enforced by `.semgrep/rules/acb-unsafe-raw-sql.yml` in the
  `Static analysis gate`, with must-fail and must-pass fixtures in
  `.semgrep/tests/` — and `src/lib/__tests__/semgrep-rule-fixtures.test.ts`
  asserts those fixtures exist and cover each rule id both ways, because
  `semgrep --test` exits 0 when a fixture is simply missing. Tests and `e2e/` are
  exempt, for the reason `eslint.config.mjs` gives for exempting them from
  `RAW_SQL_RESTRICTIONS`: a test's raw statement runs against a throwaway
  database the test created. **Two** genuinely static interpolations exist in
  production code — `audit-retention.ts`'s archive DDL, built from the committed
  column manifest, and `booking-envelope-invariants.ts`'s SET CONSTRAINTS, built
  from a committed two-element const array — and each keeps a
  `// nosemgrep: acb-unsafe-raw-sql — <reason>` line, so the exemption is
  reviewed in the diff that adds it rather than configured away in bulk. The
  second of those was invisible to the first version of the guard, which is what
  the widened form found. This rule is about how the string is BUILT;
  `INV-OPS-001` is about what the result is declared to be, and both apply to
  the same call.

  **What adding that `nosemgrep` line does, since this is the rule that tells
  you to add one.** Semgrep marks the result suppressed rather than dropping it,
  and GitHub's SARIF ingest used to file every such result as a code-scanning
  alert no source change could close — so each justified exemption minted
  permanent noise in the Security tab, which is where a real new raw-SQL call
  would then have looked identical to the known-safe ones. Since #2841 the
  `static-analysis` job filters in-source-suppressed results out of what it
  publishes (`scripts/ci/filter-suppressed-sarif.mjs`), so a new justified
  exemption no longer leaves an alert behind. The two that predate that filter
  still need a one-time manual dismissal. Full reasoning:
  [`SECURITY-ATTACK-SURFACE.md`](../SECURITY-ATTACK-SURFACE.md#the-semgrep-pair-which-outranks-the-critical).

## INV-OPS-013

- **A `"use client"` module never reaches server-only code (#2686).**
  Everything a client module pulls in at runtime is compiled into the browser
  bundle, so reaching `@/lib/prisma`, `@/lib/auth`, `@/lib/audit`,
  `@/lib/session`, `@/lib/email`, `@/lib/xero`, `@/lib/stripe`, `@/lib/env`,
  `next/headers`, `server-only` or a Node built-in from a `"use client"` file
  ships database access, credential handling or filesystem code to every
  visitor. Two of those fail the Next build already; `@/lib/prisma` and
  `@/lib/auth` do NOT, because neither imports `server-only` — those are the ones
  that would ship silently.

  **"Reaches", not "imports", and the two words are enforced by two different
  mechanisms.** A re-export (`export { prisma } from …`, `export * from …`) and a
  dynamic `await import()` / `require()` have exactly the same bundle effect as a
  plain import, and all of them are direct edges. A hop through an intermediate
  module — a client component importing `@/lib/audit`, which imports
  `@/lib/prisma` — has the same effect again and is not visible in any single
  file.

  The fix is to do the work in an API route or a server component and pass the
  RESULT to the client component. A type-only `import type` / `export type` is
  exempt and stays exempt: it is erased before a bundle exists and cannot carry
  anything into it.

  Enforced twice:

  - **direct edges** by `.semgrep/rules/acb-client-server-boundary.yml` in the
    `Static analysis gate`, with must-fail and must-pass fixtures in
    `.semgrep/tests/`;
  - **transitive reach** by
    `src/lib/__tests__/client-server-boundary-census.test.ts`, which walks the
    real import graph from every `"use client"` module and reports the shortest
    path it found. It runs in the required `verify` check.

  What is **not** enforced, so that the wording here matches the mechanism:
  neither guard is the bundler. The build-time answer Next.js provides —
  `import "server-only"` in the leaf module, which makes the compiler refuse the
  whole chain — is not applied to `@/lib/prisma` or `@/lib/auth`, because
  `server-only` throws when evaluated outside a React Server Component and 122
  test files already carry `vi.mock("server-only", …)` for the modules that have
  it today. Adding it would put that requirement on essentially every test in the
  repository.

  Measured at 527eb74fc: 432 `"use client"` modules in `src/`, **zero** direct
  imports of any listed module or Node built-in, and **one** transitive edge —
  `src/lib/booking-exception-requests.ts` imports `node:crypto` for
  `computeProposalHash` and four client components import values from it. That
  edge is named in the census's `KNOWN_EDGES` with its reason; nothing new joins
  that list without the same explanation, and `@/lib/prisma` and `@/lib/auth` are
  never exemptable at all.

## INV-OPS-002

- Production deployment must respect `docs/BLUE_GREEN_MIGRATION_POLICY.md`.

## INV-OPS-012

- **Reclassifying an audit row's `category` in code changes only the rows written
  afterwards, so the pull request that reclassifies either ships the backfill for
  the rows already written or files it as an issue — never neither, and never as
  prose. A backfill that would cross the member-visible boundary in either
  direction needs its own owner decision rather than following this rule
  automatically.** Owner decision of 10 August 2026 on #2751, decision C, in the
  variant #2763 informed; a follow-up that exists only as a sentence in a pull
  request is not a follow-up.

  **Why the code change is never the whole change.** `AuditLog.category` is
  stored on the row at write time and never re-derived at read time, and
  `buildAuditCategoryWhere`'s legacy action-name fallback fires only for rows
  whose category IS NULL — so a row that already carries a category keeps the
  superseded one for as long as it is retained. Moving a writer therefore splits
  that event's history at the release boundary: Admin > Audit Log's Category
  filter answers "show me what happened that weekend" for one side of the date
  only, and of the two AI Diagnostics correlation entries involved, the one that
  gained the writer returns the newer half while the one that lost it returns the
  older half. Neither is wrong about what it holds and neither can answer the
  question. #2730 moved 22 bed-allocation writers and produced exactly that;
  #2751's backfill closed it. The population most likely to move next is the
  lodge-gated group left at `admin`, which is why this is a rule rather than a
  note on one issue.

  **What a backfill has to be.** An EXACT literal list of the action names the
  moved sites write, never a prefix or pattern match: a pattern cannot be
  reviewed against the audit-writer census and it sweeps up any action added
  after the migration was written, including one deliberately classified
  somewhere else. `category` is the only column in the `SET` clause —
  `retentionClass` and `expiresAt` are stored columns that were derived from the
  category at write time, and recomputing them from the new value is how a
  rewrite silently re-dates when a row is purged, with no undo on an append-only
  table. Idempotent, because `prisma migrate deploy` runs before cutover and the
  old colour keeps writing the old category until it drains, so the operator has
  to be able to run the statement again. And it records what it moved, with the
  row counts before and after, because a rewrite of an append-only table is
  otherwise invisible to the club whose history it changed.

  **The member-visibility carve-out, which is the half of this rule that is NOT
  automatic.** A backfill crossing the member-visible boundary is a visibility
  decision rather than a tidy-up: rewriting a stored row OUT of a member-visible
  category (`account`, `security`, `booking`, `payment`, `family`,
  `communication`, `privacy` — the reviewed list in
  `MEMBER_VISIBLE_AUDIT_CATEGORIES`) withdraws an entry a member can see about
  their own account today, and rewriting one INTO a member-visible category
  publishes an administrator's action to the member it was about. Neither follows
  from the writer decision, so neither may ride along with it, and neither may be
  taken by a lane: **it is the owner's decision.** #2763 is the worked example —
  the same mechanism as #2751 with the opposite answer, because those rows are
  member-visible and stay untouched. #2751's own rows cleared this because neither
  `admin` nor `lodge` is member-visible, so nothing crossed in either direction.

  **Enforcement is partial, and the boundary is stated rather than implied.** The
  mechanical half exists and is real:
  `src/lib/__tests__/bed-allocation-audit-category-backfill.test.ts` fails when
  the #2751 backfill's literal action list and the writers pinned in
  `REVIEWED_ADMIN_CATEGORIES_2730` stop naming the same events in either
  direction, so adding a 23rd bed-allocation writer without covering its rows
  fails CI by name. **The remedy for that failure is a NEW backfill migration, or
  a filed issue — not an edit to the #2751 one**, because
  `docs/BLUE_GREEN_MIGRATION_POLICY.md` binds committed migrations never to be
  edited retroactively: Prisma records a checksum per applied migration, so
  editing one breaks `prisma migrate deploy` on every fork that already ran it.
  Extending the existing literal list is correct only while that migration is
  still unreleased and unapplied anywhere. A GENERAL "did a reclassification ship
  without a
  backfill" check is **not available**, and pretending otherwise would be worse
  than having none: the audit-writer census pins only 127 of its 462 write sites
  per-site — the union of `APPLIED_AUDIT_CATEGORIES`,
  `REVIEWED_ADMIN_CATEGORIES_2730`, `MEMBER_RECORD_ADMIN_CATEGORIES_2755` and
  `LODGE_GATED_ADMIN_CATEGORIES_2765`, counted rather than added up, and asserted
  by `audit-writer-census.test.ts` so this figure and the copy of it in
  `bed-allocation-audit-category-backfill.test.ts` cannot go stale again —
  deliberately, because pinning all of them would make every feature that records
  something edit a 400-line literal — so for the other 335 there is no baseline
  a check could compare against, and the category distribution alone cannot see a
  reclassification that another one compensates for. The two `verify` gates that
  can read a pull request parse its BODY, not its diff. So outside the pinned
  population this is a rule a reviewer applies, and the reviewer is the
  enforcement.

  **The same pull request also states the MEASURED before/after audience, per
  site.** Owner decision of 11 August 2026 on #2765, D3, extending this rule
  rather than adding a second one: recategorisation work carries both halves — the
  backfill answer for the rows already written, and the audience answer for the
  rows written next. Measured means run against every reader that keys on
  `category`, and stated per site rather than per group:
  `MEMBER_VISIBLE_AUDIT_CATEGORIES` and `buildMemberVisibleAuditLogWhere` for the
  member self-timeline; `AUDIT_CATEGORY_CORRELATION_DOMAIN` with
  `AUDIT_CORRELATION_DOMAIN_AREAS` for which AI Diagnostics
  correlation entries can return the row and which admin areas that needs;
  `AUDIT_TIMELINE_CATEGORY_OPTIONS` for which tab of Admin > Audit Log surfaces
  it; `FINANCE_AUDIT_CATEGORIES` in
  `src/lib/diagnostics/tools/packs/finance-records.ts` for any move into `payment`
  or `xero` on a `Payment`, `Booking`, `ManualRefundTask` or `MemberSubscription`
  entity, because that is a SIXTH audit-category reader outside the correlation
  pack and its gate is `finance` **alone** — deliberately weaker than the
  correlation entries' `support` + `finance`, per #2377's owner decision that a
  Finance Officer must not need Support & System permission, and pinned in
  `finance-pack.test.ts`; and `classifyAuditRetention` on the site's OWN action,
  since that function
  reads action as well as category and an access-shaped action expires at 24
  months instead of seven years. **The reason this is a rule is that reasoning
  about it has already failed.** #2755's issue text and the brief for its build
  lane both stated that the change moved nobody's readership; measurement on
  #2764 found three deltas, including a widening that appeared in neither. A
  sentence asserting "this changes nobody's readership" is not evidence, and on
  this surface the cost of being wrong is a row published to a member on an
  append-only table. The same measurement is what refused a move on #2765: the
  category the decision named turned out not to exist, and every category that
  reached the intended reader was member-visible (`INV-PRIV-013`). A refusal is
  not the end of the obligation — the question went back to the owner as **#2777**,
  a filed issue with the measurement and the costed alternatives, because a
  carry-forward named in a pull request and nowhere else is the defect #2765 was
  itself opened to fix. #2777 was decided on 11 August 2026; `INV-PRIV-013`
  records the settlement.

## INV-OPS-005

Why the runtime half needed the `@ignore` rather than just deleting the call
sites, recorded because the same trap applies to the next doomed column.
Measured against Prisma 7.9.0 by recording the SQL through a driver adapter:

- A static `@default("MEMBER")` is materialised **client-side** as a bind
  parameter, so the column appeared in the column list of every `INSERT` the
  client emitted — `create`, `upsert`'s insert branch and `createMany` alike —
  **even for a call that set no role and narrowed itself with
  `select: { id: true }`**. Narrowing cannot reach that: it is the write's
  column list, not its projection.
- An unnarrowed `create`/`update`/`upsert`/`delete` names every scalar in its
  implicit `RETURNING`, and an `include:` (or a bare `: true`) on the join table
  names every scalar in its `SELECT`.

`@ignore` closed all of those at once, which is what let the drop be reasoned
about at all. Removing the field outright now does the same thing permanently:
**no call shape on this delegate can emit SQL naming the column**, because the
generated client has no such field to put in a `SELECT`, an `INSERT` column
list, a `RETURNING` or a `WHERE`.

## INV-OPS-006

How that is enforced, measured in the rehearsal rather than asserted, because
the convenient shorthand ("it is a compile error now") is not quite true and the
difference decides how much guard coverage is still owed:

- `where: { role: ... }` **is** a compile error —
  `'role' does not exist in type 'FamilyGroupMemberWhereInput'`;
- `select: { role: true }` and `create({ data: { role } })` **compile cleanly**,
  and are rejected at runtime by the client with `PrismaClientValidationError`
  **before any SQL is emitted**.

So the residual hazard is a 500 on one route, not a Postgres 42703, and it is
unconditional rather than data-dependent — the first invocation of that code
path fails, in any test or dev run. What is gone completely is the *implicit*
hazard the old guard existed for: an `include:` or a bare `: true` naming the
column with no author intent at all. The client cannot name a field the schema
does not declare.

## INV-OPS-007

`src/lib/__tests__/family-group-role-retirement.test.ts` survives the drop in
reduced form. Its delegate, nested-relation and write/read scans were deleted on
the reasoning just above — the implicit hazard is structurally impossible and the
explicit one is loud and unconditional — and `familyGroupMember` came out of
`src/lib/__tests__/doomed-column-select-guard.test.ts`'s
`NARROW_SELECT_MODELS` at the same time. What it still pins is the part the
compiler cannot reach: the **generated client's shape** (the owner-required proof
that the replacement runtime cannot name the dropped column) and **raw SQL**,
where a `$queryRaw` or a psql heredoc naming the column is invisible to
TypeScript. It also ties the schema's field-absence to the committed migration
and to the migration's `windowed` ledger row with its `rollback.sql`.

## INV-OPS-008

Worth recording precisely, because the #2284 close-out is easy to misread: what
#2284 removed was the last **authorisation** reader. **Payload** readers
outlived it and were found by #2520 — every admin family-group response
(`GET`/`POST /api/admin/family-groups` and `GET`/`PUT
/api/admin/family-groups/[id]`) returned a per-member `role`, and
`GET /api/member/onboarding` selected the column explicitly and returned it to
the member-facing onboarding wizard as `groupRole`. None was rendered (the
wizard declared `groupRole` in its type and never used it; the admin pages never
referenced it), so removing them changes no screen — but "the column has no
reader" was not true of the deployed release until PR #2565, and the drop's
safety depends on it being true. A retired audit script
(`scripts/audit-access-role-membership-cleanup.ts`) also still named the column
in raw fixture SQL and a snapshot query; #2520 removed those the same way #2130
removed that script's `AgeTierSetting.xeroContactGroupId` references.

## INV-OPS-009

**How the drop actually shipped, and why the plan changed.** An earlier version
of this text described a deliberately two-step retirement: deploy the runtime
half, wait for it to become the draining colour, then drop the column in a later
release declaring `old_code_compatible=yes`. **The owner superseded that on
3 Aug 2026** (#2520): the physical drop ships now, as part of the Tokoroa
cutover, behind an accepted maintenance window, rather than carrying an obsolete
column through another release. This paragraph replaces the old plan rather than
sitting beside it, because no release ever shipped under it — the "leave it as
declared" convention in `docs/BLUE_GREEN_MIGRATION_POLICY.md` protects the record
of what operators actually deployed under, which this was not.

## INV-OPS-010

What that means concretely, and it is the honest version of the constraint the
old plan was designed to avoid:

- The runtime half was **never deployed on its own**, so the release in
  production when the drop lands is the last tagged one, whose Prisma client
  names the column in ordinary projections, in every insert's column list, **and
  in a `WHERE` clause** — `role: "ADMIN"`, the one-step partner declaration read
  that the member profile page renders. The moment the DROP commits, that release
  fails across the whole family surface.
- So the ledger row is `old_code_compatible=**windowed**`, not `yes`: it says in
  writing that the previous release *will* break, and it carries the full ordered
  maintenance-window plan. `previous_expand_release` names an adjacent migration
  in the same release, because **no truthful value exists**: the runtime half
  shipped no migration of its own, so there is no folder from it to name, and the
  field is single-valued and checked only for non-emptiness. The real precondition
  is written out in the row's `lock_impact_plan` instead. That last part is the
  practice the #2130 contract row (`20260721130000`) established — its own single
  field could not express two expand releases either, so it named one and
  explained both in the plan column — but #2130's field names a *real, already
  deployed* expand release, which this one's cannot.
- The rollback boundary moves back to the **migrate step**, so
  `rollback.sql` ships beside the migration and was rehearsed both ways. It
  restores the column's exact shape (`TEXT NOT NULL DEFAULT 'MEMBER'`) but not
  the per-row labels, which no script can recover; `'MEMBER'` is the documented
  safe compatibility value. The operator sequence, the four pre-migration checks
  and the rollback-boundary rules are in
  `docs/PRODUCTION_UPGRADE_RUNBOOK.md` → "Windowed migration deploy sequence"
  → §2.4.1.

## INV-OPS-011

The stored values were **meaningless rather than frozen** for the whole interval
between #2284 and the drop: nothing read them, and every row inserted after the
runtime half took `'MEMBER'` from the database default because the client had
stopped naming the column. That is why destroying them costs nothing
behaviourally.

## INV-OPS-003

- Public CI and local validation must use test/demo credentials or placeholders.

## INV-OPS-004

- Production data, production backups, live provider accounts, and live webhooks
  are not valid exploratory test inputs.
