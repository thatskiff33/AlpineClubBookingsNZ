# Xero member grouping — Tokoroa migration & bulk re-sync runbook

This runbook covers the one-time, owner-coordinated cutover for a club that was
already using age-tier Xero contact groups (Tokoroa's live production tenant)
onto the E8 (#1934) member-grouping model, and the general procedure for the
admin-triggered bulk re-sync.

**Nothing here writes to live Xero automatically.** The bulk re-sync is
admin-triggered and dry-run-first. In the E8 wave the live re-sync is **not**
executed — this document is the procedure the owner follows in a later,
scheduled maintenance window.

## Background

- One club-level mode setting — `None`, `Membership Type`, or
  `Membership Type + Age` — controls whether members are auto-grouped in Xero.
- One rule table (`XeroContactGroupRule`): `MANAGED` rules are the group the
  sync adds; `ACCEPTED` rules are tolerated and never removed.
- Each rule targets a **set of age tiers** (`ageTiers`, #2093). Ticking **no
  tiers** means the rule applies to **every** age tier and displays as
  **"All age tiers"** — this is the old null "Any age" wildcard, so existing
  rules migrate with zero behaviour change (`ageTier = X` → `[X]`, `null` → `[]`).
  A rule can now target any subset, e.g. Youth + Child in one rule. Tier sets are
  stored canonical-sorted, and ticking every tier collapses to the "all tiers"
  empty set so there is exactly one canonical shape.
- **Overlap resolution — most specific wins (D-B4).** The ladder is
  `type + tiers` > `type-only` > `tiers-only` > `neither`. Among tier-bearing
  rules on the same rung, **fewer tiers is more specific** (a rule naming just
  `ADULT` beats one naming `ADULT, YOUTH`). An **"all age tiers" (`[]`) rule is
  the LEAST specific** in the tier dimension — a rule naming any specific tier
  always beats it. Exact ties break deterministically by `sortOrder` then group id.
- The E8 migration backfills existing age-tier group config into **tier-only
  rules** and sets the mode to `Membership Type + Age` when any age-tier group
  config existed, else `None`. Tier-only rules resolve identically to the
  retired age-only sync, so a correctly-grouped member produces **zero diff**.
- The system **never deletes a Xero contact group** and never removes a member
  from a group that no active rule references.

## Pre-checks (do these first, read-only)

1. **Refresh the Xero group cache.** On the **Xero member grouping** surface,
   click **"Refresh from Xero"** (top-right) — the lightweight action that
   re-pulls the contact-group cache (the same full refresh as the members-list
   "Refresh Xero Groups" button). The **"Last synced"** header shows when the
   cache was last refreshed; confirm it now reads a recent time. The dry-run
   recomputes from this cache, so a stale cache gives a misleading diff. **This
   refresh is mandatory:** until a `CONTACT_GROUP_FULL_REFRESH` has run at least
   once there is no cursor to anchor dry-run freshness to, so the dry-run returns
   **no `dryRunId`** and a bulk re-sync is impossible — the pre-check refresh is
   what first unlocks the re-sync. (Because "Refresh from Xero" moves the
   `CONTACT_GROUP_FULL_REFRESH` cursor, running it also **invalidates any prior
   dry-run**; re-run the dry-run after refreshing.)
2. **Verify the migration produced the expected rules.** On the **Xero member
   grouping** admin surface, confirm:
   - the mode is **Membership Type + Age**;
   - there is one **MANAGED tier-only** rule per age tier that previously had a
     primary Xero group, pointing at the same group;
   - one **ACCEPTED tier-only** rule per previously-accepted group;
   - **no other rule is active.** The migration deactivates every pre-existing
     `XeroContactGroupRule` row (written by the retired membership-types
     editor and never read by the live sync) so nothing but the tier-only
     backfill goes live at deploy. Deactivated legacy rules stay visible on
     the surface and can be re-enabled deliberately via the new UI — but only
     after this dry-run cutover has been reviewed.
3. **Run the dry-run diff.** It must show **≈ zero add/remove** for an install
   whose members were already correctly grouped. Investigate any non-zero diff
   before proceeding — the expected residue is only members who were genuinely
   mis-grouped in Xero before the cutover, plus the **information-only**
   section: members no rule matches (e.g. `NOT_APPLICABLE`
   organisations/schools) still sitting in managed groups. Those are surfaced
   with the group(s) they sit in but are **never written to** by any sync or
   bulk run — clean them up manually in Xero if desired.

## Cutover (scheduled window, owner-run)

4. **Owner review.** The owner reviews the dry-run diff (counts, per-member
   add/remove, the estimated Xero call budget, and the list of members skipped
   because they have no Xero contact). No member without a Xero contact is
   silently omitted.
   - **Truncated per-member list.** The UI renders at most `limit` (default 500)
     mismatch rows, but the **digest and headline counts gate the full set** — a
     re-sync processes every mismatch, not just the shown rows. If the dry-run
     reports **more than 500 mismatches**, raise the dry-run `limit` (up to 1000)
     to review them all before approving, rather than reviewing only the first
     page.
5. **Schedule a window.** Xero limits are ~60 calls/minute and ~5,000/day; the
   re-sync is chunked, resumable, and backs off on 429s. Size the window from
   the dry-run's call-budget estimate.
6. **Run the bulk re-sync.** Admin-triggered from the grouping surface. It is
   cache-first pre-filtered (only mismatched members are touched), processes in
   chunks, and resumes from a member-id cursor. Per-member failures are ledgered
   (in `XeroSyncOperation`) and non-fatal; a daily-limit halt leaves a resume
   cursor to continue the next day. The job never advances the CONTACT
   delta-sync watermark.
   - **Server-enforced dry-run freshness (#1961).** Each dry-run persists its
     provenance (a `XeroMemberGroupingDryRun` row: the mode, the
     `CONTACT_GROUP_FULL_REFRESH` cache cursor it was computed against, a
     fingerprint of the active rules, and a digest of the planned changes). The
     bulk re-sync must reference that dry-run id, and the **server** re-validates
     freshness at execution start — it is not a client-asserted flag. A run is
     rejected (with a message telling you to re-run the dry-run) when the
     referenced dry-run is **absent** (HTTP 422), or when — HTTP 409 — it is
     **older than the 30-minute window** (initiating run only), the **group
     cache was refreshed** since it ran (its recorded cursor no longer matches),
     the **mode or a rule changed** since it ran, or (initiating run only) the
     **planned changes drifted** from the reviewed diff. So if you refresh the
     Xero group cache, or edit the mode/rules, after previewing, you must re-run
     the dry-run before the re-sync will proceed. Resume chunks skip the
     wall-clock/plan-drift checks (a daily-limit resume may span days) but still
     enforce the cache-cursor and rules equality, so a rule or cache change
     mid-run aborts every subsequent chunk. Both the accepted run and each
     rejection are audit-logged (`XERO_GROUPING_BULK_RESYNC` /
     `XERO_GROUPING_BULK_RESYNC_REJECTED`) with the dry-run id.
   - **Started/resume semantics (#1961).** Whether a request initiates or resumes
     is decided by the **server**, not the caller. Initiating a re-sync
     atomically stamps the dry-run row as started; a resume is accepted **only**
     against a dry-run that was already started (HTTP 409 `not_started`
     otherwise — a resume cursor cannot be forged onto a never-started dry-run to
     skip the initiating freshness checks). Initiating twice from the **same**
     dry-run is rejected (HTTP 409 `already_started`); the normal flow initiates
     once and then uses **Resume re-sync** for every following chunk, so this only
     trips on a genuine double-start — re-run the dry-run to start over.
7. **Post-check.** Re-refresh the group cache and re-run the dry-run — it should
   now report an **empty** add/remove diff (the information-only section may
   still list `NOT_APPLICABLE` members you choose to leave parked in managed
   groups). Spot-check a few contacts in Xero.
8. **Optional manual cleanup.** Any Xero group the club no longer wants is
   removed **by the owner directly in Xero** — the system never deletes a Xero
   group. Members left in a now-unreferenced group are not touched by the
   system; remove them in Xero manually if desired.

## Member import — mapping modes (#2108)

`/admin/xero` → **Setup Tools** → **Import Members from Xero** creates local
members from cached Xero contact groups. Each group is mapped in one of three
modes (choose with the **Map groups to** selector):

- **Age tiers** (default, unchanged behaviour) — map each group to a bookable
  age tier (Infant/Child/Youth/Adult). No membership type is written.
- **Membership types** — map each group to an active membership type. The
  member's age tier is derived: an age-exempt **FORCED** type (its only allowed
  tier is N/A) forces `NOT_APPLICABLE`; otherwise the tier comes from the Xero
  date-of-birth, falling back to `ADULT`.
- **Membership types + age tiers** — map each group to a type AND a bookable
  tier. A FORCED type still derives N/A (the tier select is hidden and the row
  shows a "members will be age-exempt (N/A)" hint); otherwise the picked tier is
  written and the type is assigned.

Rules and guarantees:

- The API never accepts an explicit `NOT_APPLICABLE` tier — N/A is only ever
  derived from an age-exempt type.
- A type mapping requires **membership edit** access in addition to the finance
  access the import already needs; a finance-only admin is rejected.
- All selected types must exist and be **active**, or the whole import is
  rejected (nothing is written) with the offending type(s) listed.
- Assignments are written for the **current season** with source `IMPORT` and
  the contact group name as the source detail.
- **The import never overwrites an existing assignment.** A matched-existing
  member who already holds a current-season assignment is left untouched and
  reported in the result. To change such a member's type, use the bulk-assign /
  membership tooling — not a re-import.
- Newly-created members get their assignment in a batch; matched-existing
  members without an assignment go through the hardened save path, so an
  age-exempt type correctly flips them to N/A (and sweeps any future
  shared-double placements) with a per-member audit record.
- A contact that appears in two mapped groups is imported once — the first
  mapped group in the list wins, and the dropped duplicate is reported.
- If two **different** contacts link to the **same** local member with
  conflicting type mappings, the first mapping wins and the loser is reported as
  a member collision (never silently applied).
- The results panel surfaces the assignment count, any kept-existing assignments
  (with the member and both membership-type names, and a bulk-tool remediation
  hint for a different-type keep), dropped duplicate contacts, and member
  collisions — each list bounded with a "+N more" overflow.
- The import writes one summary audit row and does **not** synchronously resync
  Xero contact groups; imported members reconcile through the periodic/mismatch
  tooling described above.

## Notes & guardrails

- **A school is an ORGANISATION contact, and it is not a member**
  (`INV-INT-018`, #3367). From stage 2 of programme #2912 an approved school
  booking creates a Xero contact for the SCHOOL — the school's name with no
  first or last name, and the teacher underneath as a contact person — linked to
  the club's own `Organisation` record rather than to a `Member`. Nothing in
  this runbook groups it: contact groups are keyed on membership type and
  age tier, which a school has neither of, and the managed-group sync is a
  member-scoped path the organisation resolve never calls.
- **Do not put a school's contact into a mapped membership group.** The member
  import walks mapped contact GROUPS and creates a `Member` from each contact it
  finds there, so a school contact sitting in one would be imported as a person
  — and would then hold a contact id the school's own record also claims, which
  is the two-homes hazard `INV-INT-018` exists to stop. That import is the one
  contact-linking path that does not take the refusal, deliberately, because
  bulk contact seeding is #2939's subject.
- **A school's teacher is refreshed, its name is not.** The contact person on a
  school's contact is re-sent whenever the club's recorded teacher for that
  school changes — in practice at the school's next approval, since that is what
  records the teacher and then raises the invoice. The contact's NAME is never
  rewritten by this application, because Xero requires contact names to be
  unique and renaming an existing contact is what #2912 forbids. Rename a school
  in Xero by hand if it really has changed its name.
- **A school that booked before #3367 keeps the SAME Xero contact, and the
  school record takes it over.** Its Xero customer was created against the
  invented school member of the earlier booking; the first time the club raises
  something against that school, the school's own record claims that contact and
  the member's link is released, with an audit entry recording the hand-over.
  **Nothing changes in Xero**: the contact keeps its id, its history and every
  invoice already raised against it, so a returning school's invoices still go to
  the customer the treasurer already knows. Where a genuine duplicate does turn
  up, merge the two contacts in Xero's own interface — the API has no merge
  endpoint, so this application cannot and will not do it for you.

- **Mode/rule changes never auto-resync.** Switching the mode, or adding,
  editing, deactivating, or deleting a rule, does not re-group anyone
  immediately. Members re-group on their next trigger (age-tier change,
  current-season membership-type change, cron age-up) or via this bulk action.
  A mode/rule change also **invalidates any prior dry-run** for the bulk
  re-sync: the server's freshness check (#1961) rejects a re-sync whose
  referenced dry-run predates the change, so re-run the dry-run after editing.
- **Deleting a rule does not remove members** already in that group — it only
  shrinks the managed universe. The admin UI states this at the point of
  deletion.
- **Multi-tier rules and dry-run freshness (#2093).** Widening or narrowing a
  rule's tier set changes the grouping fingerprint the freshness check compares,
  so it invalidates any prior dry-run exactly like any other rule edit. The
  fingerprint is back-compatible for the migrated shapes: a migrated `[]`
  ("all tiers") rule and a migrated single-tier `[X]` rule fingerprint
  **identically** to the old null / scalar values, so the **first post-deploy
  resync sees no spurious churn** — only genuinely new 2+-tier rules move it.
- **`None` mode is a total no-op.** Selecting `None` leaves every existing Xero
  group membership untouched and stops all managed adds/removes, including on
  the membership-cancellation path.
- The legacy `AgeTierXeroAcceptedContactGroup` table was **dropped** by the E13
  contract migration `20260720120000` (#1939) — no deployed code queried or
  joined it after E8. The `AgeTierSetting.xeroContactGroupId/Name` columns were
  **dropped** by the #2130 STEP 2 contract migration
  `20260721130000_contract_drop_ismember_and_agetier_xero_columns`, one release
  later. E13 had deferred them because the deployed runtime still SELECTed them;
  the #2130 runtime-prep work closed that gap in two steps — `v0.12.2` narrowed
  the reads (`getAgeTierSettings`), then the STEP 1.5 release narrowed the
  writes (the age-tier settings route, setup wizard, config self-heal and seed
  upserts), since Prisma emits an implicit `RETURNING` over every scalar column
  of an unnarrowed `create`/`update`/`upsert`. The drop was deliberately **not**
  shipped in the same release as that runtime-prep: until the runtime-prep
  release is itself the deployed/draining colour, the live colour still names
  these columns in SQL. If you are upgrading a fork, deploy the runtime-prep
  release, let it soak, and only then deploy the contract migration — see
  the [upgrade guide](UPGRADING.md). Grouping is configured entirely through
  `XeroContactGroupRule` now; the dropped columns were dead copies of data E8
  had already migrated.
