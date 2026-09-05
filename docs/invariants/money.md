# Money

Audience: Developer, Agent.

Prefix defined in this file: **`INV-MONEY`** — how money is represented and where
a price comes from: integer cents, fee authorities, whole-lodge pricing, promo
caps, subscription charges and subscription-invoice selection.

Read this file when you are changing anything that holds cents — fee
authorities, whole-lodge or promo pricing, membership subscription charges, or
the Xero invoice identity behind them.

Index: [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) — every `INV-*` ID
with a one-line description of what it covers. ID scheme and allocation rules:
[`SCHEME.md`](SCHEME.md).

Every heading below whose whole text is an `INV-*` ID defines that invariant. IDs
are permanent: never renumbered, never reused. **The text under each ID is a
verbatim move from the source document and must not be reworded in place** —
only the ID heading lines, and the editorial **Related:** lines directly beneath
some of them (#2707), were added. A `Related:` line is navigation, never part of
the rule: it names sibling IDs so a change to one prompts checking the others.

## INV-MONEY-001

**Related: `INV-MONEY-003`** (the mechanically checkable half — a lint rule can
catch floating-point arithmetic, where "store as integer cents" is not
checkable by machine) and **`INV-MONEY-006`** (the reconciliation obligation the
representation exists to serve). Three facets, not three statements of one rule
(#2707, owner decision 9 Aug 2026). Change one, check the others.

- Store and calculate money as integer cents.

## INV-MONEY-002

- Annual membership and joining fee authorities store non-negative integer
  cents in inclusive, non-overlapping effective-date ranges. Both annual fees
  (`MembershipAnnualFee`, #2067) and joining fees (`JoiningFee`, #1931) key on
  membership type × **optional** age tier: a per-tier row wins at resolution,
  else the flat NULL-tier row is the fallback (a member of any tier, and every
  `NOT_APPLICABLE` member, resolves the flat row when no per-tier row matches).
  "Non-overlapping" is per (type, tier): different tiers may share a window, but
  two windows of the same tier — or two flat windows — may not overlap.
  `PER_FAMILY` annual fees stay **flat-only** (a per-family fee bills the family
  once regardless of age): a per-tier per-family row is rejected at the API
  (409), by a DB CHECK, and at config-transfer plan time, and a flat per-family
  window may not overlap per-tier per-member windows for the same type.
  `NO_INVOICE` annual rows are zero cents. The joining fee is strictly
  type-driven — the Family fee applies only to members assigned the Family type
  (the composition heuristic is removed). Fee changes affect future resolution
  only.

## INV-MONEY-003

**Related: `INV-MONEY-001`** (the representation rule this one makes
enforceable) and **`INV-MONEY-006`** (reconciling back to cent-based ledger
records). Three facets, not three statements of one rule (#2707, owner decision
9 Aug 2026). Change one, check the others.

- Do not introduce floating point money arithmetic.

- **Cents are built at one of two boundaries, never inline (#2685, owner
  decision 9 Aug 2026).** Money a PERSON typed still has its decimal text, so it
  goes through `parseDecimalDollarsToCents` in `src/lib/money-input.ts` — the
  digit groups are read as integers and never scaled through a double — or
  through `parseSignedDecimalDollarsToCents` where a negative is a real amount
  (a member credit debit adjustment). It returns `null` for anything outside the
  grammar, and **that `null` must reach the person as a validation error**: no
  caller may substitute a zero, a `null` payload field, or a previous value
  silently. A money box is therefore spelled `type="text"` with
  `inputMode="decimal"` — `MONEY_INPUT_PROPS` from the same module (owner
  decision 14 Aug 2026): a `type="number"` control's value-sanitization strips
  anything that is not a floating-point number to `""` before any handler runs,
  so the parser never saw `"50abc"`, `"$45.00"` or `"1,000.00"` and the box read
  as deliberately cleared. An amount an accounting provider has ALREADY parsed into a number —
  a Xero API amount — cannot use that parser, because the decimal text is gone;
  it goes through `providerAmountToCents` in `src/lib/money-provider-amount.ts`,
  whose rounding is `Math.round(value * 100)` and is FROZEN at that, since it is
  what every reconciliation currently in production computes. Changing it is an
  owner decision, not a refactor. `exactProviderAmountToCents` is the variant
  that refuses sub-cent precision, and `parseProviderReportAmountToCents` is the
  one Xero report-cell text parser.

  An `eslint` `no-restricted-syntax` rule enforces this over `src/`, `scripts/`
  and `prisma/`. It matches the dangerous COMPOSITION rather than a function
  name — an inline numeric parse scaled by 100, a unary `+` coercion scaled by
  100, anything scaled by 100 on the way into a `…Cents` binding, and the two
  spellings that carry no `* 100` at all (`c *= 100` and `x / 0.01`) — plus, in
  the money-domain modules, a bare `x * 100`. Banning `parseFloat` by name was
  measured on this tree and rejected: it added no coverage and four false
  positives.

  The money-domain glob is the Xero, finance, membership-cancellation, payment,
  credit, refund, promo, fee, invoice, subscription, pricing and Stripe modules
  under `src/lib/`, plus every route under `src/app/api/`. That breadth is what
  catches the intermediate-variable form — `const d = parseFloat(raw); const c =
  Math.round(d * 100);` — which no shape-based arm can see, because by the time
  the multiplication happens there is nothing left in it to recognise. Inside
  those modules ONE shape is excluded on purpose: a division sitting directly
  inside the multiplication (`(calls / budget) * 100`) is a percentage by
  construction, and nothing here builds cents from a quotient.

  That exclusion is narrow only because the money-domain block states the arms
  the broad one does not cover. It does NOT subsume them, and while the config
  claimed it did, a typed amount that was DIVIDED and then scaled — a GST split
  `(parseFloat(gross) / 1.15) * 100`, a per-guest share
  `(parseFloat(raw) / guests) * 100`, a unit price
  `(parseFloat(line.total) / line.qty) * 100` — was caught in an ordinary
  `src/lib` file and caught nowhere at all in a Xero module, a payment module or
  an API route, which is the guard at its weakest exactly where money lives.
  Both give-backs are therefore explicit: a quotient of PARSED TEXT, and a
  quotient scaled into a `…Cents` binding. What stays legal is a quotient that
  is neither.

  Percentages, `Math.round(n * 100) / 100` two-decimal rounding and date-key
  packing are deliberately untouched OUTSIDE the money-domain modules. Inside
  them a bare `x * 100` IS reported, whatever it computes — that is what the
  narrower glob buys, and it is why the glob covers only files that compute no
  percentages. All of it is pinned as fixtures in
  `src/lib/__tests__/money-cents-guard.test.ts`, which runs the REAL config.

  That suite decides whether the guard reaches production code by asking ESLint,
  never by reading glob text. It resolves `no-restricted-syntax` through
  `calculateConfigForFile()` at a roster of representative production paths,
  requires an `error`-severity rule still carrying every arm that path needs, and
  then lints an actual violation at each of them. A glob that avoids the `src/`
  prefix, a config block with no `files` key at all, and a severity quietly
  downgraded to `warn` each disarm the guard while leaving a glob-text check
  green, so none of the three is trusted. The roster and both audits live in
  `src/lib/__tests__/support/eslint-guard-coverage.ts`, shared with the date
  guard, which has the same hazard.

  The exported `MONEY_GUARD_EXEMPTIONS` array in `eslint.config.mjs` is the only
  escape hatch — never an `eslint-disable`, and the guard test asserts there are
  none in the tree. Each entry names a path and states in writing why it is
  allowed to build cents itself; the test READS that array rather than a copy of
  it, so adding an entry passes CI. It currently holds exactly the two helper
  modules, and both are on the roster, so an exemption still has to resolve to an
  armed `error` rule carrying the date and raw-SQL restrictions.

## INV-MONEY-004

- **Member whole-lodge approval pricing has a fixed precedence (#2338, owner
  decision 1 Aug 2026).** A season may carry an optional flat whole-lodge night
  rate (`Season.flatWholeLodgeNightCents`, integer cents, nullable = not set).
  When the approving officer prices a member whole-lodge request
  (`approveMemberWholeLodgeRequest`), the total is chosen in this order and no
  other: (1) the officer's manual total override, if given, wins over everything;
  (2) else, if the officer ticked "price as whole lodge" AND a flat rate covers
  **every** night of the stay, the total is the sum of each night's covering
  season's flat rate, and **headcount is ignored for price** (it still drives the
  guest rows and the capacity check); (3) else per-guest pricing, exactly as
  before. The flat branch is never automatic — it is the officer's per-approval
  choice, defaulting to per-guest so nothing changes silently — and a stay only
  ever falls out of it when a night has no flat rate, in which case it reverts to
  per-guest rather than charging zero. A stay spanning a season boundary is
  charged each night at that night's season flat rate. The pure per-night math is
  `priceWholeLodgeFlat` (`src/lib/policies/pricing.ts`); the same figure is
  previewed in the admin queue and computed authoritatively at approval time.

## INV-MONEY-005

- **A promo "use" means the member actually got something (#2299).** A
  `PromoRedemptionAllocation` row exists only where the application delivered a
  benefit — `discountCents > 0`, `priceAdjustmentCents ≠ 0`, or
  `freeNightsUsed > 0` (a price-RAISING fixed-nightly application counts: the
  member's price genuinely changed). All three usage caps count those rows and
  nothing else: uses per member, unique members, and total redemptions via the
  denormalised `PromoCode.currentRedemptions`. The single write-time choke point
  is `normalizeAllocations` in `src/lib/promo.ts`; every cap query additionally
  applies `BENEFICIAL_PROMO_ALLOCATION_FILTER` so a legacy all-zero row cannot
  occupy a slot. Two corollaries: (a) `currentRedemptions` is always the RAW
  count of a code's allocation rows, so `redeemPromoCode`,
  `replacePromoRedemptionAllocations` and `deletePromoRedemptionAndAdjustCount`
  must measure their delta against the raw row count, never a filtered one; and
  (b) a reprice that destroys a booking's promo benefit RELEASES the slot it
  held, in the same transaction that removes the benefit — a member holds
  exactly as many slots as they hold benefits, at every instant. The
  `PromoRedemption` row is never benefit-gated: it persists for any application
  with eligible guests and is the audit and reporting trail, which is why the
  archive-or-delete decision for a promo code counts redemptions, not
  allocations (`PromoRedemption.promoCodeId` is `onDelete: Restrict`).
  **Statement order in the two redemption writers is load-bearing**, because the
  `PromoRedemption_sync_allocation_insert` / `..._update` triggers
  (`20260527120000_add_promo_redemption_allocations`) upsert a booker allocation
  row straight from the redemption's own scalars on every `PromoRedemption`
  write — they exist so an old blue/green colour that writes only
  `PromoRedemption` still records an allocation. For a zero-benefit application
  that row is all-zero, so the allocation `deleteMany` must stay AFTER the
  redemption create/update (or the database silently puts back the row this
  invariant removes), and `replacePromoRedemptionAllocations` must count the
  existing rows BEFORE its update (or it counts the trigger's transient row and
  skews the counter delta).

## INV-MONEY-023

- **Reading `currentRedemptions` for a cap check requires the row lock, and a
  read under it.** Every path that may write the counter for an existing
  booking — `booking-modify-plan.ts`, the add-guests route,
  `booking-date-modification-service.ts`,
  `booking-guest-removal-service.ts` — takes the `FOR UPDATE` promo row lock
  before its first cap read, and re-reads the counter under that lock, because
  the `PromoCode` snapshot it carries was loaded with the booking, before the
  locks. All four reprice call sites do that re-read through
  `lockAndRefreshPromoCodeUsage` (including `booking-modify-plan.ts` on its
  no-swap reprice branch; its swap branch re-reads the whole promo row under
  the same lock instead), and each must then validate against the object the
  wrapper RETURNS — validating the snapshot that went in reopens the race. See
  `docs/CONCURRENCY_AND_LOCKING.md` → "Narrow row-lock protocols".

## INV-MONEY-024

- **A reprice narrows a promotion's coverage; it never refuses the edit
  (#2390).** On the four reprice paths (and the edit preview, which must match
  them) the cap question is "who does this code still cover?", not "may this
  booking use it?". Members already holding a **beneficial** allocation on the
  booking being repriced are counted first and kept unconditionally — even
  where they alone exceed a cap, which is the stated behaviour when an admin
  lowers a cap under bookings that already have the discount; everyone else is
  admitted in the order the promotion applies to them — **most expensive stay
  first**, the order `selectPromoDiscountGuests` produces — until the
  allowance runs out. Booking creation and applying a newly-entered code still
  refuse, because nobody holds a discount from the code yet.
  - Protection is applied **inside** that selection, not after it: a
    `maxGuestsPerBooking` cap is spent while the beneficiary list is built, so
    an expensive newly-added guest would otherwise evict a member who already
    held the discount before any protection check could see them. Anyone a
    protected member keeps their slot ahead of is named in the coverage
    notice, so nobody is left out silently.
  - A member who has personally used the code up is left out **by the trim**,
    not filtered away before it, so they reach the notice rather than being
    priced normally with nothing said.
  - For a `FREE_NIGHTS` code the lifetime cap is a budget, not a slot, so a
    protected member's remaining nights are floored at what this booking's own
    allocation rows already granted them. Keeping them on the list is not
    enough: a lowered cap would otherwise award them zero nights while still
    reporting them as covered.
  - The protected set is read from `PromoRedemptionAllocation` **before the
    redemption write**, for the same trigger reason as the two orderings
    above: `PromoRedemption_sync_allocation_update` upserts a booker
    allocation row, and a protected-set read placed after it would grant
    protection nobody earned.
  - An empty covered set is refused explicitly rather than falling through.
    Downstream an empty beneficiary list means "unassigned promo", which would
    price the code for every guest on the booking, cap and all.

## INV-MONEY-025

- **A cap check that excludes a booking must exclude it from
  `currentRedemptions` too.** The counter includes the rows the excluded
  booking holds right now, and unlike every other cap it cannot be filtered by
  a `where`. So `excludeBookingId` is paired with an explicit raw count of
  that booking's own allocation rows, subtracted before the total-redemptions
  cap is applied. Omitting it makes a booking holding a code's last slot fail
  its OWN reprice, silently drop the discount, and bill the member the
  discount back for a date change.

## INV-MONEY-026

- **TRAP: the in-memory `PromoDiscountResult.allocations` is NOT
  benefit-filtered on the assigned-member path.** `policies/pricing.ts`
  deliberately emits a zero entry for a `SET_PRICE` guest whose rate already
  equals the fixed price (`includeWhenZero`), and
  `calculatePromoDiscountForGuestRates` returns the assigned-member result
  before `normalizeAllocations` runs. The filter is applied at WRITE time
  instead, inside `redeemPromoCode` / `replacePromoRedemptionAllocations`.
  Anything that reads that in-memory list as "who benefited" must apply
  `isBeneficialPromoAllocation` itself.

## INV-MONEY-027

- **A `SET_PRICE` application whose per-guest adjustments net to exactly zero
  counts as no use** (deliberate; #2299). In `SET_PRICE` mode every night is
  re-priced, so a fixed price of $30 against nights of $50 and $10 nets to
  zero, as does one member owning two guest rows that cancel. The member's
  total is byte-identical with and without the code, so under the "any price
  effect" rule there is no effect, and it consumes nothing. The accepted
  consequence is that such a stay can carry the code indefinitely — which
  costs nothing, because it gives nothing.

## INV-MONEY-028

- **Every `BookingGuestNight.priceCents` records where that amount came from.**
  `SOLD` means a live sale or reprice wrote the per-night quote;
  `OFFICER_PRICED` means a person supplied the amount while resolving stored
  history; `EVEN_SPLIT` means a writer mechanically divided a guest total across
  nights (including the three historical backfills); and `UNKNOWN` means the
  origin cannot be proved. `EVEN_SPLIT` is not evidence of what any individual
  night was sold for. Unknown provenance stays
  unknown: no reader or migration may re-derive it from the amount, rate table,
  guest total, timestamp, or any other present-day data (#3275, programme
  #3272). Migration verification must mutation-prove both the historical
  writer classifiers (including zero and null amounts) and every predicate that
  admits a draining-colour officer-repair audit.

## INV-MONEY-006

**Related: `INV-MONEY-001`** (money is held as integer cents) and
**`INV-MONEY-003`** (the lintable form of that). This one is a distinct
obligation rather than a restatement — the named surfaces must reconcile, not
merely be represented correctly (#2707, owner decision 9 Aug 2026). Change one,
check the others.

- Refunds, credits, discounts, Stripe amounts, Xero invoice amounts, and
  membership fees must reconcile back to cent-based ledger records.

## INV-MONEY-007

- Admin adjustments need audit, approval, and a visible business reason.

## INV-MONEY-008

- A confirmed `MembershipSubscriptionCharge` is an immutable snapshot: fee and
  membership type, billing basis, annual/charged cents, proration, dates/months,
  covered subscriptions, family, recipient name/email, due days, frozen
  `subscriptionIncome` account/item identifiers, reference, **and its frozen
  `MembershipSubscriptionChargeComponent` rows** (one per Xero invoice line —
  label, description, annual/charged cents, prorated flag, account/item, order)
  never change. Only delivery/status/Xero metadata may advance.

## INV-MONEY-009

- An annual fee has ≥1 `MembershipAnnualFeeComponent` at all times unless it is
  `NO_INVOICE` (zero total, no components); the components' `amountCents` sum
  exactly to the fee total (validated in the one transaction that writes the
  fee), a charge's `chargedAmountCents` is Σ its components, and the invoice
  carries one line per component. A single-component fee is byte-identical to the
  pre-component single-line behaviour; a multi-component prorated fee may diverge
  by up to (n−1) cents by design because the charge total is authoritative as Σ
  components.

## INV-MONEY-010

- Every `MemberSubscription` can be covered by at most one charge. A
  season-scoped advisory lock plus the unique coverage constraint makes annual
  confirmation, approval replay, and concurrent operators idempotent.

## INV-MONEY-011

- `PER_MEMBER` bills that member. `PER_FAMILY` requires one explicit active,
  unarchived recipient in the exact family. `NO_INVOICE` is an explicit
  zero-cent outcome, not missing configuration.

## INV-MONEY-012

- The club-level `familyBillingMode` on `MembershipSubscriptionBillingSettings`
  decides whether family billing exists at all. `BILL_FAMILY_VIA_BILLING_MEMBER`
  (the default, preserving pre-#159 behaviour) allows `PER_FAMILY` schedules and
  invoices each family via its nominated billing member.
  `BILL_MEMBERS_INDIVIDUALLY` invoices every member directly: the fee-config
  family-billing card is hidden, no billing-member exception is ever raised, and
  `PER_FAMILY` schedules are blocked server-side on create/update. A stale
  `PER_FAMILY` schedule left over from a mode switch is never silently
  reinterpreted as per-member; the billing engine surfaces it as a visible
  `PER_FAMILY_FEE_IN_INDIVIDUAL_MODE` exception and invoices nothing for it. The
  guard sits ahead of every per-family branch, so it makes the per-family
  family-resolution branches (including `MISSING_FAMILY` / `AMBIGUOUS_FAMILY` /
  `MISSING_FAMILY_RECIPIENT` / `INVALID_FAMILY_RECIPIENT`) unreachable in
  individual mode by construction.

## INV-MONEY-013

- A member in more than one family is billed for a `PER_FAMILY` fee only via
  their admin-chosen `Member.billingFamilyGroupId` (consulted solely in
  `BILL_FAMILY_VIA_BILLING_MEMBER` mode, through the same recipient checks as an
  unambiguous family): valid selection bills that family, a stale selection
  raises `INVALID_BILLING_FAMILY_SELECTION`, and an unset selection raises
  `AMBIGUOUS_FAMILY`. The selection is NULLed in the same transaction as any
  removal of the member from that family across all six removal paths, so a stale
  pointer can only ever degrade to that visible exception — never silent
  misbilling.

## INV-MONEY-014

- One family/membership-type/membership-year tuple can have at most one durable
  charge. A later family member produces a visible exception; neither coverage
  mutation nor a second invoice is allowed.

## INV-MONEY-015

- Membership approval remains authoritative when billing setup is incomplete:
  billing records a visible post-approval exception/warning and never rolls the
  member transaction back.

## INV-MONEY-016

- **Membership type is the sole subscription authority; role carries no
  exemption (#2149).** Whether a member owes a subscription is decided ONLY by
  their effective membership type (`subscriptionBehavior`, plus the per-age-tier
  flag where the type is `BASED_ON_AGE_TIER`). Access **role is a pure permission
  concept** and grants no exemption of its own — the retired
  `roleNeverRequiresSubscription` short-circuit is gone from every derivation
  (booking gate, profile, subscriptions list, admin members list + its SQL
  filters, CSV export, member-guest booking block, and the Xero sync). Operational
  and non-member accounts are exempt only because they resolve to a `NOT_REQUIRED`
  membership type: a member with no explicit season assignment falls back through
  `defaultMembershipTypeKeyForRole`, which maps `ADMIN`→built-in `ADMIN`
  (BLOCK_BOOKING, NOT_REQUIRED), `LODGE`→built-in `LODGE` (MEMBER_RATE,
  NOT_REQUIRED — so the kiosk still books, including across a season rollover),
  and `SCHOOL`/`NON_MEMBER` to their NOT_REQUIRED built-ins; `USER` falls back to
  `FULL` (REQUIRED). A real fee-paying human who holds the admin permission is
  assigned a normal REQUIRED/BASED_ON_AGE_TIER type and owes a subscription like
  anyone else — showing their real Paid/Unpaid status on every surface. Those
  two built-in operational types are DB-seeded by a real idempotent migration
  because the annual-billing preview resolves fallback types from the database.
  `Member.lifeMemberDate` is **informational only** and is never read by any
  subscription derivation — the Life exemption is the `LIFE` membership type
  (subscriptionBehavior `NOT_REQUIRED`).

## INV-MONEY-017

- **Paid-up semantics (one meaning, three facts).** A member counts as paid-up
  (not owing a subscription) when ANY of: their membership-type policy
  `subscriptionBehavior` is `NOT_REQUIRED` (Life/honorary/operational — no
  subscription row needed); their current-season `MemberSubscription.status` is
  `PAID`; OR their type is `BASED_ON_AGE_TIER` and their age tier does not
  require a subscription — which, once the annual-fee sweep has run, is recorded
  as a NOT_REQUIRED current-season `MemberSubscription` row that is thereafter
  authoritative (the third fact, #2041). Booking (`findUnpaidMemberGuests`),
  nomination eligibility (`verifyNominator`), the member-facing
  `/api/member/subscription-status`, the admin members-list flag
  (`admin-members-service`), and the Xero sync (`checkMembershipStatus`) all
  resolve paid-up from these same facts. Before the sweep writes the row there is
  a pre-sweep window in which a `BASED_ON_AGE_TIER` exempt member has no row yet;
  every surface still reads exempt because the tier-flag check is the same fallback
  the sweep uses, and once the row exists the members-list and Xero-sync surfaces
  consult it so a manual mid-season tier promotion can never make them disagree
  with the booking gate. Nomination deliberately honours ONLY the membership-type
  `NOT_REQUIRED` rule, NOT the booking side's junior age-tier subscription
  exemption (`requiresPaidSubscriptionForAgeTier`): nominating is an adult-member
  act and widening it to un-subscribed junior tiers is an owner policy decision.
  A third `subscriptionBehavior`, `BASED_ON_AGE_TIER` (#2041), defers the
  subscription-required answer to the per-age-tier
  `AgeTierSetting.subscriptionRequiredForBooking` flag — the SAME flag that gates
  booking-lockout — so it is the single source of truth for both booking-lockout
  and annual-fee invoice minting. Under it, the billing sweep skips a member
  whose age tier AT THE START OF THE SEASON (the club financial year, derived
  from DOB; stored tier as the fail-closed fallback when DOB is unknown) does not
  require a subscription, and writes that member a NOT_REQUIRED
  `MemberSubscription` row for the season. That NOT_REQUIRED status row is then
  authoritative and dominates in the booking resolvers: it keeps booking status
  consistent with billing even if the member's stored age tier is later promoted
  mid-season. `REQUIRED` and `NOT_REQUIRED` type behavior is byte-unchanged.

## INV-MONEY-018

- **Manual mark-paid provenance (non-Xero clubs / cash).** `status = "PAID"` can
  be set outside the Xero pipeline by an audited finance:edit action, recorded by
  `manuallyMarkedPaidAt` / `manuallyMarkedPaidByMemberId` / `manualPaymentNote`.
  This path never calls Xero and never creates or voids an invoice, and it exists
  only for cash payments where NO Xero invoice exists: marking paid is rejected
  when the row carries a Xero invoice link (record the payment against the
  invoice in Xero instead) or is `NOT_REQUIRED`, and both manual writes are
  status-fenced conditional updates so concurrent actions cannot double-apply.
  No writer may clobber a manual PAID: the annual-invoice sweep never invoices a
  subscription already `PAID` (a manual PAID has no charge-coverage row, so the
  guard keys off status, not coverage); a queued/retrying invoice charge
  conflicts (`SUBSCRIPTION_ALREADY_PAID`) instead of minting an invoice for a
  covered subscription that became `PAID`, and its coverage write never
  downgrades a `PAID` row; Xero discovery/reconciliation
  (`checkMembershipStatus`) never downgrades a manually marked-paid row that
  carries no Xero invoice link (a write-time fence, so a manual mark-paid
  landing mid-sync is also safe); and `flushMemberSubscriptionHistory` treats a
  manual-PAID row as financial history and never deletes it on contact
  link/push/unlink. Once a real Xero subscription invoice links to the row,
  Xero is authoritative again and the linking write clears the manual
  provenance columns (a row can never read "UNPAID (manual)"). Reversal
  (finance:edit) restores `NOT_INVOICED` (or `UNPAID` on a legacy row with an
  invoice link) and clears the provenance columns; both directions are audited
  with the acting admin, including the previous status.

## INV-MONEY-019

- **Closed-loop item-code detection (#2109).** When the opt-in
  `MembershipLockoutSettings.useFeeScheduleItemCodes` look-through is on, paid
  detection matches ANY item code stamped on the fee schedule — the resolver
  `getSubscriptionItemCodes()` returns the distinct non-null
  `MembershipAnnualFeeComponent.xeroItemCode` values (every historical fee row
  contributes; prior seasons were billed under retired rows) UNION the single
  `subscriptionIncome.itemCode`. Because billing stamps exactly those component
  codes onto invoice lines, the detection set is always a **superset** of the
  codes the billing pipeline can stamp: a member billed under the fee schedule is
  always detectable by item code. Default off reproduces single-item-code
  detection byte-for-byte. Detection is UNION (never per-member) so family
  invoices and the member-less inbound reconciler resolve the same set.

## INV-MONEY-020

- **Strong-first subscription-invoice selection (#2109).** Widening the item-code
  set means several season invoices can match (e.g. a paid subscription plus an
  earlier unpaid hut-fee invoice sharing a code), so — WHEN look-through is on —
  `findSubscriptionInvoice` never returns the first match over the widened set.
  It collects ALL matches and selects preferring (1) a STRONG match (the account
  code, the flat fallback item code, or the text fallback) over a union-only
  fee-schedule match, then (2) a PAID/settled invoice over UNPAID/OVERDUE, then
  (3) earliest/stable order. Strong-first is deliberate: a PAID union-only match
  must never outrank an UNPAID strong match, or the lockout would unlock exactly
  the member it should hold. In the motivating scenario the paid subscription is
  itself strong, so it still wins and a genuinely paid member is never marked
  unpaid — the `matchedInvoiceId` upsert picks the paid subscription invoice, so
  manual mark-paid provenance survives — even when an overlapping code exists.
  With look-through OFF (a single-code set) selection is skipped and the legacy
  first-match-in-list-order invoice is returned, byte-for-byte. The member-less
  inbound reconciler sees one invoice at a time and treats it as a subscription
  ONLY on a strong match (never a union-only fee-schedule code), so a shared-code
  fee invoice writes no subscription audit links and triggers no per-member
  refresh there; per-member detection still sees such invoices when a member's
  full set is evaluated. The settings overlap warning still steers admins to give
  subscriptions dedicated item codes.

## INV-MONEY-021

- Xero invoice identity is persisted before Xero email. Email retries reuse it.
  Existing invoices are adopted only on an exact `AUTHORISED` snapshot match;
  conflicts are visible and never trigger a silent provider rewrite. Xero
  delivery resolves the snapshotted recipient member's current contact/email;
  frozen name/email remain audit evidence rather than a stale delivery target.

## INV-MONEY-022

- A member has at most one joining-fee invoice (#1886, F21; formerly
  "entrance-fee" — the Xero reference `` `Entrance fee (<Label>) - <memberId>` ``,
  the `ENTRANCE_FEE_INVOICE` link role, and the member-scoped v1 mint key stay
  frozen so the rename never re-invoices, #1931). The worker mints
  only after re-checking the durable `ENTRANCE_FEE_INVOICE` link and, failing
  that, looking the member-unique invoice reference (full member id, not a
  truncated prefix) up in Xero. A found invoice is adopted only when it is THIS
  member's own `AUTHORISED` invoice for the expected amount; a voided/deleted/
  draft invoice is ignored (so it never blocks a legitimate re-issue), a
  different-contact match is never adopted, and a wrong-amount or >1-match case
  surfaces a visible `PROVIDER_MISMATCH`/`DUPLICATE_REFERENCE` conflict for
  human reconciliation rather than a silent adopt-first. The enqueue-time guard
  and its amount/category-keyed correlation dedupe are not sufficient — a
  re-enqueue carrying a different amount override or a reclassified category
  produces a fresh key. Concurrent double-minting is prevented by a member-scoped
  Xero mint idempotency key (concurrent mints converge on one invoice, the same
  provider-side convergence pattern as the contact path, F7/#1355) rather than a
  DB lock held across the provider call; the DB-level backstop is the raw partial
  unique index `XeroObjectLink_entrance_fee_active_unique` guaranteeing at most
  one ACTIVE entrance-fee link per member. Residual: a same-day re-issue after a
  void can be returned the voided invoice by the idempotency key within Xero's
  key-retention window — acceptable for a one-time charge. Second residual: the
  member-scoped mint key makes convergence Xero's responsibility, so if Xero ever
  failed to collapse a concurrent duplicate, a second invoice could mint and its
  link upsert would then fail on the partial unique index — leaving an orphan
  invoice in Xero (no local double-link, so no local double-charge) that needs
  operator reconciliation.
