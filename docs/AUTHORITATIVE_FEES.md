# Authoritative Fee Configuration

Annual membership fees and joining fees are persisted, effective-dated club
configuration. Hut fees are the lodge-scoped `Season` records; their per-night
rates are edited in the **Hut Fees** section of the consolidated **Admin > Fees**
page (`/admin/fees`, #1933 E7 — **Admin > Seasons** now holds only the season
windows), keyed by **membership type** in `MembershipTypeSeasonRate` (#1930, E4). Each `MEMBER_RATE` membership
type carries its own rate rows; non-members price via the built-in
`NON_MEMBER` type; `NON_MEMBER_RATE` (except `NON_MEMBER`) and `BLOCK_BOOKING`
types carry zero own rows. A type prices per age tier when
`MembershipType.ageGroupsApply` is true (one row per tier) or from a single flat
rate when false (one `NULL`-ageTier row).

The legacy member/non-member boolean-keyed `SeasonRate` table is **gone**. It
was retained but frozen through the E4 re-key as a rollback net, and E13 (#1939)
deliberately could not drop it because the public `{{hut-fees}}` embed still read
its member/non-member split. Step 1 of #2129 re-sourced that embed onto
`MembershipTypeSeasonRate` (one nightly-rate column per publicly-listed
membership type, with identically-priced types collapsed into one column) and
removed the admin season routes' unused `rates` include, eliminating the last
application-runtime reader. Step 2 of #2129 (Release B) then removed the
surviving seed-only reader/writers — the `include: { rates: true }` and
`rates: { create: … }` in `e2e/setup/seed-second-lodge.ts`, and
`createMissingSeasonRates` in `prisma/seed.ts` — and dropped the table in
`20260721120000_contract_drop_season_rate`, in that same PR. Both halves had to
ship together: `e2e/**` is inside `tsconfig.json`'s `**/*.ts` include and is not
excluded (only `node_modules` and test/`__tests__` paths are), so dropping the
model alone would fail `npm run typecheck`; and `scripts/e2e-stack.sh:92`
executes that seeder under `E2E_MULTI_LODGE=1`, so the required **E2E
multi-lodge** branch-protection check would fail at seed time. Do not
reintroduce a boolean member/non-member rate key.

E7 (#1933) added the grouped public presentation and token grammar on top of
this source, not a re-key. Xero
hut-fee item codes re-key the same way via `XeroItemCodeMapping.membershipTypeId`
so an invoice line never disagrees with the rate that priced it.

Each priced `BookingGuest` stores a `rateMembershipTypeId` snapshot (the type
whose rows priced it). The snapshot is recomputed and overwritten whenever a
guest is repriced; locked nights keep their booked price and stale snapshot
untouched. A `NULL` snapshot (pre-refactor booking) resolves at read time as
`isMember → FULL / NON_MEMBER`.

> **Terminology.** "Joining fee" is the user-facing name for the one-off fee a
> new member pays; "Annual Membership Fee" is the recurring fee to stay a
> paid-up member. As of E5 (#1931) the joining fee is modelled by the
> `JoiningFee` schedule, keyed by **membership type × optional age tier** (an
> age-keyed type carries one row per tier — INFANT folds onto the CHILD amount —
> and a flat-fee type such as the built-in Family type carries a single
> NULL-tier row). The legacy category-keyed `EntranceFee` table was **dropped**
> by the E13 contract migration `20260720120000` (#1939). The
> `EntranceFeeCategory` enum is deliberately **retained** — it still keys
> `XeroItemCodeMapping.entranceFeeCategory` for the live `JOINING_FEE` item-code
> mappings (E5 carried those rows forward under category `JOINING_FEE` but kept
> the physical column and enum names).
>
> **Annual fees are keyed the same way (#2067).** `MembershipAnnualFee` now
> carries the identical Flat-vs-per-tier shape: an optional `ageTier`, with the
> exact-tier row winning and the flat NULL-tier row as the fallback (a member of
> any tier, and every `NOT_APPLICABLE` member, resolves the flat row when no
> per-tier row matches). Uniqueness and overlap are per (type, tier): a raw-SQL
> partial unique index enforces one flat window per (type, effectiveFrom) and a
> pair of partial GiST EXCLUDE constraints (one over flat rows, one over per-tier
> rows) keeps windows non-overlapping within each tier (and flat-vs-flat) while
> letting flat-vs-tier and cross-tier windows coexist. Two partial constraints —
> not one COALESCE(`ageTier`::text,'') EXCLUDE — because an enum→text cast is only
> STABLE and Postgres forbids non-IMMUTABLE functions in an index/EXCLUDE
> expression. `PER_FAMILY` annual fees are **flat-only** — a per-family fee
> bills a family once regardless of age, so a per-tier per-family row is refused
> at the API (409), by a DB CHECK, and at config-transfer plan time; a flat
> per-family window may also not overlap per-tier per-member windows for the
> same type. Existing all-flat schedules keep resolving byte-identically (every
> pre-#2067 row is a flat NULL-tier row; no backfill).
>
> **Family is strictly type-driven (behaviour change, E5).** The old composition
> heuristic (an adult in a household of ≥2 adults + a dependent resolved the
> family fee) is **removed**: only members assigned the **Family** membership
> type get the flat family fee. Applicants who previously matched the heuristic
> are now invoiced their own membership type's joining fee. This is surfaced in
> the Joining Fees section of the Fees page and flagged in the PR body.
>
> **Frozen Xero idempotency (do not change).** The joining-fee invoice's Xero
> **reference** stays byte-frozen at `` `Entrance fee (<Label>) - <memberId>` ``
> and the member-scoped **mint** idempotency key stays at v1 — both are
> load-bearing adopt-by-reference keys (PR #1916) that stop an already-invoiced
> member being billed twice across the rename. Only the display *description*
> line says "joining fee", and only the enqueue-time correlation key moved to
> v2. A pre-rename minted invoice is adopted, never re-minted; a same-reference
> different-amount invoice hard-stops for manual reconciliation. Because the
> re-key deliberately flips the display label for two cohorts
> (composition-family adults FAMILY→ADULT; Family-type dependents
> CHILD/YOUTH/INFANT→FAMILY), the adopt-by-reference lookup is a **dual-read**:
> when the label the old classifier would have produced differs, the worker
> also looks up that legacy-label reference and adopts either match, so a
> label-flipped pre-rename mint with a missing link is still adopted, never
> re-minted. New mints always carry the current-label frozen-format reference.

Public PageContent blocks are double opt-in: their family is enabled in Admin >
Page Content. The fee embeds draw from these same authoritative schedules:
`{{joining-fees}}` from the joining schedule and `{{hut-fees}}` from the
per-membership-type season rates (one table per lodge x season, one column per
publicly-listed type — see `docs/PUBLIC_PAGE_CONTENT_TOKENS.md`), and
`{{annual-fees}}` from the annual-fee schedules (with `{{annual-fees:components}}`
exposing the E6 per-line breakdown). Joining-fee blocks omit tiers without a
current schedule; annual-fee blocks omit types with no current invoiceable fee
and require each type's public-listing flag. `{{annual-fees}}` has its **own**
dedicated `annualFees` visibility opt-in (default off), separate from the joining
`entranceFees` gate (D-R4); `{{membership-types}}` and `{{entrance-fees}}` are
deprecated aliases of `{{annual-fees}}` and `{{joining-fees}}`. Hut-rate blocks
use active seasons/rates plus configured age-tier labels. Fees are edited on the
consolidated **Admin > Fees** page (`/admin/fees`); **Admin > Seasons** now holds
only season windows (name/type/dates/active). Visibility writes are audited and
invalidate public routes.

## Operator workflow

1. A Membership editor opens **Admin > Membership Types**, writes a distinct
   public description, and explicitly enables public listing only after review.
   Every migrated and newly created type is hidden by default.
2. A Finance editor opens **Admin > Fees** (Joining Fees and Annual Membership
   Fees sections) and adds an
   inclusive effective-date range. Annual-fee and joining-fee ranges for the same
   type × age tier cannot overlap (different tiers may share a window). NZD
   amounts are stored as GST-inclusive integer cents. Both joining fees and
   annual fees are set per membership type and age tier, or as a flat "all ages"
   row (the fallback resolved when a member's tier has no explicit row, and the
   only shape allowed for a `PER_FAMILY` annual fee — see below).
3. For `PER_FAMILY` fees, choose one active member of every membered family as
   billing member. Login holder and family admin are never inferred. Families
   without one are visible exceptions and omitted from invoice generation.
4. Review the effective date before saving. Writes are audited and invalidate
   public page caches.

`NO_INVOICE` is explicit configuration, requires zero cents, and differs from a
missing schedule. `REMAINING_MONTHS_INCLUSIVE` is consumed by the subscription
billing workflow below.

## Subscription invoice workflow

1. Open **Admin > Subscriptions**, choose the membership year and decision date,
   and refresh the preview. The preview is read-only and makes no provider call.
2. Resolve every listed fee, assignment, family, recipient, and
   `subscriptionIncome` mapping exception. A
   per-family recipient must be active, unarchived, and a member of that exact
   family; login holder and family admin are never inferred.
3. Review each recipient, covered member, billing basis, inclusive month count,
   GST-inclusive integer-cent amount, total, current due-days setting, and the
   explicitly configured Xero account/item mapping that confirmation freezes.
4. Explicitly confirm the unchanged preview. Confirmation snapshots those
   values and creates durable outbox work. A later fee, family, or recipient
   change affects future previews only and never rewrites existing charges.
   A member added to an already-billed family is left uncovered with a visible
   `FAMILY_ALREADY_BILLED` exception; the old family snapshot is not expanded
   and a second family invoice is not created.
5. Watch the durable charge queue. `EMAIL_FAILED` can be retried safely because
   the Xero invoice identifier is persisted before email. `CONFLICT` means an
   invoice with the immutable reference exists but its contact, account, amount,
   type, or state does not match; inspect Xero and the local snapshot. The app
   never silently rewrites that provider invoice.

Only an exact `AUTHORISED` invoice with the frozen account/item identifiers and
issue-to-due interval is adoptable. Draft, submitted, paid, voided,
deleted, or otherwise mismatched records are conflicts and are not emailed by
this workflow. Recipient name/email are audit snapshots. Delivery intentionally
uses the recipient member's current Xero contact identity and current Xero
contact email at dispatch time; changing them does not rewrite the snapshot.

Annual invoice runs are never implicit: production operators must review and
confirm the preview. Newly approved members are the exception to the annual-batch
trigger only: their configured charge is queued automatically after approval;
incomplete setup records a visible exception without blocking membership.

## Family billing mode

The club-level `familyBillingMode` on `MembershipSubscriptionBillingSettings`
(edited from **Admin > Subscriptions**) decides whether family billing exists at
all, so it changes the operator and subscription rules above.

- `BILL_FAMILY_VIA_BILLING_MEMBER` (the default, preserving pre-#159 behaviour):
  per-family fee schedules are allowed and each family is invoiced once via its
  nominated billing member, exactly as the operator and subscription workflows
  above describe.
- `BILL_MEMBERS_INDIVIDUALLY`: every member is invoiced directly. Per-family fee
  schedules are disabled in the admin UI and blocked server-side with a 409 on
  create/update, and the family billing members card is hidden. A `PER_FAMILY`
  schedule left over from a mode switch is never reinterpreted as per-member; the
  billing preview raises a `PER_FAMILY_FEE_IN_INDIVIDUAL_MODE` exception, creates
  no invoice, and the schedule's basis must be changed to per-member or
  no-invoice before it can be invoiced.

## Annual fee components (multi-line invoices, E6, #1932)

An annual membership fee is broken into one or more **components** — e.g. base
membership + work party fee + FMC subscription — each rendered as its own line on
the Xero invoice, optionally coded to its own GL account/item, each with its own
choice of whether it is prorated for a mid-year joiner.

- **Lifecycle invariant.** A `NO_INVOICE` fee is a zero total with **no**
  components; every invoiceable fee has **≥1 component at all times** whose
  `amountCents` sum **exactly** to the fee total (validated server-side in the one
  transaction that writes the fee). The fee total stays authoritative, so every
  existing preview/consumer is unchanged. Creating a fee auto-creates the default
  component (label "Annual membership fee", prorate true) or copies a same-amount
  predecessor's components so a club's structure carries forward across
  effective-dated rows. Editing a fee's amount (or switching its no-invoice
  status) is **rejected** unless reconciled components are supplied in the same
  request. The invoice builder therefore never meets a fee with zero components.
- **Proration.** The fee-level `prorationRule` decides the covered month count
  (unchanged). Per component, `charged = prorate ? floor((amount × months + 6) /
  12) : amount`, and the charge total is **Σ components**. For a **single**
  component (every fee immediately after the day-one backfill) this equals the
  old fee-level calculation byte-for-byte. For a **multi-component prorated** fee
  the sum of per-line half-up roundings can differ from a single fee-level
  rounding by up to **(n−1) cents** — this is intended: the charge total is
  authoritative as Σ components so the invoice (one line per component) always
  foots to the charge amount.
- **Immutability & adoption.** Confirmation freezes one
  `MembershipSubscriptionChargeComponent` per line (the immutable-charge invariant
  extends to these rows). The invoice builder emits one line per component in
  stable order; the adoption guard compares the full line array (count + per-line
  amount/account/item/OUTPUT2 tax) plus total, reference, contact, due interval,
  type, line-amount type and status — **line description is not compared**, and
  neither does invoice lookup use it (that matches on the charge's immutable
  `Reference`). A legacy charge minted before the backfill still reproduces its
  single line via the same derivation the backfill uses.
- **How the season is named on a line (#3116).** The description names the season
  through the shared derivation in `src/lib/season-label.ts`, from the club's
  **configured financial year-end** — `2026 - 2027` for a March year-end, and
  plain `2026` for a December one, whose season starts in January and ends in the
  same calendar year. It previously assumed two calendar years unconditionally,
  which printed a season name contradicting the season year beside it for any
  club whose year does not end in March.
  **The year-end is resolved and passed explicitly at every one of these sites,
  never defaulted.** `seasonYearsLabel` defaults it to a process cache that only
  request paths seed, so a background worker — the Xero outbox, which is what
  mints these invoices — would silently answer March.
  `buildComponentLineDescription` therefore **requires** the year-end, making an
  unstated one a compile error. An existing charge is unaffected either way: its
  line text is a persisted column (`MembershipSubscriptionChargeComponent.description`),
  written at plan time and read back at mint, so changing the derivation changes
  only newly-planned charges.
  **The day-one backfill migration below therefore keeps the OLD wording forever,
  and that is correct rather than drift.** Migration
  `20260717195000_annual_fee_components_and_billing_family` builds the historical
  description in SQL, including the two-calendar-year season. It has already run
  everywhere, its rows are read back verbatim, and they match invoices Xero
  already holds. A committed migration reproduces what was true when it ran, so
  **do not "fix" that SQL to match `buildComponentLineDescription`** — they are
  deliberately different, and syncing them would rewrite the naming of charges
  that were invoiced under the old wording.
- **Day-one backfill** (owner-approved additive derivation): one default
  component per existing invoiceable fee, and one verbatim snapshot component per
  existing invoiceable charge whose description is rebuilt from the exact
  historical template including `(1 month)` vs `(N months)` pluralization. No
  existing charge, invoice, or amount is mutated.

## Per-member billing family (E6, #1932)

A member can belong to more than one family group. In
`BILL_FAMILY_VIA_BILLING_MEMBER` mode a `PER_FAMILY` fee for such a member is
resolved by an admin-chosen **billing family** (`Member.billingFamilyGroupId`),
set from the member detail family card or the fee-config family-billing panel
(audited, finance:edit; greyed with a note in `BILL_MEMBERS_INDIVIDUALLY` mode
where it is ignored):

- multi-family member, selection set and still one of their groups → bill that
  family (through the same recipient checks as an unambiguous family);
- selection set but no longer one of their groups → `INVALID_BILLING_FAMILY_SELECTION`;
- selection unset → `AMBIGUOUS_FAMILY` (unchanged);
- single-group member → the field is ignored.

Removing a member from a family **NULLs the selection in the same transaction**
across all six removal paths (group edit/delete, family removal request, member
archive, membership cancellation, deletion request, bulk deactivate). Safety
property: any missed path degrades to a visible `INVALID_BILLING_FAMILY_SELECTION`
at the next billing preview — never silent misbilling.

## Joining-fee re-key and day-one fidelity (E5, #1931)

The migration copies every effective `EntranceFee` window verbatim into
`JoiningFee`, **fanned out to every joining-fee-liable membership type** (all
types except the built-in NON_MEMBER and SCHOOL, including archived liable
types so history stays resolvable): the ADULT/YOUTH/CHILD (+ INFANT fold) tiers
land on every per-tier liable type, and the FAMILY amount lands on the built-in
Family type as a flat NULL-tier row. Every member's resolved amount is therefore
byte-identical on day one — the only intentional change is the family fee
becoming type-driven. A coverage-based pre-check materialises any category that
still depended on a legacy mapping amount into `JoiningFee`: it fires whenever
**no `EntranceFee` window covers the migration day** (no rows, all lapsed, or
all future — matching the removed runtime fallback, which applied whenever no
window was active as-of today), and the materialised open window is bounded to
the day before the category's earliest future window so it never overlaps a
scheduled fee. The old runtime mapping-amount fallback is **removed** this
release. The migration date is the honest effective-from boundary for any
materialised legacy window. The `ENTRANCE_FEE` Xero item-code rows are re-keyed
to `JOINING_FEE`, carrying the item codes forward byte-identically; the Xero
mappings panel is now **item-code-only** for joining fees (the mapping rows'
`amountCents` is dead at runtime, so amounts are edited solely in the Joining
Fees section of the Fees page). No live Xero call occurs during migration
or configuration.

Resolution reads `JoiningFee` only: pick the type's row for the member's age
tier, else the type's flat NULL-tier row; a type with no rows raises no joining
fee (graceful skip). The N/A age tier (organisations/schools) is exempt, checked
**before** type resolution. Config-transfer now transfers the joining-fee (and
annual-fee) schedules **first-class** via the `membership-fees` category
(#1941): `membership-fees/joining-fees.csv` carries `JoiningFee` rows keyed by
`membershipTypeKey × ageTier × effectiveFrom` (amounts in integer cents), so an
export→import reproduces the schedule exactly. When a bundle carries that file
it is authoritative and **supersedes** the legacy fallback below.
`membership-fees/annual-fees.csv` (and `annual-fee-components.csv`) likewise
carry an `ageTier` column (#2067) so per-tier annual fees round-trip; a
pre-#2067 bundle without the column imports every row as flat, and a per-family
row with a non-blank `ageTier` is a blocking plan-time error.

When a bundle carries **no `joining-fees.csv`** — a bundle exported without the
`membership-fees` category, or one imported with that category unticked — the
**item-code-amount fan-out still runs**. Config-transfer materialises the
bundle's **current `JOINING_FEE`** item-code `amountCents` values into
`JoiningFee` windows via the same fan-out whenever the target has no covering
window for a category, so importing such a bundle into a fresh install cannot
silently produce a zero joining fee. This is live behaviour, not old-bundle
compatibility; see [`docs/config-transfer/README.md`](config-transfer/README.md)
(membership-fees) for the precedence rule.

Genuinely **old bundles are rejected, not converted**. Since #2131 (one release
after the E13 contraction) a bundle carrying the pre-#1931 `ENTRANCE_FEE`
item-code category name, or the legacy `isMember` key on the Xero HUT_FEE
item-code rows or on `season-rates.csv`, fails dry-run validation with a
row-named error that disables Apply — it is never silently normalised to
`JOINING_FEE` or mapped to a membership type. **v0.12.2 was the last release
that could import those shapes.** Re-export the bundle from an install running
the current release, or hand-fix it with the conversion recipe in the
[Export & Import operator guide](guides/config-transfer.md#converting-a-legacy-bundle-by-hand).

## Safety checks

- Confirm current versus compatibility values on the admin page.
- Resolve every family billing exception before a future invoice run.
- Archive rather than delete or merge membership types with fee history.
- Production invoice runs are outside this workflow and require separate
  explicit operator confirmation.
