# Domain Invariants

These are non-negotiable business and technical rules for AlpineClubBookingsNZ.
Future reviews and issues should cite this file when proposing changes.

## Public authoritative content

- Fee/policy PageContent blocks are explicitly enabled and server-rendered; a
  token alone publishes nothing.
- Public fees use current effective-dated schedules. Joining fees resolve from
  the `JoiningFee` schedule (membership type × age tier) only — no legacy Xero
  mapping-amount fallback.
- Named lodge tokens resolve exactly one active lodge or no data, never the
  default lodge. Public view models exclude ids, provider codes, and secrets.

## Money

- Store and calculate money as integer cents.
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
- Do not introduce floating point money arithmetic.
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
  - **A cap check that excludes a booking must exclude it from
    `currentRedemptions` too.** The counter includes the rows the excluded
    booking holds right now, and unlike every other cap it cannot be filtered by
    a `where`. So `excludeBookingId` is paired with an explicit raw count of
    that booking's own allocation rows, subtracted before the total-redemptions
    cap is applied. Omitting it makes a booking holding a code's last slot fail
    its OWN reprice, silently drop the discount, and bill the member the
    discount back for a date change.
  - **TRAP: the in-memory `PromoDiscountResult.allocations` is NOT
    benefit-filtered on the assigned-member path.** `policies/pricing.ts`
    deliberately emits a zero entry for a `SET_PRICE` guest whose rate already
    equals the fixed price (`includeWhenZero`), and
    `calculatePromoDiscountForGuestRates` returns the assigned-member result
    before `normalizeAllocations` runs. The filter is applied at WRITE time
    instead, inside `redeemPromoCode` / `replacePromoRedemptionAllocations`.
    Anything that reads that in-memory list as "who benefited" must apply
    `isBeneficialPromoAllocation` itself.
  - **A `SET_PRICE` application whose per-guest adjustments net to exactly zero
    counts as no use** (deliberate; #2299). In `SET_PRICE` mode every night is
    re-priced, so a fixed price of $30 against nights of $50 and $10 nets to
    zero, as does one member owning two guest rows that cancel. The member's
    total is byte-identical with and without the code, so under the "any price
    effect" rule there is no effect, and it consumes nothing. The accepted
    consequence is that such a stay can carry the code indefinitely — which
    costs nothing, because it gives nothing.
- Refunds, credits, discounts, Stripe amounts, Xero invoice amounts, and
  membership fees must reconcile back to cent-based ledger records.
- Admin adjustments need audit, approval, and a visible business reason.
- A confirmed `MembershipSubscriptionCharge` is an immutable snapshot: fee and
  membership type, billing basis, annual/charged cents, proration, dates/months,
  covered subscriptions, family, recipient name/email, due days, frozen
  `subscriptionIncome` account/item identifiers, reference, **and its frozen
  `MembershipSubscriptionChargeComponent` rows** (one per Xero invoice line —
  label, description, annual/charged cents, prorated flag, account/item, order)
  never change. Only delivery/status/Xero metadata may advance.
- An annual fee has ≥1 `MembershipAnnualFeeComponent` at all times unless it is
  `NO_INVOICE` (zero total, no components); the components' `amountCents` sum
  exactly to the fee total (validated in the one transaction that writes the
  fee), a charge's `chargedAmountCents` is Σ its components, and the invoice
  carries one line per component. A single-component fee is byte-identical to the
  pre-component single-line behaviour; a multi-component prorated fee may diverge
  by up to (n−1) cents by design because the charge total is authoritative as Σ
  components.
- Every `MemberSubscription` can be covered by at most one charge. A
  season-scoped advisory lock plus the unique coverage constraint makes annual
  confirmation, approval replay, and concurrent operators idempotent.
- `PER_MEMBER` bills that member. `PER_FAMILY` requires one explicit active,
  unarchived recipient in the exact family. `NO_INVOICE` is an explicit
  zero-cent outcome, not missing configuration.
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
- A member in more than one family is billed for a `PER_FAMILY` fee only via
  their admin-chosen `Member.billingFamilyGroupId` (consulted solely in
  `BILL_FAMILY_VIA_BILLING_MEMBER` mode, through the same recipient checks as an
  unambiguous family): valid selection bills that family, a stale selection
  raises `INVALID_BILLING_FAMILY_SELECTION`, and an unset selection raises
  `AMBIGUOUS_FAMILY`. The selection is NULLed in the same transaction as any
  removal of the member from that family across all six removal paths, so a stale
  pointer can only ever degrade to that visible exception — never silent
  misbilling.
- One family/membership-type/membership-year tuple can have at most one durable
  charge. A later family member produces a visible exception; neither coverage
  mutation nor a second invoice is allowed.
- Membership approval remains authoritative when billing setup is incomplete:
  billing records a visible post-approval exception/warning and never rolls the
  member transaction back.
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
- Xero invoice identity is persisted before Xero email. Email retries reuse it.
  Existing invoices are adopted only on an exact `AUTHORISED` snapshot match;
  conflicts are visible and never trigger a silent provider rewrite. Xero
  delivery resolves the snapshotted recipient member's current contact/email;
  frozen name/email remain audit evidence rather than a stale delivery target.
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

## Booking Dates And Capacity

### The stay boundary: midday NZ to midday NZ (normative)

This subsection is the normative stay-boundary invariant (epic #2629). It is
stated once, here; write any new stay-boundary sentence elsewhere as a
reference to this subsection rather than a restatement, fold restatements you
find into references as their files are touched, and measure every future
change in this area against it. All
times in this invariant are New Zealand time (Pacific/Auckland). UTC is never
a semantic boundary in this subsection; it appears only as the storage
encoding described at the end (and once as a code-level aside on weekday
derivation).

- **Lodge night.** Night N is the period from midday NZ on date N to midday NZ
  on date N+1. The boundary is fixed at midday NZ by definition (D-M3): there
  is no configurable boundary, and no time-of-day value participates in the
  stay boundary or in presence. (The kiosk arrive/depart stamps
  `BookingGuest.arrivedAt` / `departedAt` are action audit timestamps, never
  presence inputs.)
- **Stay.** A stay is the half-open date range `[checkIn, checkOut)` expanded
  to nights — the motel rule: a guest is in the lodge from midday NZ on their
  check-in date to midday NZ on their check-out date. The check-out date is a
  departure morning, never an occupied night, which is why back-to-back
  handovers and same-day turnover on one bed need no special case. When
  explicit `BookingGuestNight` rows exist they are the authoritative night set
  and the contiguous envelope is ignored.
- **Presence on an operational day D** — the answer to every human-facing "who
  is here today" question (rosters, kiosk, manifests): morning half
  (midnight to midday NZ) iff D−1 is one of the guest's nights; evening half
  (midday NZ to midnight) iff D is one of their nights; present iff either
  half holds. Derived labels, never independent data: *arriving* =
  evening-half only; *departing* = morning-half only ("leaves today"). Sparse
  multi-segment stays follow the same rule per segment with no exception
  (D-M4): nights {5, 8} give presence on {5, 6, 8, 9} and absence on the gap
  day 7.
- **Two models, two helper families**, both in
  `src/lib/booking-guest-stay-ranges.ts`. The **night model**
  (`isGuestActiveOnNight` / `getActiveGuestsForNight`) is canonical for
  capacity, availability, pricing, bed allocation, whole-lodge and
  member-night logic — every per-night resource question; under it the
  departure date is never occupied. The **operational-day model** is canonical
  for chore-roster eligibility, the kiosk, print manifests and day statuses —
  every human-facing "who is here today" question. Ownership is strict in both
  directions: an operational-day caller must not reach the night helpers, and
  a capacity caller must not reach the operational-day ones.
  **The operational-day helpers** (#2622) are
  `getGuestOperationalDayPresence` (both halves plus the derived labels),
  `isGuestOperationallyPresentOnDay`, `isGuestArrivingOnDay`,
  `isGuestDepartingOnDay` and `getOperationallyPresentGuestsForDay`. They
  implement the pure rule above, sparse segments included, and take a private
  key-based copy of the night predicate rather than refactoring the frozen
  night helpers. **Status of the code against this rule:** chore-roster
  eligibility is converted. There is one chore-eligibility query,
  `getOperationalRosterGuestsForDate` (`src/lib/roster-eligibility.ts`), read by
  both the admin roster service and the kiosk generate route; roster-confirm
  validation and both chore-cleanup paths read the same helpers (D-M6), and the
  arriving/departing labels are derived from the night set on the operational
  date. **The sparse fix applies per converted surface, not globally.**
  `getLodgeVisibleGuestsForDate` survives as a deprecated wrapper carrying the
  LEGACY lodge-date meaning unchanged: `includeDepartureDate: false` is the
  night model, and `includeDepartureDate: true` admits the guest's own nights
  plus the single morning after their FINAL listed night (or, for an
  envelope-only guest, the closed range `[stayStart, stayEnd]`). It is
  deliberately NOT `getOperationallyPresentGuestsForDay`: the lobby wall
  (fenced, below) derives its night counts by subtracting only the envelope end
  from that list, so per-segment presence there would count a sparse stay's gap
  morning as a phantom night and put guest names on a public screen. A source
  contract freezes both the legacy semantics and the wrapper's remaining caller
  list. #2631 converted the two kiosk read surfaces that used to call it
  (`api/lodge/week` and `api/lodge/guests/[date]`) onto the named operational-day
  helpers, so `lodge-display-state` — the lobby wall — is now its **only**
  caller, and a PERMANENT one rather than a pending migration: nobody is to
  "finish the job" by pointing it at the operational day, for the privacy reason
  above (issue #58). The same statement lives beside the code in
  `booking-guest-stay-ranges.ts`. No surface may grow a second call.
- **The lobby wall is deliberately mixed and stays fenced** (issue #58): its
  guest-name privacy gate (sole-occupancy detection) uses NIGHT counts while
  its visibility rows are checkout-inclusive. It keeps its own code path
  (`src/lib/lodge-display-state.ts`) and is never unified onto either helper
  family — widening its night counts would put guest names on an
  unauthenticated public screen during back-to-back handovers.
- **A member departing lodge A and arriving at lodge B on the same date is
  legal**: the two presence windows abut at midday, so the member-night
  conflict rule (below) is satisfied by construction.
- **Zero-night bookings** (`checkIn == checkOut`) expand to zero nights and
  are present on no day. The shape is deliberately unrepresentable — every
  booking-creating route refuses it — and must stay that way rather than
  becoming an accidental day-visit feature.
- **Deliberately outside this invariant:**
  - `daysUntilDate` (`src/lib/policies/cancellation.ts:140-158`) and the
    refund tiers it feeds (`getRefundTier` and the refund calculators,
    `src/lib/policies/cancellation.ts:13-90`) measure time *until* a stay
    against an NZ-local-midnight countdown boundary, not nights within it.
    They are not governed by the midday rule; any change there is a money
    change requiring its own issue, its own owner decision, and per-tier
    evidence — never a side effect of work in this area.
  - The completion cron / unpaid-finished-stays pair keeps its dual check-out
    boundary (#2029, below). Both operate on NZ date-only lodge nights and
    neither is a presence definition; their `<` / `<=` split brackets the
    check-out day deliberately and must not be "aligned" onto one boundary.
  - The custodian bed hold uses deliberate inclusive day semantics (its own
    section below): an assignment's `endDate` is a covered day, not a
    departure morning.
  - The kiosk depart lookup matches only the exact departure date — a status
    action window, not a presence rule.
  - The group-join window closes once the stay's check-out date is reached
    (`hasGroupStayFullyEnded`, `src/lib/group-booking.ts:469-476`) — an
    action window on dates, settled by its own owner decision, not a presence
    rule.
  - Minimum-stay derives its weekday as the NZ weekday: `night.getUTCDay()`
    (`src/lib/policies/minimum-stay.ts:56`) is correct precisely because
    nights encode NZ calendar dates (see the storage note). Any future true
    time-of-day instant in this area would silently shift that weekday for
    hosts behind UTC.
- **Storage encoding, not semantics.** A stored lodge night is an NZ calendar
  date. The `@db.Date` columns pin that date to UTC midnight internally — an
  instant that renders as club midday in NZST (1pm during NZ daylight saving),
  either way the same NZ calendar day in every zone, so a CI runner in UTC and
  a club in NZ agree on the date ([`docs/TESTING.md`](TESTING.md) pins the
  frozen test clock to an NZST instance of exactly this instant as evidence).
  The UTC-midnight pinning is an internal encoding of the NZ date and nothing
  more: it is NOT the midday boundary instant, NZ time is the semantic truth,
  and no rule may be derived from the UTC reading of these values.

### Date handling rules

- Lodge bookings use New Zealand date-only nights, not arbitrary timestamps,
  unless a feature explicitly requires time-of-day semantics (the stay-boundary
  invariant above governs what those nights mean).
- `BookingGuest.stayStart` and `BookingGuest.stayEnd` represent each guest's
  date-only occupancy inside the booking envelope.
- `@db.Date` columns (e.g. `Booking.checkIn`/`checkOut`,
  `BookingGuest.stayStart`/`stayEnd`, `HutLeaderAssignment.endDate`) store an NZ
  calendar date, encoded internally at UTC midnight (the storage-encoding note
  in the invariant above). Compare them only against date-only values
  (`getTodayDateOnly()` / `normalizeDateOnlyForTimeZone()` from
  `src/lib/date-only.ts`), never a raw `new Date()` or a local-midnight
  (`setHours(0,0,0,0)`) instant: under the `TZ=Pacific/Auckland` server pin the
  latter resolves to `(D-1)T12:00Z` and shifts the boundary by a day for the
  first ~13h of each NZ day (F8/F32, #1888).
- **Client-side, a selected lodge night is an NZ date-only `yyyy-MM-dd` string
  carried end-to-end.** The booking calendar (`src/components/booking-calendar.tsx`),
  the member booking wizard, and the admin "book on behalf" kiosk
  (`src/app/(admin)/admin/book/page.tsx`) never hold a lodge night as a
  local-midnight `new Date(year, month, day)` (#2474). That construction is
  midnight in the BROWSER's zone, so the moment such a value reached an
  instant-based API (a club-pinned `Intl` formatter, a UTC serialiser, or
  DST-crossing day arithmetic) it named the day the browser sat on — off by one
  for a booker far enough from New Zealand. The value submitted, the club-pinned
  label displayed, the night count, and the hold deadline are all derived from
  the string via `parseDateOnly` / `addDaysDateOnly` / `countNightsDateOnly`,
  which encode the NZ calendar day internally at UTC midnight (the
  storage-encoding note in the stay-boundary invariant above: the instant that
  renders as club midday, the same calendar day in every zone).
  `formatCalendarDayOnly(year, monthIndex, day)` is the
  canonical encoder; the #2264 `localCalendarDayToDateOnly` bridge, which patched
  only the display half of this hazard while the fragile encoding lived on, is
  gone. `src/lib/__tests__/booking-calendar-timezone.test.tsx` pins the
  lodge-night identity across browsers behind, at, and ahead of NZ, on an NZ
  DST-transition night. (This is the CLIENT representation; server-side capacity
  date arithmetic keeps its own `@db.Date`/date-only helpers, above.)
- **Rendering** a date or a time is a separate invariant from storing or
  comparing one, and has its own single seam: `src/lib/nzst-date.ts`. Its six
  helpers — `formatNZDate` ("16 Apr 2026"), `formatNZDateTime`
  ("16 Apr 2026, 11:30 am"), `formatNZLongDate` ("16 April 2026"),
  `formatNZTime` ("11:30 am"), `formatNZMonthYear` ("April 2026") and
  `formatNZWeekdayDate` ("Thu, 16 Apr 2026") — each pin BOTH `APP_LOCALE` and
  `APP_TIME_ZONE`. A bare `toLocaleDateString()` / `toLocaleTimeString()` /
  `toLocaleString()` renders in the VIEWER's zone and locale, so an
  administrator abroad read a different lodge night than the one stored, and a
  lobby-display television reported its own local time (#2256, #2264). An
  `eslint` `no-restricted-syntax` rule over `src/**` now blocks all three calls;
  the documented exclusions are written out in `eslint.config.mjs`. Three files
  format NUMBERS with `Number.prototype.toLocaleString` (thousands separators)
  and are listed there with a narrowed rule that lifts only `toLocaleString`,
  keeping both date restrictions. The rule's selector is syntactic, so computed
  access (`d["toLocaleDateString"]()`) and detached-method aliasing escape it —
  an accepted limitation, not a gap anyone writes by accident. A screen whose
  format is legitimately none of the six — weekday-bearing boards, compact
  grids, the seconds-bearing audit log, an `en-CA` ISO extractor — declares a
  module-level
  `new Intl.DateTimeFormat(APP_LOCALE, { timeZone: APP_TIME_ZONE, … })` constant
  instead. That, not an `eslint-disable`, is the escape hatch, and there are no
  disables in the tree.
- `formatNZLongDate` is reserved for the MEMBER-FACING surfaces the owner asked
  to keep the long spelled-out month on (#2264): booking messages and the emails
  built from them, the lodge and hut-leader instruction "last updated" stamps,
  and the generated report cover. Admin and internal screens use the medium
  `formatNZDate`. `src/lib/__tests__/member-facing-long-dates.test.ts` pins the
  four call sites so a later "tidy every date onto formatNZDate" pass fails
  loudly rather than silently shortening what a member reads.
- Two check-out boundaries coexist by design (#2029; named as a deliberate
  non-presence exception by the stay-boundary invariant above). The completion
  cron flips
  PAID → COMPLETED only once `checkOut < todayNZ` — the entire NZ check-out day
  stays PAID and self-editable/extendable — whereas the admin "finished stay"
  attention queues (`unpaid-finished-stays.ts`) intentionally use
  `checkOut <= todayNZ`. The difference is deliberate and the two operate over
  DISJOINT status sets: the queues surface still-unsettled stays
  (`PAYMENT_PENDING`, or a settled status carrying an unpaid additional delta) on
  the check-out day itself for payment chasing, while completion is a next-day
  transition of PAID bookings. A booking is therefore never both counted as a
  finished-stay-needing-payment AND still PAID-completable under the same rule.
- Base Reports uses lodge nights, never booking creation time (#2368). Its
  selected From/To window is inclusive and overlaps the half-open booking stay
  `[checkIn, checkOut)` (the stay-boundary invariant above). Every
  non-occupancy figure uses one explicit positive
  cohort: `PENDING`, `PAYMENT_PENDING`, `CONFIRMED`, `PAID`,
  `AWAITING_REVIEW`, and `COMPLETED`, with the same lodge/deleted scope. Count
  bookings once per overlapped bucket. Count guest rows once when their own
  half-open `[stayStart, stayEnd)` envelope overlaps the selected range; sparse
  explicit guest-night rows do not override that envelope for this metric.
  Allocate all integer cents of `finalPriceCents` across the
  booking's complete stay before slicing the report range (100/3 = 34/33/33).
  This is **Booked revenue**, not cash. Net collected cash stays payment-derived
  (`Payment.amountCents` less refunds, with a captured addition already inside
  that amount; #2408), and outstanding additions remain separate (#2350). The
  #2408 guard is binding here too: a collected-addition claim without captured
  `ADDITIONAL` transaction evidence must not change cash arithmetic or leak
  transaction rows, but must log and expose an aggregate possible-understatement
  warning in the page, CSV, and PDF. All Reports money presentation preserves
  exact integer cents.
  Occupancy is the deliberate exception within the page: it stays limited to
  PAID/COMPLETED and continues to exclude custodian occupancy (#2286).
### Capacity and allocation

- Capacity is per lodge. A booking belongs to exactly one lodge
  (`Booking.lodgeId`); capacity is "beds available on date D at lodge L", and
  no code path may sum beds across lodges into a single club-wide number. Two
  bookings at different lodges never contend for the same beds. The one
  deliberate, documented exception is a reporting-layer occupancy denominator
  that intentionally aggregates active lodges; any such aggregate must be
  recorded in `docs/multi-lodge/lodge-scoping-contract.md` and labelled as
  cross-lodge in the surface that shows it. A single-lodge club is simply a
  club whose `Lodge` table has one active row — the same per-lodge rules apply
  with the lodge dimension hidden by the ADR-002 presentation rule.
- `lodgeId` is **`NOT NULL`** on the six entity tables (`LodgeRoom`, `Locker`,
  `Season`, `Booking`, `ChoreTemplate`, `HutLeaderAssignment`), enforced
  **without an outage** via a `default_lodge_id()` column default: an old
  (pre-lodge) colour's insert omits `lodgeId` and auto-fills the default lodge,
  so no null is written even mid-blue/green-cutover. `lodgeNullTolerantScope`
  is now a strict `{ lodgeId }`. Policy/settings tables keep a **nullable**
  `lodgeId` (null = club-wide default), scoped via `resolvePolicyRowsForLodge`.
  See `docs/multi-lodge/contract-release.md`.
- Each lodge's capacity resolves through `getLodgeCapacityStatus` (full
  scenario table in `docs/CAPACITY_MODEL.md`). When the Bed Allocation module
  is on with ≥1 active bed, the physical bed inventory is the placement set and
  the per-lodge `LodgeSettings.capacity` acts as a **maximum sleeping capacity
  ceiling**: the effective capacity is the lower of the two, so a lodge may
  have more beds installed than it is allowed to sleep (`capped_beds`). No
  capacity set — or one at/above the bed count — leaves the bed count as the
  figure (`configured_beds`); only an explicit capacity caps it, never an
  unconfigured fallback. When the module is off, or on with no active beds, the
  capacity is the per-lodge `LodgeSettings.capacity`; if that is unset the lodge
  resolves to capacity 0 (`unconfigured_lodge`). Since #1982 the DB is the sole
  runtime source — `club.json` is no longer a runtime capacity fallback; the
  default lodge's `LodgeSettings.capacity` is backfilled from the config bed
  total by the boot-time self-heal, and any lodge (default or additional) with
  neither configured beds nor a capacity is unbookable rather than overbookable
  until it is set up (the setup-readiness Club Config check warns on a
  default lodge left at 0).
- A booking consumes beds when it is capacity-holding. The implementation
  source of truth is `capacityHoldingBookingFilter()` in
  `src/lib/booking-status.ts`, which every occupancy/availability query uses
  (composed under `AND` with the per-lodge scope, since both are `OR`
  fragments). A booking holds capacity when either (a) its status is in
  `CAPACITY_HOLDING_BOOKING_STATUSES` (PAID, COMPLETED, CONFIRMED,
  AWAITING_REVIEW), or (b) it is PENDING **and** is the converted booking of a
  `BookingRequest` — i.e. an accepted-but-unpaid quote or a directly-approved
  request (issue #1254). Rule (b) refines #737: generic PENDING bookings
  (split-booking non-member children #738, member "only-if-my-guests-come"
  holds) have no `originBookingRequest` and stay non-holding and bumpable, but a
  quote-derived accepted booking keeps its beds until it is paid, expires, or is
  cancelled. Because #737's member-priority bumping only ever touched
  non-holding PENDING rows, an accepted-but-unpaid quote can no longer be bumped
  by a later member booking — this is the intended capacity-priority change.
- Split-booking guest portion always settles or is notified, never silently
  stranded (#1967). A split non-member child (#738) is auto-charged at its hold
  deadline to the member's card inherited from the parent payment. When the
  parent is genuinely settled without a saved card (Internet Banking, or already
  CONFIRMED/PAID/COMPLETED), `cron-confirm-pending.ts` instead mints a tokenised
  `/pay/<token>` PaymentLink (the #707 machinery) and emails it to the member —
  once per mint, deduped on the absence of an active (unexpired) PaymentLink for
  the child (`mintSplitGuestPaymentLinkIfAbsent`) — and fires an admin alert on
  **every** hold-extension run until the child settles. If the parent itself is
  unpaid (abandoned card), no link is minted or emailed (the guest portion never
  settles ahead of the member's own place) and the alert fires with
  parent-unpaid wording instead. Only genuine split children qualify: a #796
  group joiner also carries `parentBookingId` but always has a
  `GroupBookingJoin` row, which excludes it everywhere (cron, page, send route).
  At most one live token exists per booking (every mint revokes-then-creates
  under the per-lodge advisory lock; undelivered emails revoke their minted link
  by id so the next run re-mints), and the tokenised link and the saved-card
  auto-charge never both settle durably (the charge claim revokes links; the
  /pay intent path re-reads the link under the same lock; the on-demand path
  refuses when a saved card exists — though a link PaymentIntent minted just
  before the claim can still transiently coexist with the charge in flight).
  That residual in-flight window is narrowed and backstopped (#1992): a link
  PaymentIntent minted BEFORE the claim (client secret already
  in the member's browser) is best-effort cancelled on Stripe by the charge
  claim before it charges the saved card, and if the member's confirm still
  wins that race, `markBookingPaymentSucceeded` auto-refunds whichever DISTINCT
  capture arrives second on the already-PAID booking — durably
  (enqueue-then-execute, exactly the duplicate's captured amount, pinned to the
  duplicate's own transaction) with a loud admin alert — while a SAME-intent
  replay keeps its byte-identical `already_paid` outcome and at most one side
  of the pair can ever be refunded (adjudication under `lock(1)`). A capture
  whose money is already owned by the superseded-intent recovery machinery (a
  live `CANCEL_PAYMENT_INTENT` / `REFUND_SUPERSEDED_PAYMENT` operation, e.g.
  the succeeded-superseded-intent handoff) is never mistaken for the
  settlement side of such a pair: the real settlement's replay stays
  `already_paid` and that machinery's cron refunds the superseded capture. Money still
  stays integer cents and no beds are held for the child until it is actually
  paid. The same machinery backs the
  on-demand `POST /api/bookings/[id]/send-guest-payment-link` re-send
  affordance. A child can end PAID while its parent is unpaid or later
  cancelled — the parent-cancel sweep only cancels still-PENDING children — and
  there is deliberately no auto-cancel past check-in (owner policy decision).
- Bed-allocation eligibility (`BED_ALLOCATABLE_BOOKING_STATUSES`) is a status-
  only superset of capacity-holding; the `capacity-holding ⊆ bed-allocatable`
  invariant still holds because rule (b) only extends holding to PENDING, which
  is already bed-allocatable (locked by
  `booking-status-bed-allocation-ownership.test.ts`, #813).
- Auto-allocated stays are **room-continuous per booking** (issue #1677): the
  planner (`buildFirstFitBedAllocationPlan`) places a booking's whole party in
  ONE room for the ENTIRE stay — in free space first, and for capacity-holding
  bookings by displacing whole provisional stays (#1387 preserved) — falling
  back to the legacy per-night split only when no single room can host the
  stay; fallback bookings are reported in
  `BedAllocationPlan.roomContinuityFallbackBookingIds`. Displacement relocates
  or unallocates a provisional booking's ENTIRE visible stay (one destination
  room) and never night-splits it — whole-stay room claims (Phase 2) evict
  newest bookings first, while the per-night fallback (Phase 3) selects
  victims in room/bed sort order; an
  admin-approved allocation (#776 lock) on ANY night pins the whole booking
  against displacement, as does a stay extending beyond the reconcile load
  envelope. Existing allocation rows are never rewritten by planning — only
  provisional displacement moves rows — and re-planning a fully-allocated
  state is a no-op.
- **Allocation preferences are per lodge and advisory, never safety
  overrides (#2593):** the board and lifecycle resolve the same strict saved
  order for the booking's lodge. The canonical default is booking cohesion →
  stay continuity → requested room → direct-family cohesion; an explicitly
  saved empty list is valid deterministic neutral behavior. Every hard
  invariant (maximum feasible placement count within a candidate, school
  separation, adult coverage, cross-booking age mix, lodge isolation,
  custodian/exclusive holds, approved-row pins, and displacement safety) is
  scored or enforced ahead of those preferences. Preference values then
  compare the bounded feasible candidates lexicographically from top to bottom;
  disabling a value removes only that comparison. Family cohesion means guests
  sharing at least one family-group id **directly**; connected components,
  direct subsets, capacity-aware high-affinity room packing, and
  maximum-cardinality direct-edge pairings provide bounded candidates but do
  not turn transitive acquaintances into a scored family pair. The planner
  executes at most 24 matching-layout candidates per booking, alongside its
  whole-room, legacy, and displacement trials. This is a deterministic bounded
  heuristic, not a claim of global optimality across all bookings. A settings
  save never moves an existing row: it affects later board suggestions and
  later lifecycle reconciliation only. The board's visible suggestions are a
  preview, never a persistence payload: Run Auto Allocation takes global then
  the selected lodge lock, refuses an unknown or inactive selected lodge, and
  rebuilds the complete scoped plan on that transaction client before writing,
  so a bed/room deactivate, retype, lodge
  mismatch, allocation/approval change, or hard-predicate change committed
  after preview cannot receive a stale AUTO row.
- **Cross-booking age mix (#1768, owner-set):** a room-night containing minors
  from booking X must never also contain an adult from a DIFFERENT booking —
  planner-enforced in both placement directions on every path (whole-stay,
  per-night split, adult spread, displacement eviction/relocation), including
  against pre-existing `occupiedBedNights`; an occupant row with no booking
  attribution conservatively blocks minors (counted as an unknown adult) but
  not adults. Same-booking mixing is unrestricted, and minors-only ROOMS are
  allowed: the booking-level rule stays night-scoped (Phase 0
  `NO_BOOKING_ADULT` — a minor needs a same-booking adult on-site that night,
  not in the same room), so a large group's minors overflow into rooms of
  their own instead of being capped at one room per adult. SCHOOL-request
  bookings (`isSchoolGroup`, from the origin/held `BookingRequest.type`)
  prefer adults together and students separate. The planner never rewrites
  persisted violations (manual/legacy rows) — the board surfaces them as
  `MINOR_ADULT_MIX` warnings; the manual board itself is warned, not blocked,
  **by design** (owner decision, 2026-07-11, closing the deferral from
  #1768/PR #1775): the invariant binds every automated placement path, while
  the manual board deliberately stays an admin-judgment escape hatch with the
  warning as its guard. Do not add a hard block without a fresh owner
  decision.
- **Double-bed shared occupancy (#1701):** a `DOUBLE` bed may hold two occupants
  on a night — one primary and one second occupant — when they are declared
  partners: two `ADULT` members holding a **CONFIRMED** `MemberPartnerLink`
  (#1742), the single-source `mayShareDoubleBed()` rule in
  `double-bed-sharing.ts`. A PENDING link grants nothing; both members must
  also still be ACTIVE adults at placement time. (#1744 swapped this signal in
  for the interim same-`FamilyGroup` rule, which wrongly permitted e.g. a
  parent and an adult child.) The precondition is enforced at placement time
  AND swept when it later breaks (#1756): **no future `isSecondOccupant`
  allocation may outlive its partner link or the active-adult precondition**.
  Dissolving a CONFIRMED link (`removeOwnPartnerLink` /
  `adminRemovePartnerLink`), deactivating a member (member edit, bulk update,
  or account-deletion anonymisation), or correcting an ADULT to a minor/N-A
  tier acquires `acquireFuturePartnerSharedAllocationLocks` and runs
  `sweepFuturePartnerSharedAllocationsWithLocksHeld`
  (`bed-allocation-lifecycle.ts`) in the SAME transaction as the breaking
  event: the pair's future (tonight onwards, NZ date-only) second-occupant
  rows are deleted back to the awaiting-allocation queue — never the primary,
  so the sweep cannot orphan anyone and needs no promotion pass — with a
  `BED_ALLOCATION_PARTNER_SHARE_SWEPT` audit row against BOTH bookings and a
  post-commit admin alert (`admin-partner-share-swept`, "Booking review
  required" preference). A dissolve sweeps only bed-nights whose two occupants
  are exactly the dissolved pair; deactivation/tier change sweeps any future
  shared bed-night involving the member on either side. Past lodge nights are
  history and stay untouched, and the sweep is idempotent (a second run finds
  nothing). Membership cancellation and archive need no sweep call: approval
  is blocked while ANY future booking or member guest appearance exists, so a
  cancellable member cannot occupy a future shared bed-night. Only an admin adds the second occupant on the board,
  and only onto a bed whose primary already **holds capacity** — so displacement
  can never move the primary out from under the partner. Auto-allocation never
  creates a second occupant; every other bed type stays exactly one occupant per
  night. DB-enforced without CHECK constraints:
  `@@unique([bedId, stayDate, isSecondOccupant])` caps a bed-night at ≤2 rows and
  a raw-SQL partial unique index (`WHERE "bedType" <> 'DOUBLE'`, recorded in
  `prisma/partial-unique-indexes.tsv`) caps every non-DOUBLE bed at exactly one;
  `BedAllocation.bedType` is a denormalized copy the partial index reads (a
  partial index cannot join to `LodgeBed`). The **base** capacity figure is
  unchanged — a shared double is still ONE bed of `activeBedCount` and each
  occupant is a full person-night (pricing/settlement untouched) — but each
  active DOUBLE adds one **partner-shared slot** of admission headroom above
  it (#1745): reserved (only `checkCapacityForPartnerSharedAdmission` on the
  admin-initiated partner flow may use it — every public/member/system path
  reads the unchanged base `getLodgeCapacity`), bounded (≤ active DOUBLE
  count per night, with the sharer's partner required to hold an ordinary
  base-backed place — a sharer can never anchor another sharer — so a
  feasible pairing always exists, modulo the documented #1668 forced-overbook
  residual), and capped by an explicit `LodgeSettings.capacity`, which limits
  *people*, so a `capped_beds` lodge gets no headroom (see
  docs/CAPACITY_MODEL.md, "Partner-shared double-bed headroom"). Initiation
  is admin-only (#1746): the `partnerSharedGuests` flags on the booking
  modify routes are rejected for non-admin actors at BOTH route and service,
  the edit panel's quick-add candidates are server-computed
  (`listBookingPartnerSharingCandidates`), and the public wizard carries no
  shared-slot affordance. A DOUBLE
  holding a second occupant
  cannot be retyped to a non-double until that occupant is removed. Whenever a
  shared double loses its primary — a reviewed removal (#2594), a board move of
  the primary onto another bed, or a cross-booking cancellation / reconcile prune
  (#1750) — the surviving partner is **auto-promoted** to primary on the vacated
  bed-night atomically with the removal on transactional paths. Single-row paths
  write one `BED_ALLOCATION_PARTNER_PROMOTED` audit per promotion because the
  partner may belong to a different booking (sharing eligibility is
  member-level). Two bulk paths batch that audit: **range assignment** (#2251),
  which can vacate up to 366
  bed-nights, and **reviewed removal** (#2594), which can span a booking or the
  board's 31-night lodge window. Each records **one batched
  `BED_ALLOCATION_PARTNERS_PROMOTED`** entry instead, targeted at the booking
  anchoring the operation when one exists and listing each promotion
  (`{allocationId, bookingId, bookingGuestId, bedId, stayDate}`) up to
  its 50-identity bound (the audit sanitiser's array limit),
  with the exact `promotedCount` and a `promotionsTruncated` flag alongside — so
  the promoted partner's own booking is still named per promotion, and the audit
  rows written inside that transaction stay bounded independently of the range
  length. Promotion is gated on
  `isSecondOccupant` alone, never the denormalized `bedType` of the removed row or
  the survivor: an AUTO-allocated row on a real DOUBLE carries the SINGLE default,
  so trusting that type would strand the partner it needs to promote. The
  bed-night is
  therefore never left dead-ended behind the orphaned-second-occupant guard in
  `resolveSecondOccupant`, and re-pairing follows the normal sharing rules (in
  particular the promoted primary's booking must hold capacity before a new
  partner may join). The reviewed-removal and board-move services self-wrap
  their read + write + promote in a transaction, while the lifecycle prune
  captures-before / flips-after on the caller's own client. Reconcile is
  usually already inside a transaction, but a few callers
  reconcile on the bare `prisma` singleton (e.g. `cron-complete-bookings`, the
  confirm-pending-guests route); on those a crash between the delete and the flip
  regresses to the pre-#1750 state — a recoverable orphaned second occupant,
  visible on the board and cleared by the next successful reconcile or a manual
  move, never a capacity or double-booking violation.
- Waitlisted and offered bookings do not consume capacity until confirmed.
- A waitlist offer reprices the booking at current season rates,
  membership-type policy, group discount, and promo validity at the moment the
  offer is issued; the offer email states the price the member will pay on
  confirmation. The creation-time price snapshot is not a price lock — an
  identical booking made directly on the offer day pays the same. If repricing
  fails, the offer proceeds at the stored snapshot rather than being blocked.
- A linked `Member` may be present on only one live booking per lodge night
  (night as defined by the stay-boundary invariant above, which also makes a
  same-date lodge-to-lodge move legal by construction). This person-night
  guard is separate from bed capacity: it checks draft,
  pending, confirmed/paid/completed, waitlist, offered, and admin-review
  bookings, but ignores cancelled, bumped, deleted, and expired draft rows.
- A member put on somebody ELSE's booking may take their own place off it, and
  only their own place. The rule is one shared server-side predicate
  (`evaluateGuestSelfRemoval`, `booking-guest-self-removal.ts`): not the
  booking's owner, the guest row is their own, the booking's status is one of
  the eight self-removable ones, the stay is still in the future (NZ date-only
  check-in strictly after today), and they are not the last guest. The
  authoritative gate is `removeBookingGuestInTransaction`, which imports the
  same status set and additionally refuses a quote-priced booking and a settled
  booking whose refund/credit election only the owner or an admin may make.
  Every surface that offers the action — the booking wizard's night-conflict
  card and the booking detail page's own card (#2250) — drives its visibility
  from that predicate rather than a client-side copy of it, so a member is never
  shown a control the service would refuse; where it says no, the action is
  hidden and the reason is stated instead. The booking detail page also passes
  `isQuotePriced` (one indexed `isQuotePricedBooking` lookup, run only when the
  action would otherwise be offered), so the quote-priced refusal is predicted
  rather than discovered on submit. The settled-booking refund/credit election
  stays server-only by design: predicting it needs the price delta of the
  removal, which is the full repricing pass inside the removal transaction, and
  a cheaper guess ("has a captured payment") would hide the action from members
  the service would allow. That refusal surfaces as the service's own
  plain-English 400, which the card shows verbatim.
- The 409 the person-night guard returns is read by whoever made the request,
  which may be a member adding somebody else as a guest. Its human-readable
  message is therefore composed only from what that requester already supplied —
  the member they tried to book and the nights they chose — plus the next step
  their own `canSelfRemove` / `isOwnBooking` / `isSelfGuest` / `canOpenBooking`
  flags allow. **The payload is scoped to match** (#2250): a conflict row carries
  `bookingId`, `bookingStatus`, `bookingOwnerName`, `bookingCheckIn`,
  `bookingCheckOut` and `guestId` only when the server marked this viewer
  `canOpenBooking` — the booking's own owner, an admin, or the conflicting guest
  themselves. An unentitled row carries nothing but the member the requester
  tried to book, that member's name, the intersection with the nights they chose,
  and the four viewer-aware booleans. The gate lives at the single assembly point
  in `findBookingMemberNightConflicts`, because every route that returns this
  body passes the array straight through; the copy layer
  (`describeBookingMemberNightConflictBooking`) gates independently and fails
  closed, so a row missing the detail says nothing rather than rendering
  `undefined`.
- The same 409 is produced by flows whose reader cannot change the dates (the
  admin booking-request approve / hold / send-quote routes and the booking
  modify routes), so the server-built message is flow-neutral. Only the booking
  wizard — the one surface whose reader is choosing the dates — renders the next
  step with `canChooseDifferentDates`, which is what adds "…or choose different
  dates" (#2250).
- The person-night guard is app-level enforcement by design (#1039 item 3): a
  database unique index cannot express it because liveness is booking-status
  dependent and spans `BookingGuest` to `Booking`, which a Postgres partial
  unique index cannot reference. It is race-free because every transaction that
  **creates or re-dates** a member-linked `BookingGuest`/`BookingGuestNight`
  footprint takes its per-lodge capacity lock before running
  `assertNoBookingMemberNightConflicts`, whose first authoritative action takes
  sorted per-member-night advisory locks across lodges (#1881). A writer that
  also moves booking status or money takes global `lock(1)` before those locks.
  The lodge-before-member ordering and the guard's self-lock are frozen by
  `review-findings-contracts.test.ts`. (`CONCURRENCY_AND_LOCKING.md` maps these
  locks alongside the per-member credit lock and the ordering discipline each
  follows.) Writes that do not change the member-night
  footprint — re-pricing, name-only guest edits, lodge arrive/depart timestamps,
  and anonymization that clears the member link — legitimately skip the guard, as
  does the non-member group-join path (`verifyAndCreateNonMemberJoin`, which
  writes only `memberId: null` guests and takes the lock but is a guard no-op).
  When an admin links a booking-request guest to a real member — or opens a
  request that already carries persisted linked members — the linking UI runs an
  **advisory-only** overlap pre-check (`findLinkedGuestMemberNightConflicts`,
  #1226) so any conflict surfaces before approve/hold. The panel computes it on
  load for pre-existing links and on every link/unlink, applying only the latest
  response per request so a slower earlier check can't overwrite a newer one
  (#1226 follow-up). It is non-authoritative — it never throws, blocks, or takes
  the advisory lock, and it excludes the request's own held booking — the
  transactional `assertNoBookingMemberNightConflicts` guard at approve/hold time
  remains the sole enforcer.
- A member holds at most one group-join roster row per group
  (`GroupBookingJoin` unique on groupBookingId + joinerMemberId, #1039
  item 2). The roster row is written inside the child booking's transaction:
  a duplicate live join aborts the whole transaction, and a row left by a
  cancelled or bumped join is reused on re-join. Non-member join requests
  carry a NULL member id and sit outside the constraint.
- Draft, pending, waitlist, payment-recovery, and review states must have
  expiry, retry, admin visibility, or repair paths.
- Linked provisional-child cancellation is guarded against the hold-resolution
  cron (#1881 residual): after a parent cancel, each candidate takes global
  `lock(1)` then its immutable lodge's per-lodge lock, is re-read, and is
  conditionally claimed only while still `PENDING`. A child the cron already
  confirmed or charged is never overwritten, and a lost claim runs none of the
  cancellation side effects.
- **Exclusive whole-lodge hold (ADR-001, #118):** a night overlapped by a
  capacity-holding booking with `Booking.wholeLodgeHold = true` admits no
  further capacity from any admission path — the night's `availableBeds` is
  hard-blocked at 0, never negative, so it cannot be bypassed by the admin
  over-capacity override (#1668). To non-admins the held lodge presents
  exactly as an ordinary full lodge (decision 6); only admin surfaces are told
  a hold is in effect. Full scenario table in `docs/CAPACITY_MODEL.md`,
  "Exclusive whole-lodge hold — a non-bypassable block".
- **A held booking owns no `BedAllocation` rows (ADR-001 §Bed allocation,
  #2285):** the group implicitly occupies every bed, so both **automatic**
  allocation paths skip it — the admin board excludes it from the
  awaiting-allocation set and the planner, and the lifecycle reconcile prunes
  its rows and never auto-places it (keyed on the flag, not status). Every
  planner additionally re-reads the bookings it is about to write rows for
  immediately before the write, so a hold, cancel or soft delete landing
  between planning and writing cannot be undone by a re-insert. The manual
  board path is guarded separately, at the single allocation-write chokepoint
  added by #2251 (stacked on #2285 and landing with it): every manual path —
  single-night board placement, the bulk multi-night drop and range assignment —
  goes through `assertGuestAndBedForAllocation`, which refuses a held booking, so
  a hand-placed row can no longer be created only to be swept by the next
  reconcile. The exclusive-hold toggle reconciles both directions (set prunes, release
  re-plans), and a school approval granting exclusivity prunes after stamping
  the hold; both record the removed rows in their audit entry so a mistaken
  hold can be undone by hand. Divergence guard:
  `src/lib/__tests__/held-booking-allocation-agreement.test.ts`.
- **A held booking's nights ARE occupied as far as both planners are concerned
  (ADR-001 amendment, #2285, resolved by #2317):** a whole-lodge hold's nights
  are synthesised into both bed-allocation planners as **unattributed,
  non-displaceable** occupancy — every active bed of that lodge, every held
  night — while the hold still owns no `BedAllocation` row anywhere. The rows
  carry a null booking and a null guest (#1768 "unknown occupant" shape,
  exactly like a custodian bed hold), which is what makes them unattributed (no
  name, no booking id, no age tier — a hold can begin life as a public school
  request) and non-displaceable (there is no row for a `MOVE` or `UNALLOCATE`
  to target). A tierless unknown occupant counts as an adult, so the
  cross-booking age-mix guard treats a held lodge's rooms conservatively.
  An officer-kept overlapping booking is therefore never auto-placed onto beds
  the held group is using: those guest-nights surface as `NO_BED_AVAILABLE` in
  the awaiting-allocation list, which is the visible form of a clash the
  officer has already been told about (#119/#177). Being unattributed is a
  property of the bed-NIGHT and not only of the row: a real `BedAllocation` row
  can legitimately share a held bed-night (decision 1 never refuses the
  overlapping booking), and planner occupancy is keyed `bedId:stayDate`, so the
  planner pins every null-booking bed-night as permanently occupied and
  evicting the co-located booking releases that booking's claim and never the
  hold's. **The blocking predicate is the capacity engine's own** —
  `wholeLodgeHold` AND `bookingHoldsCapacity` / `capacityHoldingBookingFilter()`
  over the same lodge, which is `getLodgeHeldNights`'s population — so a planner
  can never report a night as held that the engine would admit into, and a stale
  hold flag on a booking that stopped holding capacity blocks nothing in either
  place. (The one deliberate asymmetry is direction-safe: where the planner
  cannot resolve a lodge for a hold or a room it treats the night as held, which
  refuses a bed the engine would have admitted rather than the reverse. Both
  columns are NOT NULL, so this is a dead branch kept conservative.) Both
  writers re-read the live holds on the client that is about to write, so a hold
  committing between plan and write cannot be written over; every placement
  transaction this code **opens itself** takes the per-lodge advisory lock as
  its first statement, while a reconcile running inside a CALLER's transaction —
  or the lifecycle's common no-displacement path, which opens none — inherits
  that caller's lock discipline and relies on the re-read alone, exactly as the
  custodian exclusion does. **Manual placement is deliberately untouched:**
  ADR-001 decision 1 hands an overlap to the booking officer to resolve by hand,
  and a write-time refusal would remove that path. The officer's view of a hold
  is the board's banner plus the **Overlaps exclusive hold** chip on the
  clashing booking; the bed GRID does not mark held cells, and the banner is
  built from the board's booking load (which needs a guest row overlapping the
  window) rather than from the deliberately-unfiltered blocking query, so a hold
  with no guests entered yet blocks without appearing there. Source:
  `src/lib/exclusive-hold-occupancy.ts`; guards:
  `src/lib/__tests__/exclusive-hold-planner-occupancy.test.ts` and the
  whole-lodge entries in
  `src/lib/__tests__/custodian-write-path-contract.test.ts`.
- **The requested-room lock follows the approved rows, not the hold (#776,
  #2285):** setting an exclusive hold prunes the booking's approved allocations,
  so `isBookingBedAllocationLocked` goes false and the member's requested-room
  editor re-opens; the re-plan after a clear creates unapproved AUTO rows, so it
  stays open until an admin approves again. Intended: with no allocated beds
  there is nothing for the lock to protect.
- **Approving beds is always scoped, and the booking is a first-class scope
  (#2252):** `approveBedAllocations` stamps `approvedAt`/`approvedByMemberId`
  only where `approvedAt: null`, and refuses outright when NONE of its three
  selectors — `allocationIds`, a date `range`, or a `bookingId` — is given, so
  an unselected approval can never stamp every pending row in the database.
  `bookingId` is sufficient ON ITS OWN and only ever narrows when combined with
  the others; it exists because the in-booking panel has no safe alternative
  (`allocationIds` caps at 250 and a long stay can exceed it, and the `from`/`to`
  form approves every pending allocation of every booking in the window). A
  booking-scoped approval audits `BED_ALLOCATION_APPROVED` with
  `targetId` = the booking id, because the booking page's audit deep link
  searches `targetId` and never metadata. The booking selector honours the same
  ADR-003 lodge scope the range selector does, so the approve can never reach
  wider than the lodge-scoped read the officer was shown — an anomalous row of
  the booking in another lodge's room is neither displayed nor confirmed.
- **The requested-room lock is two-way, and nothing pretends otherwise
  (#776, #2252, #2594):** no un-approve action exists and none is invented, but
  two ordinary paths can take a booking's last approved row away and re-open the
  member's editor — a board MOVE re-drafts the row it updates (the upsert's
  update branch clears `approvedAt`/`approvedByMemberId`), and reviewed removal
  deletes it. The removal preview computes `reopenedBookings` from every approved
  row on each affected booking, never only the 31-night page on screen, and the
  shared dialog names that consequence before apply. Member requested-room
  writes take global `lock(1)`, lock and re-read the booking row, then use a
  guarded update whose predicate still says no approved allocation exists; an
  approval or removal that wins first therefore changes the authoritative answer
  rather than being crossed by a stale room-request write.
  The same three paths (single-night/drag placements, `source: "AUTO"`
  suggestions, and move re-drafts) are why draft rows persist under #2251's
  auto-approve, and why a confirmation affordance stays meaningful.
- **Existing allocation moves preserve their lodge nights and commit atomically
  (#2366):** an existing-chip drag selects a destination bed only. The hovered
  column is presentation input, never a target date; the server accepts
  allocation ids and re-reads each persisted `stayDate` under global booking
  `lock(1)` followed by the destination lodge's capacity lock. The shared
  global key makes cancellation's allocation prune and the move mutually
  exclusive, so a move can never resurrect a row after cancellation. A
  first-visible chip proxies for that guest's currently
  visible allocated nights, while a later chip represents only its own night.
  Every selected row keeps its original NZ date. A same-bed normalized move is a
  no-op at both client and service boundaries, with no request from the normal
  client and no audit even if another client calls the route directly.
  Multi-night existing-allocation moves are all-or-nothing: one destination
  conflict, inactive bed/room, lodge mismatch, status/guest-date failure,
  custodian hold or invalid double-bed share rolls back every row. The row
  updates, any second-occupant promotions, and all corresponding audit entries
  live in the same transaction. Each promotion audit identifies both the
  promoted row/guest and the causal moved allocation/guest. This does not
  change bucket-to-board placement,
  whose existing bulk path continues to report and skip individual conflicting
  nights while placing the rest.
- **Destructive allocation removal is preview-bound and never replans
  (#2594):** every UI entry point uses
  `POST`/`PUT /api/admin/bed-allocation/allocations/removal`; the old direct
  `DELETE /api/admin/bed-allocation/allocations/[id]` route is retired. Preview
  needs `bookings:view`, writes nothing, and accepts exactly one of four scopes:
  one anchored allocation, one guest on one booking, one whole booking, or one
  lodge's half-open visible window of at most 31 nights. Guest and booking scope
  include off-screen rows by design; window scope never crosses its lodge or
  visible dates. Category selection is a non-empty subset of three mutually
  exclusive classifications: unapproved `AUTO`, unapproved `MANUAL`, and any
  approved row regardless of source.

  The `v1:<sha256>` preview digest includes canonical scope, sorted categories,
  every matching row's mutable identity, every approved row on the affected
  bookings, and every causal shared-double sibling. Apply needs `bookings:edit`,
  resolves the immutable booking lodge plus the reviewed anchor lodge, then
  takes global `lock(1)` → sorted lodge locks → sorted allocation-row locks
  before an authoritative re-preview. ID- and bed-night-expanded queries use
  sorted 10,000-value chunks under that same transaction, below PostgreSQL's
  bind-parameter ceiling without weakening all-or-nothing rollback. A matching or causal row in any third
  lodge is refused without mutation. If an aggregate booking/person preview's
  opening row disappeared, the refreshed preview re-anchors to the lowest-id
  matching survivor so a subsequent reviewed apply is reachable.
  A missing/moved anchor, changed category membership, new approval, promotion
  change, or any other digest drift returns 409 with a refreshed preview and
  writes nothing. A matching apply deletes the complete reviewed set, promotes
  any stranded shared-double second occupants, and writes one bounded operation
  audit plus one bounded promotion audit in the same transaction. It never calls
  board or lifecycle auto-allocation: no replacement row appears until an admin
  explicitly places it or runs auto-allocation later.
- **A range assignment writes all or nothing, and records itself once (#2251):**
  `assignBedRange` scans, writes and audits inside one transaction. If any
  requested night is blocked, NOTHING is written and the caller receives a
  per-night refusal in one of three categories that are never merged —
  `BED_TAKEN` (a clash; a provisional occupant counts, so nothing is silently
  overwritten), `GUEST_NOT_BOOKED` (a bad request, never a silent skip, and it
  includes a gap night of a non-contiguous stay, #713), and `EXCLUSIVE_HOLD` —
  which here means **the guest's OWN booking** holds the lodge (ADR-001's
  short-circuit, scoped to the held booking's own guests). Another booking's
  overlapping hold is surfaced on the board (`overlapsExclusiveHold`), not
  refused here: no allocation path in the domain hard-blocks on it, and this one
  must not be the exception. A partial result exists only when a human sends the
  explicit `nights` list they were shown — the server writes exactly that set or
  refuses it with a fresh report, never a set it re-derived. Every attempt that
  COMPLETES — applied or refused — produces exactly ONE
  `BED_ALLOCATION_RANGE_SET` audit entry against the booking id, committed in the
  same transaction as the rows; an attempt that THROWS (unknown guest/bed,
  cancelled booking, deactivated bed, over-cap range, lost write race) rolls back
  and records nothing, because nothing happened. That entry records shape, not
  people: night counts and runs per category plus the involved booking ids, with
  the occupying guests' names carried only in the API response to the admin who
  asked. The only other row the transaction may write is the single batched
  `BED_ALLOCATION_PARTNERS_PROMOTED` entry when the move stranded partners on
  shared doubles (see the sharing invariant above), so **both the statement count
  and the audit-row count are fixed whatever the night count**. Proceeding past
  `GUEST_NOT_BOOKED` nights additionally requires an explicit on-screen
  confirmation naming how many nights are not part of the guest's booking (never
  "outside the stay" — a GAP night of a non-contiguous stay is inside the span and
  still refused, #713) and how many
  will be written, so a partial result is never one click from a warning. The
  31-night `MAX_BED_ALLOCATION_RANGE_NIGHTS` bounds
  the board's READ window, not this write: lodge capacity is the active bed
  count and never reads `BedAllocation` rows. Placement paths nevertheless take
  the destination lodge's capacity lock because custodian holds share the bed
  inventory (#2286); existing-allocation moves follow destination-key read →
  lock → authoritative re-read. The separate write bound
  (`MAX_BED_ALLOCATION_ASSIGN_RANGE_NIGHTS`, 366) exists only to keep one
  transaction finite, and is **refused at, never silently truncated to** — as is
  every board window the admin types.

## Payment And Settlement

- **Manual mark-paid provenance for BOOKING payments (cash / off-Xero bank
  transfer), B5 #2262.** A booking's payment can be settled outside both Stripe
  and Xero by an audited finance:edit action, recorded on the existing `Payment`
  row by `manuallyMarkedPaidAt` / `manuallyMarkedPaidByMemberId` /
  `manualPaymentNote` / `manuallyMarkedPaidPreviousStatus`. Deliberately NO new
  `PaymentSource` member: the row settles as an ordinary `INTERNET_BANKING`
  payment, so every two-way branch in the codebase (refund-method coercion,
  refund planning, the reconciler) lands correctly, and the provenance columns
  carry the manual-ness. The provenance predicate everywhere is
  `manuallyMarkedPaidAt IS NOT NULL` **alone** — never conjoined with "carries
  no Xero id", because two stampers outside the cash-settle loop
  (`syncLinkedPaymentInvoiceMetadata` and the zero-cash arm of
  `invoice-paid-effects`) can legitimately stamp a Xero id onto a manual row and
  that must not launder its provenance.
  - It is a SIBLING ENTRY POINT into the one settlement body in
    `payment-reconciliation.ts`, not a second settlement path: it executes the
    same lock ordering, the same post-lock re-read, the same
    `checkCapacityForGuestRanges` with its #1771 persisted-override carve-out,
    the same status-fenced PAID claim, the same bed reconciliation and the same
    durable `MEMBER_PAID` / `NON_MEMBER_CONFIRMED` event. It composes a THIRD
    lock tier (global → per-lodge → MEMBER-CREDIT) and derives the settlement
    amount itself: no client-supplied amount is ever accepted, and the mirror
    `amountCents + creditAppliedCents = finalPriceCents` is asserted explicitly.
  - It NEVER calls Xero and NEVER creates or voids an invoice. Marking paid is
    refused (409) when the payment carries a Xero invoice id, a refund credit
    note, a Xero id on any of its transactions, an active `PRIMARY_INVOICE`
    object link, a completed CREATE-INVOICE outbox operation, **or one still in
    flight**, and when the booking participates in a group settlement
    (`organiserSettled`). Every condition that can be expressed as a WHERE is
    re-asserted inside the fenced `payment.updateMany`, so an invoice minted
    between read and write yields count 0 → 409, never a double-apply.
  - A capacity failure REFUSES and records nothing (owner decision, 28 Jul).
    The Stripe path's cancel-and-refund is not mirrored: no in-system money fact
    exists yet, so refusal leaves zero debt, and the invariant holds identically
    because the same check runs at the same point under the same locks.
  - Every outbound invoice-mint surface is fenced on THREE levels: at the
    `enqueueXeroBookingInvoiceOperation` choke point (which every enqueuer funnels
    through), at settle time (mark-paid refuses while a CREATE-INVOICE operation
    is PENDING/RUNNING/WAITING_PAYMENT), and in the handler
    `createXeroInvoiceForBooking`, which re-reads provenance at execution time and
    abandons an operation queued microseconds before the settle committed. Without
    all three a manual settlement would have a real awaiting-payment invoice raised
    AND EMAILED to the member for money already collected in cash. The
    missing-invoices sweep, the force-sync affordance and the repair classifier
    additionally treat a manual settlement as "no Xero objects expected".
  - RECIPROCAL fence: an inbound Xero PAID landing on a manually settled booking
    raises a counter in the inbound result, an error log, a durable admin-only
    `BookingEvent` (once per payment+invoice) and a cooldown-throttled admin
    alert — never a quiet `alreadyPaid`. It fires across PAID, CANCELLED (or the
    inbound path would mint member credit for cash an OPEN hand-back task
    already owes back) and COMPLETED, and it runs BEFORE the settle loop's
    transaction update so a Xero invoice id is never stamped onto the manual
    settlement's rows.
  - Duplicate-capture visibility: the #1992 distinctness predicate matches ANY
    settled PRIMARY transaction, not only a Stripe one, so a stray capture on a
    cash-settled (or Xero-inbound-settled) booking is auto-refunded instead of
    silently kept.
  - CANCELLATION yields a durable `ManualRefundTask`, created atomically with the
    CANCELLED claim — never a Stripe refund plan, never a Xero credit note, never
    minted member credit, and never a "your refund is on its way to your card"
    email. The refund allocation is written only when the task is COMPLETED, so
    the ledger never claims money was returned before it was; the refund-appeal
    queue refuses to approve a manual-provenance payment. The policy math uses
    the bank-transfer/credit tier (owner decision, 28 Jul), so preview and
    execution agree.
  - REVERSAL (finance:edit) is permitted only while nothing has happened that it
    could not undo: booking PAID, provenance present, no refund, no
    `PaymentRefund` rows, no settled Stripe transaction, no OPEN
    `ManualRefundTask`, and no Xero link or queued mint acquired since. It
    restores `manuallyMarkedPaidPreviousStatus` (a stored `DRAFT` deliberately
    restores as `PAYMENT_PENDING`, because the PAID claim cleared
    `draftExpiresAt` and a restored DRAFT would be an expiry-less draft
    forever), clears the provenance, marks the manual transaction FAILED rather
    than deleting it, clears a restored CONFIRMED internet-banking hold deadline
    (or the expiry cron would auto-cancel the booking minutes later), and
    DELETES every still-PENDING/PROCESSING `CANCEL_PAYMENT_INTENT` /
    `REFUND_SUPERSEDED_PAYMENT` operation on the payment — those operations
    must not outlive the settlement they were minted to protect, or a later
    legitimate capture would be refunded as if superseded. Deletion, not a
    terminal status flip: the webhook-side liveness predicates key on
    `status != SUCCEEDED`, so only a deleted row is invisible to all of them.
    The scope is safe because that set IS the settle's own hygiene: the
    settle's enqueue upserts on the shared cancel idempotency key (adopting any
    pre-existing cancel op), and a member-owed superseded refund can never be
    reached — the handoff that creates one marks its transaction SUCCEEDED
    first, and the reversal refuses on any settled Stripe transaction before
    the disarm. The deleted rows' full content is preserved in the reversal's
    `AuditLog` metadata.
  - An OUTSTANDING upward-modification delta on the booking is never silently
    absorbed or silently left behind (#2397). `additionalAmountCents` /
    `additionalPaymentStatus` were previously written only by the CARD
    additional-payment flow, so a price increase settled in cash still read as
    owing on every surface — including the automatic chase (#2350) — and the
    member would be emailed for money the club already held. The mark-paid
    dialog therefore ASKS (owner decision, 31 Jul 2026) whenever the booking
    carries one, showing the amount before the change, the extra, and the total
    being recorded; and the answer is a REQUIRED, defaultless part of the
    settle's contract. Absence of an answer is the caller's positive claim that
    there was no extra, re-checked under the locks like every other claim: an
    extra that exists without one is a 409, an answer for an extra that does not
    is a 409, and a figure that moved since the dialog rendered is a 409 — the
    same law as `expectedAmountCents`.
    Said covered, the extra is settled through the columns every consumer
    already reads (`additionalPaymentStatus = "SUCCEEDED"`, re-asserted in the
    fenced write) AND as a durable INTERNET_BANKING ADDITIONAL
    `PaymentTransaction` with reason `manual_mark_paid_additional`, because
    `reconcilePaymentAggregates` re-derives those columns from the latest
    ADDITIONAL transaction and a column-only write would be undone by the next
    ledger reconcile. **No money is created:** an upward modification raises
    `Booking.finalPriceCents` by the same delta it records as the extra, and
    this settle collects `finalPriceCents - credit` in one go, so the cash is
    SPLIT (the ADDITIONAL row carries the delta, the PRIMARY row the rest) and
    `Payment.amountCents` is the money the club took, never more. An extra
    LARGER than the whole amount owing cannot be a slice of it (a modification
    change fee is added to the extra but never to `finalPriceCents`) and is
    refused rather than guessed, on BOTH answers.
    Said NOT covered, the extra stays outstanding **and is subtracted from the
    settled figure** (owner decision, 31 Jul 2026): the settlement records
    `finalPriceCents - credit - outstandingAdditionalCents`, so the books show
    what was actually handed over ($100 received, $21 owing) instead of the old
    contradiction ($121 received, $21 owing). The PRIMARY transaction figure is
    identical under both answers — the booking's worth before the change — and
    the answer only decides whether an ADDITIONAL row sits beside it. A "not
    covered" answer whose extra IS the whole amount owing is refused: there is
    nothing left to record, and a $0 settlement must never flip a booking to
    PAID. Downstream this is a strengthening, not a loosening: the cancellation
    refund basis (`paidAmountCents = amountCents - refunded`) and every captured
    figure now follow the cash the club actually holds.
    A "not covered" settle must also leave a WAY TO COLLECT the extra it leaves
    owing. The settlement's blanket Stripe-intent cancellation therefore SPARES
    exactly one intent — the payment's current `additionalPaymentIntentId`, and
    only when the answer was "not covered" — because that instrument is the
    member's only self-service door to the extra
    (`/api/bookings/[id]/additional-payment-secret` hands back precisely that
    id, and neither it nor the booking page's pay card gates on booking status,
    so both keep working on the now-PAID booking). Capturing it is
    ledger-correct: `reconcilePaymentAggregates` sums the captured rows, so
    `Payment.amountCents` becomes cash + addition = `finalPriceCents` and the
    generalised mirror below closes with a zero third term. Superseded addition
    intents are still cancelled (they are doors to a figure nobody is owed), and
    the "covered" answer still cancels the addition's intent, because there the
    extra is paid and a live intent would be a door to a SECOND payment. The
    admin's receipt and the member's confirmation both state which of the two
    situations applies, so nobody is chased for money they cannot send.
    **The member's confirmation must agree with the admin's receipt.** A "not
    covered" settle sends the ordinary booking-confirmed message with the
    balance stated: the money rows become Booking Total / Paid / Still Owing and
    the alert box says the payment was recorded, names what is still owing, and
    says whether it can be paid from the booking page or the club will be in
    touch. "Total Paid: <whole price>" plus "Payment has been processed
    successfully" would tell the member the opposite of what the same HTTP
    response tells the admin.
    **A payment that has already taken money is refused at READ time**, not only
    at the fenced write. The settle-from statuses are PENDING / PROCESSING /
    FAILED (a declined or expired card attempt is exactly what an admin remedies
    with cash); SUCCEEDED and the refunded variants are refused with a message
    that says so. Without the read-time half, the one production shape that puts
    an uncollected extra on a payable booking — a card capture stranded before
    its status promotion (#1418: `confirm-pending-guests` and
    `cron-confirm-pending` both commit the SUCCEEDED ledger row in their own
    transaction and deliberately leave the booking CONFIRMED when the promotion
    then fails) — opened the whole dialog, asked the admin the coverage
    question, and refused every answer with "changed while you were recording
    it", which was untrue and repeated on every retry. The admin booking page's
    advisory state applies the same rule, so the action is not offered at all.
    The three payment-level refusals are also checked in the SAME ORDER on both
    surfaces — refund history, then already-captured, then Xero evidence — so a
    booking that trips more than one is given the same sentence before the click
    and after it. Refund history leads because it is the most specific truth
    (a fully REFUNDED payment is a captured one too, and only the refund message
    names the remedy); Xero trails because the cheap in-memory refusals should
    settle it without the extra lookups `assertNoXeroInvoiceEvidence` costs
    inside the locked transaction.
    **Reachability, stated plainly.** With that read-time refusal in place, no
    production path is known that presents the coverage question on a settle
    that can COMPLETE, other than the reverse-then-re-settle loop and legacy
    pre-ledger rows. Every writer of `additionalAmountCents` requires the
    payment to be captured at the moment the delta is recorded
    (`applyPaymentAdjustments` arm (a) needs `hasCapturedPayment`; arm (b) needs
    an issued Xero invoice, which this settle refuses outright and which nothing
    ever clears), and a captured payment is not a legal settle-from. The
    question and both its branches are therefore correctness insurance for the
    reversal loop, for legacy data, and against a future writer that records a
    delta earlier — not a live hazard. Treat this paragraph as the thing to
    re-check if either the settle-from status set or the delta writers change.
  - **The ledger mirror, generalised (#2397).**
    `amountCents + creditAppliedCents = finalPriceCents` is only the special
    case where nothing is left owing; it cannot hold on a partially settled
    booking. What holds in every case — and what a CARD-settled booking carrying
    an uncollected addition already satisfied, so the manual path now MATCHES
    the card path rather than diverging from it — is
    `amountCents + creditAppliedCents + (uncollected addition) = finalPriceCents`:
    every cent of the price is collected, paid with credit, or still owed. The
    covered answer reduces it to the original mirror with the third term at 0.
    This is NOT enforced by a runtime assertion inside the settle, and it cannot
    be: the settled figure is *defined* as `finalPriceCents - credit -
    uncollected`, so any in-transaction check reduces to `finalPrice ===
    finalPrice`, and re-reading the values after the writes only returns what
    the same locals just wrote. What enforces it, in order, is (1) CONSTRUCTION
    — the PRIMARY and ADDITIONAL rows are a split of one figure, and that figure
    is what `Payment.amountCents` is set to, so the reconciler's own derivation
    reproduces it rather than inflating it; (2) THE FENCE — the fenced
    `payment.updateMany` re-asserts the outstanding delta (on BOTH answers, not
    only the covered one), the settle-from status, the zero refund history and
    the absence of Xero evidence as WHERE clauses, so a concurrent writer that
    moved any of them yields count 0 → 409; and (3) AFTER THE FACT, NARROWLY —
    `auditIbAppliedCreditStrands` recomputes
    `amountCents + creditAppliedCents - finalPriceCents` over committed data and
    reports the uncollected addition beside it, so where it reports at all, a
    residual that is not exactly the uncollected delta is visible to an
    operator. Only (3) is a check that can actually fire, because it is not
    reading back its own writes.
    **(3) is not a safety net for this settle, and must not be relied on as
    one.** It enumerates a payment only when the booking still carries
    UN-ALLOCATED applied credit (`deriveIbAppliedCreditStrandFinding` returns
    null on `ledgerAppliedCents <= 0`, and the ledger sum counts
    `BOOKING_APPLIED` rows with `xeroCreditNoteId: null` only), it scans
    INTERNET_BANKING payments only, and it is an operator-run script
    (`scripts/audit-ib-hold-clearing.ts`), not a scheduled job or an alert. An
    ordinary "not covered" cash settlement on a booking with no applied credit
    therefore produces no finding at all and its residual is never printed.
    Construction and the fence are what keep this settle honest; the audit is a
    reading aid for the credit-strand population it already lists.
    Within that population, a NEGATIVE `mirrorInvariantDeltaCents` is not
    automatically drift: equal-and-opposite to the payment's uncollected
    addition means the generalised mirror holds. Because that audit scans
    INTERNET_BANKING payments only, a card-settled booking never appears in it
    at all; the two shapes that legitimately produce the residual there are a
    Xero-invoiced pay-on-account booking whose later addition was invoiced but
    never paid, and this #2397 "not covered" cash settlement.
    Either answer is recorded on the mark-paid audit row BOTH ways — together
    with the settled figure actually written, the amount owing, and what was
    deliberately left uncollected, so a later reader can reconstruct which
    branch ran and what it meant. A covered extra also writes its own
    `booking-payment.manual-payment.additional-settled` audit row so the booking
    history shows it, and the REVERSAL gives back exactly what its settle took:
    the reversed amount is the figure that was written, and a covered extra goes
    back to owing (ADDITIONAL row → FAILED, column restored by a guarded claim
    matching exactly what the settle wrote), while a not-covered settle has
    nothing about the extra to restore.
  - A stored, unconsumed credit election (#2265) on the booking is never
    silently stranded or ignored (door 3 of the #2319 invariant below): the
    settle clears it with the shared guarded claim, records the cleared cents
    on the mark-paid audit row, and reports it post-commit through
    `reportUnappliedCreditElection` (source `manual-mark-paid`) — the member's
    booking history says their credit was not used and is still available, and
    an operator is alerted to decide whether to refund the difference. The
    reversal does not resurrect a cleared election, so reversal-then-re-mark
    clears and reports exactly once.
  - Both directions are audited with the acting admin and the previous status;
    marking paid also records the #2260 email decision BOTH ways.
- Account credit is consumed only by a booking that is actually reaching
  `PAYMENT_PENDING`, never by one that is still provisional. A booking saved as
  a draft therefore stores the member's ELECTION on
  `Booking.creditElectionCents` (nullable integer cents, #2265) and consumes
  nothing: NULL means no election is outstanding, `0` means the member
  explicitly chose to use none, and a positive value is what they asked to
  apply. A draft that is abandoned, deleted or expires leaves the balance
  untouched, so no release path exists or is needed. The election is
  single-consumption — the pay path clears it to NULL in the same transaction
  that writes the `BOOKING_APPLIED` ledger row — and it is NEVER a record of
  credit already applied: the authoritative applied total is always the
  MemberCredit ledger (`deriveBookingAppliedCreditCents`). ANY booking held for
  admin review keeps its election until an admin releases it to
  `PAYMENT_PENDING` — a saved draft that landed in `AWAITING_REVIEW` and a
  booking the confirmed-create path parked there via `blockForReview` alike.
  Holding for review suppresses the SPEND, never the member's request.
- The EDIT path may write the election too (#2266), and only onto the statuses
  whose election a consumer will later honour: `DRAFT`, `AWAITING_REVIEW`, and
  `PAYMENT_PENDING` (`resolveCreditElectionUpdate`, evaluated against the
  POST-lifecycle status of the edit). `PENDING` is deliberately refused even
  though members can edit PENDING bookings — `charge-saved-method` requires
  `PENDING` and consumes no election, so "no election-bearing booking is ever
  in PENDING" must stay true; the hold release lands the booking in
  `PAYMENT_PENDING`, where the member can elect. A positive election is also
  refused once money is captured or when the booking is organiser-settled; an
  explicit `0` clears; an edit that settles the booking at $0 drops the
  now-moot request silently (the confirm-draft posture). The edit stores the
  RAW requested cents exactly as draft-create does — clamping stays at the
  consumer. A modification that carries ONLY a credit election is
  price-preserving by construction: it takes the identity-only echo (no pricing
  engine, no capacity check) so a season-rate change can never reprice an
  untouched booking, and it sends no change-notification email.
- Members may edit their OWN drafts (#2266) — that is what the dashboard's
  Resume button has always implied. A draft edit moves no money and claims no
  capacity: no change fee (`calculateModificationChangeFee` returns 0 for
  `DRAFT`), no `nonMemberHoldUntil` stamp (`applyLifecycleTransitions` skips
  the hold rail for `DRAFT`), no settlement — the pay step / $0 confirm-draft
  enforce capacity and holds when the draft becomes real. `DRAFT` therefore
  joins `MEMBER_FUTURE_EDIT_STATUSES` but stays OUT of the (now frozen)
  active-edit-lifecycle set, so admin draft edits keep skipping lifecycle
  rules byte-for-byte as before. A member draft edit still gets the wizard's
  over-capacity CHECK (#1767 parity) at quote and apply.
- The election is consumed by a guarded CLAIM, not a read-then-write (#2265):
  the column is moved from the exact amount that was read to NULL with an
  `updateMany` matching the booking id, `PAYMENT_PENDING` and that amount, in
  the same transaction as the ledger write. Two concurrent consumers therefore
  cannot both debit the member; the loser applies nothing and reports nothing,
  because a phantom outcome would produce a second confirmation email, a second
  Xero invoice and a second `MEMBER_PAID` event. There are exactly two
  consumers — the card pay step and the Internet Banking switch — and both take
  the per-member credit-ledger lock before the claim and refuse (leaving the
  election intact) before consuming when capacity is gone. An
  organiser-settled booking can never consume one, so group settlement clears
  the column instead.
- A stored credit election is CLAMPED at confirmation, never refused, and never
  applied short in silence (#2265). Between the election and the confirmation
  the balance may have been spent elsewhere and the booking may have been
  repriced, so the amount applied is
  `min(election, live balance, price not already covered by credit)` — the same
  posture `clampAppliedCreditToBookingPrice` (#1887) takes when a modification
  reprices a booking below its applied credit, and for the same reason: throwing
  would leave the member unable to pay their own booking. The requested amount,
  the applied amount, the shortfall and its cause are returned by the pay route
  so the shortfall is always surfaced. `calculateBookingCreditApplication` keeps
  its throw-on-over-request contract at booking-create, where the wizard
  validated the balance in the same request and an over-request is a bug. The
  reported reason names the bound that ACTUALLY bound — the lower of the two —
  and reads `balance_and_price` only when the balance and the uncovered price
  are equal and both below the request; a bound that sits under the request but
  above the other decided nothing and is not reported.
- A booking with nothing left to pay settles at $0 inside the pay transaction
  rather than dead-ending at the card-intent effective-price guard (#2265):
  status `PAID` plus one $0 `SUCCEEDED` Payment mirroring the applied credit,
  the same zero-dollar shape booking-create and the modification engine use,
  keeping `amountCents + creditAppliedCents = finalPriceCents`. This covers a
  fully-covering election, a booking already covered by credit applied
  elsewhere, and a draft repriced to $0 between the member rendering the pay
  step and clicking it — the last of which previously committed
  `DRAFT -> PAYMENT_PENDING` and only then refused, stranding a booking that
  had left `DRAFT` and could never be paid. The settlement clears the Payment's
  card-intent pointers but keeps `stripePaymentMethodId`, which a split
  parent's deferred non-member guest charge falls back to.
- No SETTLED booking carries a stored credit election (#2265, #2319). Once the
  money has been taken for the amount the intent or the invoice was raised at,
  the election can no longer be honoured: "applying" it then would debit the
  member's balance for cash they have already handed over, inventing a charge
  rather than honouring a choice. So every settlement CLEARS the column, with the
  same guarded claim on the exact amount read (`clearStaleCreditElection`) that
  the consumers use, so a consumer racing the settle is never clobbered:
  - `markBookingPaymentSucceeded` — the single door the Stripe webhook, the
    session confirm, the public payment link, the saved-card charge and the
    auto-confirm cron all funnel through — clears on its `PAID` claim.
  - The Internet Banking inbound reconcile clears on its `PAID` flip, and on the
    late-capacity-failure `CANCELLED` flip in the same writer.
  - The repriced-to-$0 auto-pay arms of both modification services clear, as
    `confirm-draft`'s $0 confirm and group settlement already did.
  - The manual mark-paid settlement (#2262, door 3 of this invariant) clears on
    its `PAID` claim inside the one settlement body, for the same reason in cash
    form: the admin collected the full amount owing OUTSIDE the app, so the
    member's credit was NOT spent and "applying" the election would invent a
    charge. The cleared cents are recorded on the mark-paid audit row
    (`clearedCreditElectionCents`) and reported post-commit through the shared
    reporter with source `manual-mark-paid`, referencing the booking id (this
    door has no Stripe intent and no Xero invoice by definition). The reversal
    RESTORES exactly what that settle cleared: it reads
    `clearedCreditElectionCents` back off the mark-paid audit row and writes it
    to `Booking.creditElectionCents` under a guard matching `null`, so a
    legitimate writer that has since set an election is never clobbered and a
    settle that cleared nothing restores nothing. Restoration is required, not
    optional: nothing outside booking-create can set that column, so a reversal
    that left it null would strand a member holding credit they had elected on a
    booking that is payable again, with no way to re-elect it. A re-mark after a
    reversal therefore finds the restored election, clears it and reports it
    again — once per settlement that took cash while the election stood. Both
    figures are recorded on the mark-unpaid audit row
    (`restoredCreditElectionCents`, `settleClearedCreditElectionCents`), and the
    admin's own response reports the move synchronously either way.
  Clearing is the answer ONLY once the money is taken. While a booking is still
  payable the election remains honourable and must be consumed or left alone —
  never discarded to make a charge simpler, which is the original #2265 bug in
  another form. A reprice that leaves a booking payable therefore keeps its
  election, and the public payment link REFUSES a booking that carries one
  (below) rather than clearing it.
- Whether the clear is reported depends on whether the member lost anything. A
  clear on a $0 settlement is silent: nothing was owed, so the election was moot
  rather than unhonoured. A clear on a settlement that took real money is
  reported through `reportUnappliedCreditElection` — an audit row under
  `booking.credit_election.unapplied`, which the member's own booking history
  renders as a plain-English note ("your credit was not used for this booking and
  your balance was not reduced"), plus an operator alert so someone can decide
  whether to refund anything. A cleared column is invisible, and without the note
  a member who chose to spend credit and then paid full price could not tell
  whether their balance had been debited. It never is: a clear moves no money.
- Neither report may quote the ELECTED figure as if it were still available. The
  election records a choice made when the booking was created, which can be
  months and several bookings ago, so a member who elected $450 and has since
  spent down to $50 still carries a $450 election. The shared reporter therefore
  reads the member's LIVE balance once (`getMemberCreditBalance`) and records it
  on the audit row as `availableCreditCents`, with
  `refundableCents = min(election, balance)`. The member's history note quotes the
  live balance; the operator alert's headline Amount is the refundable figure, it
  says plainly when the balance has moved since, and it says "there is nothing to
  refund" rather than "refund at most $0.00" when the balance is gone. If the
  balance read fails the copy omits every availability figure rather than falling
  back to the overstating one. This binds all three doors — Stripe capture, Xero
  invoice-paid and the manual mark-paid — because it lives in the one reporter.
- The public payment link never spends, and never ignores, a member's credit
  election (#2319). `createPaymentIntentForPaymentLink` refuses (409) a booking
  carrying one instead of minting an intent at the pre-credit price. The reason
  is authorisation, not convenience: the election is a member's request to spend
  their own account-credit balance, and that route is authenticated by a bearer
  token routinely held by someone else (a booking requester, a group joiner, a
  non-member guest), carries no member session, and has no surface on which to
  report a clamped outcome. Nothing is lost by refusing — the member's own pay
  step honours the election — and no mint path attaches a link to a booking that
  can carry one, so the guard asserts that invariant rather than serving routine
  traffic, and alerts an operator if it ever fires.
- Stripe and Internet Banking/Xero settlement paths must remain distinct.
- Stripe paths own PaymentIntents, SetupIntents, Stripe refunds, Stripe
  webhooks, and durable PaymentRecoveryOperation rows.
- Internet Banking bookings issue Xero-backed invoices and reconcile settlement
  through Xero invoice/payment state.
- Internet Banking defaults are non-holding and no-cutoff. If bed holding is
  enabled, the hold expiry is snapshotted on the Payment and must be released
  idempotently by cron if unpaid.
- The hold-expiry release and its invoice-clearing Xero credit-note outbox row
  commit in ONE transaction (#1357): the release marks the hold consumed
  (re-runs skip it), so an intent enqueued post-commit would ride a crash
  window with no self-heal. The outbox enqueue is a pure local insert — the
  Xero call itself stays in the outbox worker, outside the transaction. The
  clearing note is sized like the never-captured cancel path (#1597), NOT the
  credit-reduced payment amount: the booking invoice is raised at the FULL
  finalPrice, so the note is `max(0, finalPrice + changeFee − Xero-allocated
  applied credit)` (only credit already allocated to the invoice AS A XERO
  credit note — `BOOKING_APPLIED` rows carrying `xeroCreditNoteId` — is
  subtracted, and the 100% local restore does not double-count: the allocated
  note stays on the cancelled invoice while the restore re-creates the credit
  locally, netting out). Since #1620 (allocate-existing, see the invariant below)
  that term is non-zero for an Internet-Banking booking whose applied credit was
  allocated to its invoice; before #1620 locally-applied credit never reduced the
  invoice and the term was always 0. It is gated on an ISSUED
  invoice: the create-time hold-slots shape is CONFIRMED and booking-create
  enqueues the invoice only for PAYMENT_PENDING, so that shape reaches release
  with no invoice and enqueues nothing (a refund note against no invoice was a
  permanently-failing outbox op pre-#1597). `scripts/audit-ib-hold-clearing.ts`
  reports invoices under-cleared by the pre-fix sizing (read-only).
- Cancelling a booking never rewrites captured-payment truth (#1473).
  "Captured" is decided on LEDGER evidence — a payment transaction row in a
  captured status (SUCCEEDED / (PARTIALLY_)REFUNDED), or, for STRIPE rows
  with no ledger rows (pre-ledger data), the refund mirror (Stripe refunds
  require a captured charge) — never on the aggregate mirror alone: the
  inbound reconcile folds invoice-applied modification credit notes into
  `refundedAmountCents`/`PARTIALLY_REFUNDED` on never-captured IB payments
  (pure bookkeeping, zero cash), so the mirror lies in both directions. A
  never-captured payment — including that folded shape — flips to FAILED at
  cancel and its open invoice gets the finalPrice+changeFee invoice-clearing
  credit note (the #1015 outstanding-balance rule; supplementary invoices
  from unpaid price increases are a separate pre-existing gap). A genuinely
  captured PARTIALLY_REFUNDED payment takes the PAID cancellation path
  (#1491, owner decision): the member receives the cancellation-policy tier
  of the REMAINING captured value (`refundableBase = min(amountCents −
  refundedAmountCents, finalPrice + changeFee) − changeFee`; change fees stay
  non-refundable per FEE-03), with the same claim-first single-flight,
  frozen card-refund plan, and credit-path ledger writes as a SUCCEEDED
  cancel. Paid-path eligibility is LEDGER-ONLY (a captured transaction row —
  `paymentEligibleForPaidCancelPath`, shared with the cancel-preview route so
  preview and cancel can never disagree): mirror-only legacy rows stay in the
  preserve branch because the refund executors allocate against ledger rows.
  Two paid-path rules keep money truth intact: a captured INTERNET_BANKING
  payment's refund method is coerced to "credit" before the tier is computed
  (there is no Stripe intent to refund — "card" would claim a processed
  refund and book a Xero cash-refund note with no money moved), and any
  folded (mirror-only) refund is materialized into the capture ledger inside
  the claim transaction before new refunds execute, so the aggregate
  reconcile cannot erase the folded history and the allocation planners see
  the true remaining headroom. A captured payment that stays out of the paid
  path (fully REFUNDED, or a flattened legacy mirror) keeps its status and
  refund history, its captured Stripe intent is not sent a cancel, and no
  clearing note is enqueued: finalPrice+changeFee is not its open balance —
  normally the invoice is already settled Xero-side, and in the
  failed-payment-record window a cancel-time clearing note would close the
  invoice underneath the op retry stack's recording repair and permanently
  poison it. The repair pass's late-capture finding fires only when a
  cancelled booking retains captured value with NO recorded
  cancellation-refund decision — no CANCELLED-event policy snapshot (written
  by every paid-path cancel, including 0%-tier retentions), no cancellation
  credit, and no LIVE booking-cancel refund recovery operation (a terminally
  FAILED op is a decision whose money never moved and does not suppress the
  finding) — and is never auto-applied: an operator distinguishes a genuine
  late capture from a deliberate retention, then executes it with
  `--apply --apply-action <key>` (#1491). Rows already flattened by the old
  defect are not backfilled (the repair pass synthesizes captured state from
  the STRIPE mirror).
- Applied account credit is conserved across cancellation (#1547): EVERY
  `cancelBooking` branch — and the Internet-Banking hold-expiry release
  (`internet-banking-payment-cron.ts`), the one automatic cancel outside
  `cancelBooking` — reverses the negative `BOOKING_APPLIED` ledger rows a
  member applied to the booking. The never-captured / no-refund branches and the
  `PENDING` / no-payment branches restore at **100%** (nothing was captured, so
  no cancellation-policy tiering — the same capacity-failure system-void
  precedent); the paid path restores the applied slice at the cancellation tier
  (#1164 / D7). Restore idempotency is now STRUCTURAL, not lock-dependent
  (#1636): the restore row carries a nullable-unique `restoredFromBookingId`, so
  at most one restore row per booking can exist REGARDLESS of caller lock
  granularity — a duplicate insert is a `skipDuplicates` no-op returning 0, never
  a second credit. This is a restore-specific key, NOT a unique over
  `(sourceBookingId, type=CANCELLATION_REFUND)`, because three legitimate paths
  (`restoreCreditFromBooking`, `createCancellationCredit`'s held-as-credit refund,
  and the Xero inbound invoice-paid-effects late-cash credit) all write that
  shape for one booking. Each branch's atomic status flip remains the primary
  single-flight — the never-captured and `PENDING` branches are status-guarded
  claim-first under the booking advisory lock too — but the unique key removes the
  cross-path lock-granularity dependence, so moving a credit-restoring path off
  the shared `lock(1)` (e.g. a per-lodge release lock) can no longer double a
  restore. A CANCELLED
  booking may legitimately hold consumed credit with NO restore row only when its
  payment captured money (0%-tier paid cancels write no restore row;
  held-as-credit refunds keep the applied rows) or settled without cash (the
  fully-credit-covered $0 SUCCEEDED payment — its cancel takes the paid path,
  where a 0%-tier / fee-swallowed restore of 0 is the policy retaining the
  credit). The daily credit-reconciliation
  cron alerts (alert-only, no auto-heal — post-fix, any hit is a new regression)
  on any CANCELLED booking still holding orphaned applied credit, and
  `scripts/backfill-orphaned-applied-credits.ts` heals pre-fix orphans. The
  cancelled-booking delete guard mirrors this: fully-reversed applied credit
  (net-zero, only `BOOKING_APPLIED`/`CANCELLATION_REFUND` rows, no Xero
  credit-note id) no longer blocks deletion — and the coincident
  `payment.creditAppliedCents` mirror is waived with it — while any
  `ADMIN_ADJUSTMENT`/`BOOKING_MODIFICATION_REFUND` row, net-non-zero ledger,
  Xero-linked note, or independently captured/refunded payment still blocks
  (owner decision 2026-07-07, FINAL).
- A booking confirmation must RECONCILE against the member's own statement when
  account credit paid part of the stay (#2328). The email's total has always
  been the booking's `finalPriceCents`, so a member who spent $120.00 of credit
  on a $300.00 stay read "Total Paid: $300.00" while their card took $180.00,
  with nothing to explain the difference. Every confirmation now carries the
  applied-credit pair beneath the total — `Account credit applied: -$120.00`
  then `Paid by <method>: $180.00` — so `total − credit = settled` is checkable
  on the page. The method is named only where money really changed hands: a stay
  fully covered by credit reads `Nothing more to pay: $0.00`, because the $0
  settlement writes a Payment row with no source (it takes the schema default)
  and the branch is payment-method agnostic, so any method word there would be a
  claim the records cannot support. The LINE still renders — completing the
  arithmetic is what the pair is for. "Total Paid" deliberately remains the FULL price: the credit
  really did pay for part of the stay, and reporting only the cash would read as
  though the club were still owed the credit the member had already spent (the
  same convention the #2397 rows follow). The figure is READ, never re-derived:
  `loadBookingAppliedCredit` sums the booking's `BOOKING_APPLIED` ledger rows —
  the same `deriveBookingAppliedCreditCents` authority the effective-price
  guards and the #1887 clamp use, so a later clamp offset nets out — and takes
  the settlement wording from the booking's own Payment row, so a bank transfer
  or a manually-recorded cash settlement is never described as a card charge.
  Re-running `calculateBookingCreditApplication` at send time would instead
  answer "what would we apply now", against a balance and a price that have both
  moved since. `sendBookingConfirmedEmail` performs the read itself rather than
  each of its thirteen send sites threading the figure in, so no site can omit it
  — and an omission is invisible, because a missing credit line looks exactly
  like a booking that used no credit. Empty-case contract: no credit means no
  rows at all (byte-for-byte unchanged), and a send that reports money as NOT
  yet taken (`paymentDue`) renders no pair, because it has no "paid by" figure
  to state. The hand-built HTML and the admin-editable `{{creditNote}}` token
  are built from ONE shared row builder (`appliedCreditSummaryRows`), the
  `{{promoSummary}}` precedent, so the two paths cannot tell different stories
  about the same booking. Money is integer cents throughout.
- An UNPAID confirmation defers to the INVOICE, and promises nothing about it
  (#2444). The `paymentDue` branch states the booking's own price as `Total Due`
  and asks for an internet-banking transfer, but the document the member pays
  against is the club's invoice, which an admin can adjust by hand — netting
  account credit off it is the commonest reason. The paragraph therefore closes
  with a CONDITIONAL sentence — "If the invoice asks for a different amount —
  for example because the club has put account credit you hold towards it —
  please transfer the amount the invoice shows" — which is honest for the great
  majority of members, whose invoice matches the total exactly. It names NO
  second figure and makes NO Xero read: a transactional confirmation must not
  carry a provider round-trip, or a provider outage, in its send path. This is
  the shape sent whenever no applicable credit can be stated — including every
  send on today's one live unpaid path — and #2483 leaves it unchanged to the
  byte.
  **The sentence must not promise that credit WILL be applied.** The one send
  site (member whole-lodge approval) mints a brand-new booking and writes no
  `MemberCredit` row, so the `enqueueXeroAppliedCreditAllocationOperation` call
  it makes always short-circuits — allocate-existing below fires only on credit
  APPLIED app-side — and the Xero invoice is raised for, and stays at, the full
  price. A first draft of this copy asserted the netting and was corrected
  before merge; reinstating it requires making the allocation real first.
  The sentence is composed by `bookingPaymentDueNote` and rendered from that ONE
  composer by both the hand-built HTML and the `{{paymentDueNote}}` token
  (carried whole inside `{{paymentOutcome}}`), on the same anti-drift principle
  as the credit rows above; it rides on an EXISTING token, so an override a club
  saved before #2444 keeps rendering it. Every other money outcome — paid,
  partly paid, and fully credit-covered — is byte-for-byte unchanged.
- An UNPAID confirmation that DOES carry applied credit states the netting, from
  the club's OWN ledger (#2483; owner decision 2 Aug 2026). Where the booking
  carries `BOOKING_APPLIED` rows the Xero invoice is reduced by exactly that
  credit (allocate-existing, below), so the full price would ask a member for
  more than the club wants and they would OVERPAY. The `paymentDue` branch
  therefore renders the reconciling trio — `Booking Total`, `Account credit
  applied`, `Total Due` — from `unpaidMoneySummaryRows`, the shared builder both
  renderers use, and `bookingPaymentDueNote` names the netted figure and states
  the arithmetic in words. `{{totalDue}}` carries the NETTED figure (it has
  always meant "what is still owed"), so no token was added.
  **The figure is LOCAL by decision, and it is not a guess at Xero.** The
  allocation is asynchronous, so reading it back would either delay a
  member-facing confirmation behind a provider operation or make its content
  depend on outbox timing. `deriveBookingAppliedCreditCents` is the club's OWN
  amount-owing law — the same figure `prepareManualSettlement` derives an
  effective price from, the same one the card-capture amount guard accepts, and
  the same `desiredAppliedCents` the deallocation engine converges an invoice to
  — so the netted figure is exactly what the club would accept as full
  settlement.
  **It is NOT the same predicate the allocation gate reads** (review, 2 Aug
  2026; an earlier draft of this bullet claimed it was).
  `enqueueXeroAppliedCreditAllocationOperation` aggregates only the
  `xeroCreditNoteId: null` UNALLOCATED subset — a work-remaining filter over
  those rows — so the two agree only while a stamped row really does mean the
  credit is already off the LIVE invoice. Three things break that, and all three
  are #2501's to surface rather than the email's: a hand edit in Xero; an
  allocation op that FAILED or was never processed, leaving the invoice at the
  full price with the work stalled; and a stamp that outlived the invoice it
  recorded (an invoice unlinked and re-raised), after which the gate finds no
  unallocated rows and queues nothing at all. #2501's checker must therefore
  compare Σ STAMPED `BOOKING_APPLIED` against the live invoice's own
  allocations, not merely club credits against Xero credits.
  **It never asks for a figure the ledger contradicts.**
  `resolveUnpaidCreditNetting` has four outcomes. No credit (or a non-positive
  price) renders the #2444 paragraph unchanged. Credit smaller than the price
  states the trio and asks for the difference. Credit EQUAL to the price states
  `Total Due: $0.00` and asks for nothing — that is not a contradiction but the
  documented steady state of the #1887 reprice clamp, and the state
  `prepareManualSettlement` refuses as "This booking has nothing owing", so
  folding it into a refusal that printed the full price would instruct a 100%
  overpayment. Only credit LARGER than the price refuses, and the refusal states
  no figure at all: the booking's price appears as `Booking Total`, `{{totalDue}}`
  is EMPTY so no saved override can print one, no payment reference is quoted,
  and the member is asked to wait while the club confirms what is left. The
  sender logs that case. A failed ledger read fails open to the #2444 paragraph.
  **Its closing instruction inverts, deliberately — and in ONE direction.**
  #2444 tells the member to transfer what the invoice shows; once the email has
  netted, that would produce the very overpayment this prevents, because the
  invoice may not have been reduced yet. So the netted figure stands against an
  invoice asking for MORE. It does NOT stand against one asking for LESS: that
  is the direction a hand edit in Xero produces, and holding the email's larger
  figure there would recreate the #2444 overpayment. Pay the smaller of the two;
  route the disagreement to the club either way.
  **One number, every message on the send site.** With the Xero module OFF there
  is no invoice object and no allocation op, so nothing downstream would ever
  reconcile an admin who invoiced the gross price against a member who was told
  to transfer the netted one. `sendAdminWholeLodgeManualInvoiceEmail` therefore
  takes the same ledger read and quotes the same figure
  (`wholeLodgeManualInvoiceAmountCents`). The PENDING receivable the conversion
  writes is the booking's price, which equals that figure only while the path
  applies no credit — the premise the #2328 module guard pins; a path that ever
  applies credit here must write the receivable at the effective price too, as
  `booking-create` already does.
- Applied credit reduces the Internet-Banking invoice by ALLOCATING the member's
  EXISTING floating credit notes (#1620, "allocate-existing"; owner decision
  2026-07-08). A member's credit is already represented in Xero as floating
  ACCRECCREDIT notes (minted at cancellation / modification, back-linked to the
  positive `MemberCredit` row's `xeroCreditNoteId`). When credit is applied to an
  IB booking (create-time or switch-to-IB), the raise-path engine
  (`xero-applied-credit-allocation.ts`, an outbox op enqueued after the invoice
  op) allocates those existing notes against the new invoice oldest-first, up to
  the applied amount, so the member pays the EFFECTIVE (credit-reduced) amount.
  Minting a fresh note for the whole applied amount would double-count the
  still-floating original; only the noteless remainder (admin-adjustment credit,
  and #1547-restored credit whose funding note was consumed by a prior cancel)
  is covered by a freshly minted note. Per-note remaining balances live in
  `MemberCreditNoteAllocation` (remaining = the positive lot's `amountCents` minus
  the sum of its allocation rows); lot order is conservation-neutral. The
  `payment` mirror holds `amountCents + creditAppliedCents = finalPriceCents`
  (net of `refundedAmountCents` once a #1765 repay generation exists; the
  switch path derives the applied amount from the `BOOKING_APPLIED` ledger,
  since the card-origin mirror is 0). The engine STAMPS the booking's
  `BOOKING_APPLIED` rows with a representative allocated note id LAST — only once
  the full applied amount is covered — so the #1597 clearing term above is exact;
  the partial-window residual (some notes allocated, stamp not yet written)
  differs by path: a concurrent CANCEL treats the credit as unallocated and its
  clearing note plus the allocations can exceed the invoice, which Xero rejects
  LOUDLY (the cancel path allocates its note against the invoice); a concurrent
  HOLD-EXPIRY settles its clearing note by bank payment instead of invoice
  allocation, so the same window silently over-credits Xero by the
  already-allocated slice — a bookkeeping-only divergence (member LOCAL money is
  conserved either way by the 100% restore) that an operator reconciles in Xero.
  In both paths the op's idempotent retry (the `@@unique(memberCreditId,
  appliedToBookingId)` join key + per-row completion links) finishes the
  allocations then stamps. The retry's re-plan reads each lot's remaining balance
  EXCLUDING this booking's own already-committed allocation rows — the plan phase
  commits those rows before the (out-of-transaction) Xero allocations run, so
  counting them on a retry after a mid-flight provider failure would read the lot
  as consumed and throw a spurious ledger inconsistency, permanently bricking the
  op. A FAILED allocation op has no auto FAILED→PENDING reaper, so recovery runs
  through the Xero outbox retry stack (`xero-operation-retry.ts`), which re-drives
  the same idempotent engine keyed on the queued `{bookingId}` payload.
  Cancellation is UNCHANGED and still conserves: the
  100% restore + `finalPrice − allocated` clearing note void the invoice while
  returning the credit LOCALLY. This leaves a transient representation divergence
  — after a cancel of an allocated-credit booking the restored credit is
  local-only (its funding note was consumed by the cancelled invoice); the local
  ledger is the source of truth and Xero catches up when the credit is next used,
  via the noteless mint-fresh branch. ACCOUNTING-POLICY flag (open): the minted
  remainder note posts to the shared `hutFeeRefunds` mapping; whether admin /
  goodwill credit should post to a distinct write-off account is an owner call.
- Applied credit reduces the CARD (Stripe) charge the same way — "spend credit,
  pay less" on card too (#1641, owner decision 2026-07-08, extending the #1620
  engine). The Stripe PaymentIntent is minted at the EFFECTIVE amount
  (`finalPriceCents − Σ BOOKING_APPLIED`, derived from the ledger via
  `deriveBookingAppliedCreditCents`; a fully credit-covered booking never reaches
  the card flow — it is confirmed at $0 by the create-time zero-dollar path — so
  the intent route guards `effective > 0` rather than minting a $0 intent). The
  `Payment` mirror carries `amountCents = effective`, `creditAppliedCents = applied`
  (invariant `amountCents + creditAppliedCents = finalPriceCents`; once a repay
  generation exists — #1765, pay → refund → reprice → repay on the same Payment —
  the mirror aggregates gross captures across generations and the invariant is
  NET-based: `(amountCents − refundedAmountCents) + creditAppliedCents =
  finalPriceCents` at repay settlement). Every
  capture/reconciliation guard accepts EITHER the effective price OR the full
  `finalPriceCents` (legacy in-flight intents minted before the fix) and rejects any
  other amount (create-payment-intent reuse, `stripe-webhook-service`,
  `payment-reconciliation`, and the synchronous `confirm-payment` guard) — full
  price is always a legitimate settlement, and new bookings only ever mint effective
  intents, so the leniency cannot re-open the double-charge. Because a card invoice
  is raised-and-paid near-instantly at capture (`queueXeroInvoiceForPaidBooking` →
  `createXeroInvoiceForBooking`), the #1620 fire-after-invoice outbox op is NOT used
  on card; instead `createXeroInvoiceForBooking` records the NET captured Stripe
  cash — gross captures − refunds, i.e. the effective amount, capped at the
  invoice's amount due (#1765: settlement evidence is captured-status + positive
  net cash, never `status === "SUCCEEDED"` alone, which misreads a repay-settled
  PARTIALLY_REFUNDED aggregate; every skip logs a populated reason) — and then
  SYNCHRONOUSLY re-drives the same allocation engine (gated the same way, plus
  `creditAppliedCents > 0`) so the invoice settles to PAID via
  (effective cash + credit-note allocation) and is never left with the applied slice
  outstanding. The allocation throws on failure (the invoice op fails and the retry
  short-circuits on the persisted `xeroInvoiceId`, re-driving the idempotent engine
  without re-creating the invoice) rather than silently leaving credit unallocated. A
  LEGACY full-price card capture (`creditAppliedCents = 0`) is settled in full by
  cash and does NOT allocate (a Xero note cannot refund cash already sent); its
  historical double-pay is repaired by an operator-reviewed LOCAL credit restore,
  enumerated read-only by `auditCardAppliedCreditDoublePays`.
- A payment landing on an already-CANCELLED booking's stale open invoice must
  never settle silently (#1357) — but a PAID invoice event alone proves
  nothing: Xero also reports PAID when OUR OWN clearing credit note is
  allocated (zero cash), and every paid-then-cancelled booking replays PAID
  events for money the cancellation flow already settled. Minting therefore
  requires positive CASH evidence on the invoice (`amountPaid`, falling back
  to actual payment records), a payment that never settled (PENDING/FAILED),
  and no credit already minted by this pipeline (matched by its own credit
  descriptions — never by amount, which collides with unrelated
  cancellation-flow rows). Both credit-minting arms (already-cancelled and
  late-capacity-failure) size the mint by the invoice's QUANTIFIED cash
  (#1459), clamped per payment to the payment's own amount — `amountPaid`
  plus overpayment/prepayment allocations (which accrue to `amountCredited`,
  so they are additive), falling back to the invoice's non-DELETED payment
  records only when `amountPaid` is unusable — never by the payment's face
  amount alone: on a mixed invoice (part cash, remainder cleared by credit
  allocation) the member is credited only the cash that actually arrived, and
  the admin alert names both amounts so the operator can verify the
  allocation source. Partially quantifiable evidence floors the mint at the
  verified cash and the alert says the figures are unverified; only evidence
  that quantifies NOTHING (degraded shapes only; the fresh getInvoice fetch
  carries the amount fields) falls back to the full payment amount rather
  than silently under-crediting. Beyond the per-payment clamp, the mint is
  also capped PER INVOICE (#1505): each arm caps its mint at the invoice's
  quantified cash MINUS the cash already minted as credit for the OTHER
  Internet Banking payments matched to the same invoice, so two never-settled
  payments on one invoice can never in aggregate mint more than the invoice's
  cash (the earlier payment mints its per-payment amount; a later payment is
  apportioned only the remaining cash, and one whose remainder is zero settles
  with no credit). No app flow produces multiple never-settled payments on one
  invoice (payments/invoices are 1:1; same-booking retries are booking-keyed-
  deduped; group settlements ride their own settlement path) — this is a
  defensive invariant. The remaining-cash figure is read back INSIDE each
  payment's reconcile transaction, under the shared advisory lock and excluding
  the payment's own booking, so the cap is idempotent under retry (a replayed
  payment finds its own credit via the per-booking dedup and mints nothing);
  an apportioned or fully-exhausted mint raises the same loud admin alert the
  partial-mint path uses, never a silent overmint. When it mints,
  the inbound reconcile creates the member credit and enqueues the offsetting
  account-credit note — both sized at the minted amount — and retires the
  now-obsolete still-PENDING invoice-clearing refund note, all in ONE
  transaction — then alerts the admins exactly once. Cash arriving AFTER a
  mint never credits automatically (the settled-payment and dedup gates hold);
  when a later event's fully-verified cash exceeds the already-minted credit,
  the reconcile alerts the admins with the delta instead of staying silent,
  and cash-classified evidence that quantifies to zero on a never-settled
  payment alerts as a payload anomaly rather than settling without a credit. A PAID invoice event
  never overwrites a (PARTIALLY_)REFUNDED payment or transaction status back
  to SUCCEEDED.
- The same cash-evidence rule gates Internet Banking SETTLEMENT itself, not
  just credit minting (#1435), on BOTH inbound settlement surfaces: the
  per-payment loop and the combined group-settlement flip. Settlement runs
  only when the PAID invoice carries positive cash evidence: `amountPaid`
  when present (an explicit 0 is authoritative), falling back to actual
  non-DELETED payment records. Operator-applied OVERPAYMENT and PREPAYMENT
  allocations also count as cash — they are real member money on the Xero
  contact, and the app's own bookkeeping only ever produces credit-note
  allocations, so they can never be the clearing-note echo the gate exists
  to stop. Mixed cash+credit invoices settle (`amountPaid` is the cash
  portion; credit allocations accrue to `amountCredited`). A credit-note-
  cleared invoice settles nothing — no PaymentTransaction or Payment
  SUCCEEDED flip, no booking PAID flip, no member credit, no group-child
  flips; the skip only stamps MISSING invoice identifiers (linkage, never
  status) so a later real-cash event for the same invoice still matches its
  payments, and it alerts the admins when the affected booking is still live
  (an operator cleared the invoice Xero-side while the app still awaits
  payment — nothing else would ever settle or expire that booking). A
  payload carrying NEITHER cash field fails the inbound event instead of
  settling blind or skipping terminally (owner-approved default): the
  FAILED-retry sweep re-fetches the invoice fresh, so transient payload
  degradation self-heals and persistent degradation stays loud and
  operator-replayable. Canonical single-payment identifier backfill remains
  with `syncLinkedPaymentInvoiceMetadata`, which runs before the loop.
- Payment, refund, and credit operations must be idempotent across retries,
  webhook replays, cron reruns, and partial failure recovery.
- The Stripe webhook dedup claim (`ProcessedWebhookEvent`) is a processing
  LEASE, not a bare "seen" marker (F16, #1887). The claim carries `status`
  (`PROCESSING`/`COMPLETED`) and `processingStartedAt`. A redelivery hitting an
  existing claim ACKs 200 only when the claim is `COMPLETED`; a `PROCESSING`
  claim still inside the lease window (15 minutes) forces a provider retry
  (HTTP 500) rather than a false-duplicate ACK, and an expired lease (a crashed
  prior attempt) is taken over atomically and reprocessed. A handler failure
  still releases the claim (delete) so the retry re-claims fresh. This closes
  two lost-event windows: a crash between claim-insert and completion, and a
  concurrent redelivery ACKed while the in-flight attempt later fails. Handlers
  stay idempotent, so a lease takeover reprocessing after a crash is safe.
- A FAILED Stripe payment does not immediately reap the `WAITING_PAYMENT` Xero
  outbox op linked to its intent (F19, #1887). A failed PaymentIntent can be
  retried and SUCCEED on the same intent id, so the reap requires the
  transaction to have stayed FAILED past a 24h grace window
  (`FAILED_TRANSACTION_REAP_GRACE_HOURS`) before cancelling — otherwise a not
  yet-retried failure could be cancelled out from under a same-intent retry that
  is about to succeed, capturing money with no Xero invoice. A retry that
  already succeeded flips the same row to SUCCEEDED and is excluded by the status
  filter; the grace only guards the narrow FAILED→about-to-SUCCEED race. The
  grace is measured on the transaction's `updatedAt`, which is NOT immutable in
  the FAILED state: a redelivered `payment_intent.payment_failed` re-writes
  status=FAILED unconditionally, so `@updatedAt` bumps and the grace restarts.
  This can only DELAY a reap, never trigger one early, and the intent-agnostic
  14-day `createdAt` sweep is the hard backstop that bounds it (and covers ops
  whose intent never resolved at all).
- External provider side effects require clear retry and idempotency behavior.
- An organiser-pays group settlement applies only when the payment matches the
  sum of the settleable children **at apply time**, re-verified under the lock
  — a child booking edited while the combined intent/invoice was open must not
  auto-settle at the stale total. Mismatches go to operator review: Stripe
  captures are auto-refunded with an admin alert; paid Internet Banking
  invoices stay PENDING with an admin alert.
- Committing organiser-pays group children to CONFIRMED before payment has an
  expiry path: the `group-settlement-reaper` cron releases the beds when the
  settlement stays unpaid past its window (never past check-in), voids the
  open intent, and notifies the organiser and joiners — idempotently, and a
  payment that lands first always wins under the shared lock.
- The reverted children have a terminal path too (#1094): joiners cannot pay
  an organiser-settled booking themselves, so if the FAILED settlement sits
  unretried through a second full reap window the same cron cancels the
  PAYMENT_PENDING children, exactly once, with a joiner notification. A
  settlement retry (which flips the row back to PENDING and resets its clock)
  always keeps the children alive — both are re-checked on the fresh row
  under the shared lock.
- An organiser-cancel group cleanup must be re-drivable after a crash (#1236).
  Cancelling the organiser booking is single-flight, so a re-invoked cancel
  409s and cannot re-enter the joiner cleanup; the `group-settlement-reaper`
  resumes it (an ORGANISER_PAYS group still not CANCELLED under a CANCELLED
  organiser booking, older than a short grace). The per-child refund plan
  (`{childId: cents}`) persisted on the settlement is the **record of record**
  for the organiser-settled per-child `refundedAmountCents` mirror: a re-drive
  **reconstructs it verbatim and never recomputes** — a >24h re-drive can land
  in a different cancellation tier, so recomputing the mirror amount would be
  unsafe. The plan is written before the Stripe refund and before the
  settlement flips, so the refund fires at most once across re-drives.
- Organiser cancellation is a durable settlement fence (#1881). It writes the
  group `CANCELLED` under global `lock(1)` before any provider call or child
  cleanup. Settlement apply re-reads that fence under the same lock and cannot
  promote children afterward. If settlement won first, cancellation observes
  the paid state and arms/refunds the frozen plan; if cancellation won first, a
  late Stripe capture is auto-refunded as superseded and a late paid Xero invoice
  is left unapplied with an operator alert. Child cancellation is status-guarded.
  The resume cron finds fenced groups by remaining active organiser-settled
  children, not by requiring the group status to remain open.
  Settlement initiation checks the fence both at entry and again under global
  `lock(1)` before child-lodge locks; neither Stripe nor Internet Banking may
  create fresh provider work for a cancelled group. Internet Banking settlement
  creation commits its settlement row and Xero outbox row atomically. The Xero
  worker also shares `lock(1)`: it skips provider work when cancellation was
  already fenced, and if cancellation commits while `createInvoices` is outside
  the transaction, it durably records the returned invoice identity, voids that
  invoice with a stable idempotency key, suppresses invoice email, and leaves a
  failed outbox operation retryable when compensation fails.
- The group-cancel refund credit-note enqueue is **durable** (#1257/#1377).
  Each child's Xero refund credit-note outbox row (integer cents) is enqueued
  **inside the same transaction** as that child's cancel + `refundedAmountCents`
  mirror — the enqueue is a DB outbox insert, not a provider call, so it may
  join the tx. A crash can therefore never leave a `CANCELLED` child with its
  refund mirror written but no credit-note operation queued: either both commit
  or neither does (the reaper then re-drives the still-`ACTIVE` child). This
  closes the window for **every** payment source, including Internet-Banking
  children the #1354 daily reconcile self-heal cannot recover because they carry
  no per-child `xeroInvoiceId`; that daily self-heal remains a Stripe-only
  backstop. Only the outbox worker *kick* stays best-effort and post-commit.
- A failed settlement refund must stay durably owed (#1351): the frozen plan
  is never nulled, a payment-recovery operation persisted before the inline
  Stripe call retries the refund under the same
  `group_cancel_refund_<settlementId>` key, and no interleaving of the inline
  run, the recovery replay, and the reaper resume may apply a per-child
  refund mirror twice — the replay only ever writes a mirror to an
  already-CANCELLED plan child whose `refundedAmountCents` is still zero,
  via a conditional update. Alerts fire on retry exhaustion only.

## Member-Guest Consent

A MEMBER added as somebody else's guest may need that member's agreement first
("+ Add Member Guest", epic #2305, decision D-7). The state lives in five
columns on `BookingGuest` — `consentStatus`, `consentRequestedAt`,
`consentRespondedAt`, `consentRespondedByMemberId`, `consentExpiresAt` — not in
a side table.

**MG1 (#2306) shipped every one of these columns inert. MG2 (#2307) turns them
on.** With the `memberGuests` module enabled, a cross-family active member now
resolves and the row carries a real consent state; with it disabled — the shipped
default (D-2) — a cross-family add is refused with the byte-for-byte pre-feature
error and nothing writes a non-null `consentStatus`. The invariants below are now
live behaviour, not a forward contract.

Two consequences of the owner's ticks are recorded here as **chosen behaviour**,
because both are surprising and neither should be discovered by a member:

- **An approved stay may be extended without asking again** (owner decision
  D-13). Consent covers the booking *however it later changes*, in both policy
  modes: no reset to `PENDING`, and no change notification in notify-only either.
  So a booker may add nights to a stay a member agreed to, and that member keeps
  holding the new nights without being asked. Their only exit is self-removal —
  which, per D-14 below, may itself be refused. The two ticks compound, and this
  is where that is written down.
- **A member who never consented can be refused the ability to come off the
  booking** (owner decision D-14). Declining is a self-removal, so it runs the
  ordinary blockers. A pending guest CAN decline when the booking status allows
  guest changes, check-in is strictly in the future, the booking has two or more
  guests, it is not quote-priced, and the reduction needs no refund-vs-credit
  election. They are TRAPPED — a plain-English 400, and the row survives as
  *blocked* on the admin exception list — when a captured payment's cancellation
  tier returns money (the common case, because member guests are charged up front
  on the mixed-party split), when they are the booking's only guest, when the
  booking was quote-priced, when check-in has started, or when the status forbids
  changes. The member is told who can help; MG2 adds no exemption, which is
  exactly what D-14 decides. See docs/STATE_MACHINES.md for the transition list.

- **`NULL` is not `CONFIRMED`.** A null `consentStatus` means *no consent was
  ever needed* — a family-scope add (D-6) or a row written before the feature
  existed. `CONFIRMED` means *somebody said yes*. Conflating them is
  irreversible: once a family row is stamped `CONFIRMED`, nothing downstream can
  recover the fact that nobody was ever asked. A family-scope add must never
  write anything but nulls.
- **A consent that was never solicited is recorded as such.** `consentRequestedAt`
  is the discriminator: it is set only when the club actually asked. Notify-only
  auto-confirms and admin/copy/pipeline rows are `CONFIRMED` with a null
  `consentRequestedAt`, and are still *not* written as all-nulls, because the
  guest genuinely is cross-family and that must stay visible. Neither shape is
  waiting for an answer, so neither carries a `consentExpiresAt`: a settled row
  with a live hold deadline on it is a broken row, not a variant.
- **A refusal names who refused.** `DECLINED` requires a non-null
  `consentRespondedByMemberId`. Declining is an attributed act — MG4's audit
  reads that column to say who turned the add down — so an unattributed decline
  is not an anonymous decline, it is a row no writer should produce.
- **Who answered is audited separately from who was asked.**
  `consentRespondedByMemberId` may equal the guest (self-approval), differ from
  them (a delegate approving for a target with no login, D-5/D-10), or name the
  acting admin (an admin assignment or a booking copy). MG4's admin-assigner
  audit rides this column; no extra column exists or is needed.
- **Nobody answers for a member who can sign in** (owner decision D-5/D-10). The
  delegate rule has a target side as well as an actor side, and both are
  enforced: a delegate must be an active, login-holding ADULT sharing a family
  group with the target, AND the target must NOT hold a login of their own.
  Without the target conjunct, two members of one household who are both put on
  the same booking can answer for each other — including declining, which
  releases the other's bed and deletes their guest row. `canRespondForTarget`
  and `resolveNotificationRecipients` in `src/lib/member-guest-delegate.ts` share
  one predicate for it, so "who may act" and "who is told" cannot drift into two
  different rules. A consequence worth expecting: a login-holding target the club
  has no email address for is asked nobody and told nobody, because the household
  may not answer for them either — an unanswerable request emailed to a household
  would only strand the bed.
- **A delegate's answer is told to the member it was given for.** A member
  answering for themselves needs no notice, but a delegate's answer is somebody
  else's decision about them, so the member — and the other adults who were sent
  the same request — receive the `member-guest-consent-answered` email naming who
  answered and what they said. It carries no money and no booking link: the
  recipient may have nothing to do with the booking, and D-11 grants booking-page
  access to a guest ROW, never to a delegate.
- **A `PENDING` row holds the bed** (D-4) until `consentExpiresAt`, which is set
  from `MemberGuestSettings.pendingHoldExpiryDays` (default 7, bounds 1–60). A
  `PENDING` row without an expiry would be an unbounded capacity hold and is not
  a legal shape.
- **Consent is not transitive across bookings.** A copied booking's guest never
  inherits the source row's approval: the copy is re-stamped as an admin
  assignment against the copying admin. Neither may it silently become
  consent-free.
- **A merged-away member's guest rows keep their consent.** `BookingGuest.member`
  is classified `move` in `src/lib/member-merge.ts`, so merging A into B
  re-points A's guest rows — consent columns included — onto B.
  `consentRespondedByMemberId` is an FK-less snapshot and keeps the id of
  whoever actually answered at the time, even after that member is merged away.
  The survivor therefore **inherits the consent the loser gave**, which is the
  accepted consequence of the existing `move` classification, and two shapes fall
  out of it that a reader should expect rather than discover: a merge can put two
  guest rows for the same person on one booking (a person-night conflict the merge
  path resolves), and a merge can leave a booking whose only guest is the
  survivor, i.e. in `LAST_GUEST` — so a later decline or lapse on that row lands
  on the admin exception list instead of releasing the bed.
- **A pending guest is not operationally present** (owner decision D-12). Only
  `null` and `CONFIRMED` rows appear on the kiosk arrivals list, the arrive/depart
  gate, the chore roster and its print sheet, bed allocation and the admin bed
  board, the hut-leader pickers, the lodge display board, the week summary, the
  double-bed candidate sweep, and — because these are member-facing content, not
  just screens — the pre-arrival and check-in reminder emails. The single shared
  predicate is `OPERATIONALLY_PRESENT_GUEST_WHERE`, written as an explicit
  `OR: [{ consentStatus: null }, { consentStatus: "CONFIRMED" }]`. It must NEVER
  be written as `{ consentStatus: { not: "PENDING" } }`: on a nullable column that
  form is `UNKNOWN` for every `NULL` row, so it would silently drop every ordinary
  guest off the kiosk and out of the arrival emails in production.
- **A pending guest DOES hold a bed and a person-night** (owner decision D-4), and
  every capacity path counts them. Capacity, month availability, the occupancy
  index, partner shared-admission and the person-night conflict guard must NOT
  gain a consent filter — a pending guest who did not hold their person-night
  could be placed in two beds on one night. The exclusion list and the freeze list
  are deliberate opposites, and each has its own test.
- **A data-subject export is not an operational surface.** The member data export
  deliberately includes the member's own pending rows and exports
  `consentStatus` as a field. Excluding them would make the export incomplete
  about a commitment that exists.

**MG4 (#2309) closes the last three paths.** MG1 provisioned the columns, MG2
turned them on for the member-facing add, MG3 built the finder, and MG4 covers
the edit path, admin parity and the booking-request pipeline. Its rules:

- **Adding a member guest while EDITING is the same act as adding one while
  creating.** The edit panel's section goes through the modification path, which
  resolves the family boundary and plans consent through the same single writer
  every other add uses. There is no second consent rule for the edit path, and a
  refusal on it is the same neutral D-8 sentence.
- **Every path that can place a member on a booking now records who did it and
  tells the member.** Four write points reach this: the member add, the admin
  add, the admin booking-copy, and the booking-request pipeline (owner decisions
  MG4-D-a and MG4-D-b). The pipeline has THREE such points, not the two the issue
  body named — the capacity hold's booking create, the approval-time guest swap,
  and the approval that runs with no hold behind it — and all three write
  `ADMIN_ASSIGNED` naming the approving officer. There is no exemption: MG4-D-b
  was ticked in the direction of bringing the pipeline under the rule, so this
  section records the rule rather than an exception to it.
- **A held booking's guest swap can substitute one person for another in place.**
  The approval preserves each guest row's id so pre-assigned beds survive
  (#1254), which means replacing a member on a row looks like an ordinary update.
  Both parties must be told: the newcomer that they are on the booking, the
  person dropped that they are not. A reused row's consent record is cleared when
  the person on it changes — a stale `ADMIN_ASSIGNED` would vouch for somebody
  who was never asked, which `classifyMemberGuestConsent` calls a broken row.
- **A member guest who comes OFF a booking is told, once, by whichever path
  removed them.** `member-guest-request-withdrawn` covers a request called off
  before anybody answered, a settled member guest taken off, and a pipeline
  substitution. It is sent by the single-guest removal route and the batch edit
  and by NOTHING else: a decline and a lapse each already have their own message
  for the same event, and a member removing themselves is not told what they just
  did. A row whose `consentStatus` is `NULL` owes nobody anything, because no
  message was ever sent about it.
- **"Always notify" beats the per-action tick and the member's preferences, and
  loses to the per-booking No-emails switch** (owner decision D-16, and the
  precedent D10 set over #1705's invoice email). None of the six member-guest
  senders consults `shouldSendEmail`, and no caller gates them on an admin's
  notify choice — being asked, being told you are on a booking, and being told
  you are off it are not courtesy messages. All six pass a real `bookingContext`,
  so a silenced booking withholds them and each withheld send lands on that
  booking's withheld-banner record where an operator can see what was held back.
- **The officer's member picker gates its NAME mode on `membership:view`, not on
  `bookings:edit`** (owner decision D-20). It is deliberately NOT bound by the
  club's two member-facing privacy switches: an admin holding `membership:view`
  can already browse the whole roll from `/admin/members`, so gating their
  booking-side picker on a member-facing setting protects nothing. The rider is
  what keeps #1376 true — a Booking Officer whose role carries no membership
  access gets a 404 on the NAME mode and falls back to exact-email resolve, which
  needs only `bookings:edit`. Every officer lookup is audited through the same two
  writers the member routes use, including the malformed-address and
  lookup-failed outcomes, so officers are not invisible in the trail that exists
  to make browsing detectable. The **email mode is a `POST` with the address in
  the body**, matching `POST /api/members/guest-candidates/resolve`: a member's
  address must never travel in a URL, where it would reach the access log, the
  browser history and the `Referer` of everything the page loads next.
- **Which reader gets which picker is decided by ONE predicate**
  (`resolveMemberGuestNameSearchAccess`), the same `viewerRole === "ADMIN"` the
  edit panel uses to choose its routes. Deciding "may this reader search by name"
  from a different permission than "which routes will this reader call" strands
  the read-only bookings viewer between them: with `membership:view` they get a
  name box that 404s on the member route, and without it they lose a search their
  club turned on for every member.
- **Exactly one file turns either open-search value into a decision about who is
  discoverable.** Routes declare the AUDIENCE they are serving;
  `member-guest-find-service.ts` decides what that means. A second decision site
  is how two surfaces come to disagree about whether the roll is browsable.

The eight legal column shapes, and only those eight, are. In the four column
cells, **null** means the column must be `NULL`, **set** means it must be
non-`NULL`, and **any** means either is legal; where the responder's identity
also matters it is named instead.

| Sub-state | `consentStatus` | `requestedAt` | `respondedAt` | `respondedByMemberId` | `expiresAt` |
| --- | --- | --- | --- | --- | --- |
| `FAMILY_OR_LEGACY` | `NULL` | null | null | null | null |
| `AWAITING_TARGET` | `PENDING` | set | null | null | set |
| `TARGET_APPROVED` | `CONFIRMED` | set | set | the guest themselves | any |
| `DELEGATE_APPROVED` | `CONFIRMED` | set | set | someone other than the guest | any |
| `NOTIFY_ONLY_AUTO_CONFIRMED` | `CONFIRMED` | null | null | null | null |
| `ADMIN_ASSIGNED` | `CONFIRMED` | null | set | the acting admin | null |
| `DECLINED` | `DECLINED` | set | set | set | any |
| `EXPIRED` | `EXPIRED` | set | null | null | set |

This table is the same data as `MEMBER_GUEST_CONSENT_SUB_STATES` in
`src/lib/member-guest-consent.ts`, whose `classifyMemberGuestConsent` returns
`null` for any other combination. It is not merely "kept in step" by hand:
`src/lib/__tests__/member-guest-consent.test.ts` GENERATES each row above from
the code table (one mapping of set / null / any / the responder words) and fails
unless this file contains it verbatim, so a shape that changes in code cannot
leave a stale row here.

## Booking Modifications

Booking changes must not orphan or desynchronize:

- Guests and per-guest stay ranges
- Payments and PaymentTransaction rows
- Refunds and member credits
- Xero invoices, payments, credit notes, and object links
- Bed allocations
- Audit records
- Emails and notification state
- Waitlist and capacity decisions

Positive deltas, negative deltas, credits, refunds, and additional payments must
remain traceable to the original booking and modification event.

A modification price increase whose Stripe intent creation fails transiently is
never lost silently (#1358, F29): every additional-intent flow routes through
the shared helper whose failure path enqueues a durable
`CREATE_ADDITIONAL_PAYMENT_INTENT` recovery operation keyed one-per-modification
with the same modification-scoped Stripe idempotency key, so the replay collects
exactly once; exhausted retries alert the admins with the member, booking, and
amount, and stalled or exhausted queues surface through the recovery health
checks. The recovery processor is execution-time honest about lifecycle: a
booking CANCELLED after the modification completes the operation WITHOUT
minting an intent — cancellation already tore down its additional intents, and
recovery must never resurrect a retired collectable or re-arm the parked
supplementary Xero operation for money that must not be captured (the
stale-WAITING_PAYMENT reaper retires that op).

Per-guest stay ranges must sit inside the parent booking's checkIn/checkOut
envelope (both are half-open night ranges per the stay-boundary invariant in
"Booking Dates And Capacity"). A guest stay range outside the current envelope
is not rejected —
it auto-expands the booking's dates (issue #713). The database enforces the
envelope as a safety net with deferred constraint triggers
(`BookingGuest_stay_range_within_booking`,
`Booking_dates_consistent_with_guests`) that validate at COMMIT, so a
transaction may widen guest rows before the parent booking row; only the
committed state must satisfy the invariant. The modification services call
`assertBookingEnvelopeInvariants` (`SET CONSTRAINTS … IMMEDIATE`) as the last
statement of their transactions so a violation is attributed to the calling
service rather than surfacing as an anonymous commit failure; the modify
routes recognise the constraint errors via
`isBookingEnvelopeInvariantViolation` and return a clean 500 instead of
leaking raw trigger text to the client.

Nightly prices lock at booking time: every edit path — batch modify, date
change, guest add, single-guest removal, and the modify-quote preview — prices
only the changed guests/nights at current season rates. A night a guest
already bought keeps the price stored on its `BookingGuestNight` row, so a
season-rate change between booking and edit never rolls into unchanged nights
(adding one guest costs exactly that guest's price; removing one returns
exactly theirs, policy permitting). Edits also price each untouched guest over
exactly the night set they hold (#1093): a partial-stay guest never grows
phantom nights because an unrelated guest was added or removed. A booking date
change is the deliberate reset: it moves every guest — partial stays included —
onto the full new range (the batch-path policy) and re-syncs their
`BookingGuestNight` rows to the newly priced nights, and a guest added mid-life
gets night rows at creation so later edits honour the prices they joined at.
The waitlist offer reprice is the other deliberate exception: an offer re-bases
the whole booking at current rates before the member confirms, and the offer
email states that price. Legacy guests without stored night rows price at
current rates; a one-off backfill migration (#1098) synthesised rows for
pre-#713 guests on live, non-quote-priced bookings (stored price split evenly
across the stay envelope, integer cents, remainder on the first night), so
that fallback now covers only quote-priced bookings — already protected by
the #1032 edit block — and rows created outside the app.

Every edit path passes the default group discount into pricing exactly as
creation and the waitlist reprice do (#1095), and locks win over the discount:
a night a guest already bought keeps its locked (discount-inclusive) price, so
a party dropping below the minimum on removal never loses a discount it
bought, and the discount applies only to newly priced nights — a guest added
to a qualifying party, or nights a date change adds. Eligibility is per night
and per party size on that night: a partial-stay guest's absent nights do not
count toward the minimum. The modify-quote preview prices with the same
config so previews match what the mutating paths charge. The guest-add route
therefore prices the whole post-add party in one pass — the added guest's
stored price and night rows are their slice of the combined breakdown.

Hut nightly rates are keyed by membership type, not a member/non-member boolean
(#1930, E4). `MembershipTypeSeasonRate` holds one rate per `(season, membership
type, ageTier?)`: each `MEMBER_RATE` type carries its own rows, non-members
price via the built-in `NON_MEMBER` type, and `NON_MEMBER_RATE` (except
`NON_MEMBER`) and `BLOCK_BOOKING` types carry **zero** own rows — the resolver
never consults them (testable invariant). A type prices per age tier when
`ageGroupsApply` is true, or from a single `NULL`-ageTier flat row when false;
the engine prefers an exact tier row and falls back to the flat row. The rate
resolver classifies every guest as `OWN_TYPE` (a `MEMBER_RATE` member on their
own rows), `NON_MEMBER_DEFAULT` (a true non-member on the `NON_MEMBER` rows), or
`TYPE_POLICY_FORCED` (a member whose type forces the non-member rate, priced on
the `NON_MEMBER` rows). A missing rate for a type × active season is a hard
throw at pricing plus a setup-readiness warning. The group discount no longer
flips a boolean: it substitutes `GroupDiscountSetting.rateMembershipTypeId`
(seeded to `FULL`) **only** for `NON_MEMBER_DEFAULT` guests, so members keep
their own type's rate and `TYPE_POLICY_FORCED` members are excluded — the two
load-bearing behaviours the old flip preserved.

A fourth way to reach `NON_MEMBER_DEFAULT` arrived with #2543: under
`NON_MEMBER_PRICING`, a member whose season subscription is required but unpaid.
That class resolves `NON_MEMBER_DEFAULT` **and not** `TYPE_POLICY_FORCED`, so the
group discount treats them exactly like a real non-member. The distinction is
money, not taxonomy: `TYPE_POLICY_FORCED` is excluded from the substitution, so
labelling the reprice that way charged the repriced member the raw `NON_MEMBER`
rate on every discounted night while the genuine non-member beside them paid the
substituted (`FULL`) rate — 2400 c/night against 1000 c/night on the seeded
fixture, i.e. 2.4x the rate the club actually charges non-members on that booking,
and an outcome where the member is better off if the club deletes their membership
record. The owner's rule is "priced at non-member rates", so they are priced at the
rate a non-member pays. `TYPE_POLICY_FORCED` itself is untouched — a membership
type the club deliberately configured onto non-member rates stays outside the
discount, exactly as #1930 decided.

**Membership, not the subscription, gates member-only promotions.** A repriced
member keeps `isMember = true`, and `selectPromoDiscountGuests` filters
`memberGuestsOnly` promotions on that flag, so a repriced member remains eligible
for a member-only promo and can therefore pay LESS than the non-member beside them.
That is deliberate and stated rather than incidental: their MEMBERSHIP is intact and
in good standing — only the subscription is unpaid — and the owner's rule speaks to
rates, not to member benefits. A club that wants the promotion withheld too should
say so; the change would be to gate the predicate on `rateSource` rather than
`isMember`, which is a separate decision about member benefits and not part of the
repricing rule. Pinned by a test, so the behaviour cannot drift silently either way.

Every priced guest stores a `BookingGuest.rateMembershipTypeId` snapshot — the
type whose rows priced it (the resolved type, never the per-night discount
substitution). Xero line building reads the snapshot to pick the hut-fee item
code. The snapshot is **not** write-once: modify/reprice flows (waitlist offer
reprice, date change, guest add/removal) recompute and overwrite it for
repriced guests alongside `priceCents`; a guest who **keeps any locked night** keeps
both its price and their stale snapshot untouched
(`rateSnapshotUpdateForRepricedGuest`, applied on the batch-modify, date-change and
single-guest-removal writes). That guard is what makes the promise true rather than
aspirational: the snapshot is per GUEST, the locked prices are per NIGHT
(`BookingGuestNight` has no rate-type column), and Xero resolves ONE item code per
guest and applies it to every night run of that guest even though runs are split by
price change. So overwriting the snapshot on a stay that mixes locked and
newly-priced nights posts the locked MEMBER-rate nights under the newly resolved
NON_MEMBER item code. Pre-#2543 the trigger was a mid-booking membership-type
change, i.e. rare; #2543 made it the ordinary case for any unpaid member editing a
booking in a `NON_MEMBER_PRICING` club. The residual, stated plainly, is that such a
guest keeps the OLD item code for the newly priced nights too — the same direction
the locked price itself takes, and the only per-guest answer available until an item
code can be resolved per night run. A guest whose locked prices were deliberately
CLEARED (the #2337 placeholder→member link, which reprices the whole stay) has no
kept locked night and is correctly re-snapshotted. A `NULL` snapshot (pre-refactor booking) falls
back `isMember → FULL / NON_MEMBER` forever. Because the day-one fan-out
backfill copied the old member rows/codes to every `MEMBER_RATE` type and the
non-member rows/codes to `NON_MEMBER`, existing bookings and invoices resolve
byte-identically under the new key.

Every booking-reduction path — batch modify (`removeGuestIds`/date change),
single-guest removal (`DELETE …/guests/[guestId]`), and date change
(`modify-dates`) — returns member money limited by the same cancellation-policy
tier for the days until check-in, folding any change fee into the net delta, and
requires the member to elect a card refund or account credit whenever a captured
payment makes a settlement returnable. No reduction path refunds the full price
delta outside the policy. A request against a booking with a captured payment
that omits the settlement election is rejected rather than defaulted, so a
body-less self-removal cannot silently settle the booking owner's money; the
owner or an admin makes the election through the batch edit flow.

A pre-payment reduction can drop `finalPriceCents` BELOW the account credit
already applied at booking-create (F20, #1887). Every modification apply path
that reprices (batch modify and single-guest removal via
`applyLifecycleTransitions`, date change via its own settlement block) re-derives
the applied credit in-transaction, under the member-credit ledger lock, and
refunds the over-consumed slice back to the member (an append-only positive
`BOOKING_APPLIED` offset that nets the applied credit down to the new price and
returns the excess to the member's balance). The zero-dollar auto-pay decision
then keys on the EFFECTIVE (credit-reduced) price, not raw `finalPriceCents`,
mirroring booking-create: a reduction that lands the booking fully
credit-covered auto-confirms it at $0 instead of dead-ending as unpayable at the
card-intent guard (which rejects `effectivePriceCents <= 0`) with the member's
credit over-consumed. The clamp is gated on the LEDGER (a cheap unlocked
`deriveBookingAppliedCreditCents` read) plus a pre-payment status
(PENDING/PAYMENT_PENDING), NOT the payment's `creditAppliedCents` mirror (F1,
#1887): a CARD booking has no `Payment` row until it requests a card intent, so
the mirror gate missed exactly that surface and left the booking dead-ending
unpayable with credit over-consumed. A no-credit modification reads the ledger
once, finds nothing, and never takes the member-credit lock or writes a row —
byte-for-byte unchanged. The clamp is idempotent under transaction re-drive.

Because the clamp only fires in PENDING/PAYMENT_PENDING, a modification parked to
AWAITING_REVIEW does NOT refund credit or auto-$0-pay before an admin approves it
(F4, #1887), matching booking-create's under-review block on the zero-dollar
path; the release-from-review transition lands PAYMENT_PENDING, at which point the
clamp runs.

Xero deallocation on Internet-Banking bookings (F3, #1887): the positive clamp
offset and `APPLIED_CREDIT_DEALLOCATION` outbox operation commit in the SAME
member-credit-locked transaction. The worker later obtains Xero's real
allocation IDs, checkpoints them, deletes the invoice allocations, recreates the
reduced integer-cent target, verifies it, then reduces the local allocation
slices. Before releasing the member lock it atomically snapshots the desired
signed-ledger cents and every precise slice into the same durable operation.
Inbound repair, a later clamp, and allocation planning inspect that RUNNING (or
provider-ambiguous FAILED/PARTIAL) fence while holding the same member lock, so
each mutation is wholly before the snapshot or deferred until convergence; no
stale target can release newly valid credit. Multiple notes and multiple local
lots per note are supported.

After verification, the same local transaction deactivates the superseded
synthetic/actual `APPLIED_CREDIT_ALLOCATION` row links (or the Payment-scoped
`APPLIED_CREDIT_REMAINDER_ALLOCATION` link for a minted remainder) and creates
active replacements keyed by the actual allocation IDs returned by Xero. A zero
target has no active allocation link. Durable checkpoint history records every
row's current/target cents, prior links, Xero-read IDs/amounts, and the provenance
rule used for an equal-total match, so a crash after provider recreate can heal
local link truth without another create.

Crash/retry contract: partial deletes resume only checkpointed IDs; a crash after
provider recreate but before the local update verifies the target and completes
the local reduction. Simultaneously claimed allocation/deallocation workers for
one Payment return their transient losers to PENDING; a subsequent scan executes
them without overlap instead of stranding both FAILED. A provider total that is
neither exact local state nor a checkpointed
partial/target is ambiguous (for example, a manual Xero edit): the operation
fails visibly for operator retry/manual review and never guesses an ID or amount.
One narrow exception is not a genuine failure: a post-delete+recreate re-GET (or
the next retry's top-of-loop guard) whose total is explained purely by Xero
eventual consistency relative to the durable BEFORE_DELETE/PROVIDER_VERIFIED
checkpoints — a just-deleted allocation still listed, or a just-created recreate
not yet listed (all visible IDs are checkpointed-or-the-recreate) — is
classified transient and requeued to PENDING with backoff (bounded; repeated
non-convergence still lands terminal FAILED for the operator). Only totals or ID
sets that no eventual-consistency projection explains stay terminal.
The admin retry action never invokes either multi-call applied-credit handler
inline: one atomic FAILED/PARTIAL-to-PENDING compare-and-set wins, then the
outbox's PENDING-to-RUNNING claim remains the sole provider-call authority.
Never-captured cancellation and Internet-Banking hold expiry derive the
invoice's allocated credit from the precise positive
`MemberCreditNoteAllocation.amountCents` aggregate, not the coarse historical
`MemberCredit.xeroCreditNoteId` stamp, which cannot represent a partial clamp.
Only those two paths take the member lock and fence: they defer the entire
transition while an `APPLIED_CREDIT_DEALLOCATION` is PENDING, RUNNING, FAILED,
PARTIAL, or WAITING_PAYMENT. This prevents either transition from freezing a
clearing-note amount against the pre-clamp slices; after the worker reaches
COMPLETE, the retry reads the converged target slices. The paid/captured cancel
(refund) path does not take this fence: it restores credit from the payment
mirror (a mirror-based, capped restore) and never sizes any clearing amount
from slices, so no slice-derived money error is constructible there.

Inbound/legacy repairs that stamped `BOOKING_APPLIED.xeroCreditNoteId` without
creating a precise slice are upgraded under the same transaction lock before
clamp, cancel, expiry, or deallocation reads them. Repair requires exactly one
positive funding lot and enough unallocated cents, creates the
`MemberCreditNoteAllocation` plus active provenance link, and fails closed on
missing or ambiguous provenance. Allocation rows are mutable working slices:
provider-verified deallocation may reduce or delete them. Immutable-equivalent
audit is retained in the deallocation operation's request checkpoint/history
(prior and target cents, provider IDs and match rule) and the inactive/active
`XeroObjectLink` history. Repair validates an existing slice against the signed
ledger rather than accepting it merely because it exists; net-zero historical
negative plus positive-clamp rows never recreate a fully deallocated slice.
When a later unstamped application makes the booking net-negative again, any
active or inactive allocation-link history for the old note/invoice remains a
tombstone and still blocks reconstruction; only provider-observed inbound repair
may recreate working state.
Inbound provider-observed increases/decreases reconcile the precise slice and
append a signed offset instead of rewriting the historical negative application;
superseded allocation links are deactivated, not erased.
Because Xero omits zero allocations from credit-note responses, inbound repair
also diffs active applied-credit allocation links and treats a previously linked
invoice that is now absent as a provider-observed zero target.
Inbound applied-credit reconciliation resolves its payment/member context first
from `CANCELLATION_REFUND` `MemberCredit` rows stamped with the note; when a note
has no such provenance — e.g. an admin-adjustment-minted remainder note — it
falls back to unambiguous LOCAL provenance instead (#1925): the precise
`MemberCreditNoteAllocation` slices stamped with the note joined to their funding
lots, cross-checked against the note's ACTIVE allocation links. That fallback
fails closed (no write, identical to the pre-#1925 skip) whenever the member is
not uniquely identifiable, a slice is missing its funding lot or booking, an
active link references a slice/payment outside the stamped set, or no active link
proves the allocation existed; tombstoned links never resurrect a repair. Every
repaired amount is still derived downstream from the provider targets and precise
slices, so the fallback introduces no amount guess of its own.
Applied-credit provider allocation child operations retain their parent booking,
payment, and operation context. They are never manually replayed inline; retry is
performed only through the serialized parent/outbox workflow so a stale child
cannot recreate credit after deallocation.
Legacy contextless children are also fail-closed by their precise-slice or direct
Payment allocation shape; explicit queued credit-note allocation repairs remain
separate and retryable.

Every modification path also applies the same lifecycle transitions: a
PAYMENT_PENDING booking whose EFFECTIVE (credit-reduced) price drops to zero
auto-pays with a zero-dollar payment (superseding and cancelling any outstanding
primary PaymentIntents so a stale checkout tab cannot capture the pre-change
amount), any *other* price
change supersedes pending primary intents stranded at the old amount (#1161 —
and belt-and-braces, both intent-issuing endpoints refuse to hand out a
client_secret whose amount no longer matches `finalPriceCents`, and the
Stripe webhook alerts admins before refusing a capture that mismatches the
booking's current total), and the non-member
hold is recalculated from the remaining guests (all-member bookings clear the
hold; bookings inside the hold window or under a disabled hold policy move
PENDING → PAYMENT_PENDING). The same
change must produce the same booking state regardless of which endpoint made
it.

Self-service edits obey a date-window edit policy (`getBookingEditPolicy`):
future bookings edit freely, an in-progress stay (checked in, not yet checked
out) may only extend its **future** nights with the check-in locked, and a
fully-past stay is not self-editable at all. (The booking stays editable
through its whole check-out day — an edit-window rule, not a presence rule;
the stay-boundary invariant in "Booking Dates And Capacity" is unaffected.)
On an in-progress extension the
minimum-stay policy is evaluated over the **whole contiguous stay**, not the
added nights alone (#2124): because the original check-in is kept fixed, the
modify-quote preview runs `validateMinimumStay` across `[checkIn, newCheckOut]`
(the already-valid original plus the added nights), so a member can extend
their check-out one night at a time even across a weekend minimum-stay rule —
the added night alone would fail the minimum, but the whole stay satisfies it.
A genuinely too-short whole stay is still reported. (The create path evaluates
each new booking's own range, so a separate contiguous one-night booking is
still subject to the minimum — deferred as scope B on #2124.)

Minimum-stay is also the first consumer of the booking-policy exception
foundation (#2363). The only soft-policy reason codes are `MINIMUM_STAY` and the
reserved `ADULT_MEMBER_HOSTING_REQUIRED`; every other failure remains a hard
stop and cannot enter `aggregatePolicyExceptionViolations`. A minimum-stay
violation freezes its policy id/version, resolved club-wide or lodge-specific
scope, exact affected NZ lodge nights, minimum/actual-night requirements,
eligibility, message, and `HOLD`/`NO_HOLD` capacity mode. Multiple eligible
violations sort deterministically and aggregate to `HOLD` if any row says
`HOLD`.

That snapshot is transport data only in #2363: it explains a refusal, it never
authorises one. **Every** member-facing mutation path stops server-side for a
non-admin actor, and the list is exact:

- booking create (`POST /api/bookings`) — HTTP 400;
- member group join (`POST /api/group-bookings/[code]/join`) — HTTP 400 with
  code `MINIMUM_STAY_VIOLATION`;
- public non-member group join, at **both** stages — staging
  (`POST /api/group-bookings/[code]/join-request`) refuses with HTTP 400 before
  a verification token, join row, or email exists, and verification
  (`POST /api/group-bookings/join/verify/[token]`) re-reads the CURRENT policy
  set and fails closed with HTTP 409 `minimum_stay` before any member, booking,
  payment or pay link is created — an emailed link lives 48 hours, so a rule
  tightened inside that window must not be honoured. Both stages are
  unauthenticated, so both answer with the SAME generic sentence
  (`PUBLIC_GROUP_JOIN_MINIMUM_STAY_MESSAGE`) and carry nothing else: staging
  throws a `GroupBookingError` with a message and `MINIMUM_STAY_VIOLATION` only,
  verification returns `{ outcome, message }` only. The rule-naming sentence and
  the frozen snapshot exist solely in a `logger.warn` line each stage writes
  beside its refusal — not merely unread by the route, but absent from what the
  route holds, because both surfaces are one field-spread from the wire;
- member date modification through the live edit surface
  (`PUT /api/bookings/[id]/modify` → `modifyBookingBatch`) — HTTP 400, checked
  before the guest plan, pricing and capacity. Its sibling
  `PUT /api/bookings/[id]/modify-dates` (`modifyBookingDates`) carries the same
  block. On the batch path the check runs **only when the edit actually moves a
  night** — the resolved envelope after any `guestStayRanges` widening differs
  from the stored one (`resolveTargetDates().datesChanged`). An edit that leaves
  every night where it was (a guest add, a guest removal, a name fix, a credit
  election) cannot admit a NEW violation, so enforcing it could only hard-block
  an unrelated fix to a booking already grandfathered outside the policy, with
  no remedy the member can reach. `modify-quote` gates its own advisory check on
  the identical predicate (`targetDatesChanged`, computed the same way), so
  preview and apply agree on every request shape.
- waitlist-offer confirmation (`POST /api/bookings/[id]/waitlist-confirm` →
  `confirmWaitlistOffer`), on **both** offer kinds. Confirming turns a queue
  placeholder into capacity-holding status, so it is a fresh commitment to those
  nights, and an offer lives 48 hours — long enough for a rule to be tightened
  under it. A same-lodge offer is evaluated against the booking's own lodge; a
  cross-lodge offer (ADR-004) is evaluated against the **offered** lodge, which
  matters because per-lodge policy resolution replaces rather than merges, so
  that lodge can carry rules the member's own lodge never had, and because the
  cross-lodge path calls `createConfirmedBooking` directly and would otherwise
  apply no rule at all. Both checks run outside any transaction and fail closed
  **without consuming the offer**: the entry reverts to `WAITLISTED` under the
  relevant lodge's capacity lock, exactly as the capacity-lost and
  no-longer-eligible branches do, and the member gets a plain sentence with code
  `MINIMUM_STAY_VIOLATION` while the frozen snapshot stays in the server log.
  There is no admin branch on this path by construction: the confirm refuses any
  actor other than the booking's own member with `Forbidden`, so the only actor
  that ever reaches the check is a non-admin confirming their own offer.
  Because the same-lodge check reads the offer OUTSIDE the claiming transaction
  and runs only when that read already saw a live same-lodge offer this member
  owns, the claim carries a backstop: it records whether the check actually ran,
  and if it finds `WAITLIST_OFFERED` under the lodge lock either without that
  evidence or with a `waitlistOfferedLodgeId` the pre-read did not see, it
  refuses with code `CONFIRM_RETRY` (HTTP 409) and writes nothing at all. The
  offer sweep (`processWaitlistForDates`) makes exactly the
  `WAITLISTED -> WAITLIST_OFFERED` transition that invalidates the pre-read and
  the route carries no rate limit, so without the backstop an offer created in
  that window would be claimed with the policy never evaluated. Refusing is
  retry-safe by construction — no status moves, no allocation is touched and the
  offer is not consumed — so the next attempt re-reads the row and the guard
  evaluates for real.

The admin exemption is **not one predicate**, and the difference is deliberate.
State it per path:

- **Booking create** exempts an authorised **on-behalf** booking only
  (`isAuthorizedOnBehalf`). A dual-hat admin booking for THEMSELVES is still
  checked — #1442's decision: acting as a member means being held to the members'
  rules. Role alone buys nothing here.
- **Both modify paths and the modify-quote preview** exempt any ADMIN actor
  (`actor.role !== "ADMIN"` / `!isAdmin`), including admin-on-behalf edits.
- **Member group join** exempts any ADMIN session (`sessionRole !== "ADMIN"`),
  self-join included — the create path's narrower rule is not mirrored here.
- **The two public non-member group-join stages and both waitlist-offer confirm
  paths have no admin branch at all**, because no admin actor can reach them:
  the public stages are unauthenticated non-member surfaces, and a confirm
  refuses any actor other than the booking's own member with `Forbidden`.

Advisory surfaces — modify quote, policy check,
and the edit panel's banner — report the same facts without gating anything;
the panel deliberately leaves Save enabled because the server is authoritative.
No request row is persisted, no capacity is reserved from `HOLD`, and evaluation
never bypasses capacity, subscription, membership, linked-member-night,
authentication, payment, privacy, date, or data-integrity gates. #2365 owns
durable request state, approval/revalidation, capacity reservation, and the
mixed soft/hard admission order. Every caller evaluates against the resolved
booking lodge; unknown or inactive explicit lodge ids are refused rather than
falling back.

Minimum-stay policy administration is versioned. Every create supplies
`capacityMode`; every update/toggle/delete carries the loaded `version` and a
stale version is refused instead of overwriting a concurrent admin or import.
Config transfer is the one replace-set exception: it takes the config-import
lock then the shared policy-set lock, re-plans, and may delete omitted policies
only after they appeared in Preview. Existing policies migrate to `HOLD`.

### Adult-member hosting (#2364, epic decisions D-R3 / D-R4)

A club may optionally ask that every non-member guest-night overlaps an adult
member who is actually staying on the same booking. It is the second consumer of
the #2363 exception foundation and the second allowlisted reason code,
`ADULT_MEMBER_HOSTING_REQUIRED`.

**Configuration.** One `AdultMemberHostingPolicy` row per scope: a club-wide row
(`Disabled` / `Admin review required`) plus, per lodge, an override that may also
say `Inherit`. Scope identity is pinned in the database — `scopeKey` is held to
`COALESCE(lodgeId, 'club-wide')` by a CHECK and carries a unique index, so a
second club-wide row cannot exist and resolution is deterministic. A club-wide
`INHERIT` is refused by a second CHECK, because it would have nothing to inherit
from. `capacityMode` has **no** database default (D-R6): the table is created
empty and every API and UI write states it. Every write is versioned and
compare-and-swaps on the revision the editor loaded, under the
`adult-member-hosting-policy-set` advisory key.

**Resolution.** A lodge row whose mode is not `INHERIT` replaces the club default
for that lodge; an `INHERIT` row, or no row at all, falls through to the club
row; a club with no row resolves `DISABLED`. A scope that cannot be identified is
REFUSED (`UnknownAdultMemberHostingScopeError`), never quietly answered
"disabled" — the caller must not be able to confuse "the club has not turned this
on" with "we could not tell which lodge this is".

**Who may host.** An active, uncancelled, unarchived **ADULT** `Member` who is
linked to a guest row on that exact night. Three consequences, each deliberate:

- **Booking ownership never proves attendance.** The owner counts only through a
  participant row linked to them, and only on the nights that row covers. The
  evaluator is never given `Booking.memberId`, so it cannot be credited by
  accident.
- **The member LINK is authoritative, not the guest row's `isMember` flag**,
  which is a pricing-time snapshot. A row whose member cannot be resolved is
  treated as a non-member guest — the safe direction, since that means it needs
  hosting rather than provides it.
- **Child, youth, infant and NOT_APPLICABLE (organisation) members cannot
  host.** They are still members in good standing, so their OWN nights never
  need covering: the minors rule (`requiresAdminReview`) owns children, and this
  rule is about non-member guest-nights only.
- **A membership that has lapsed is not a membership.** An inactive, cancelled
  or archived member cannot host AND their own nights need hosting: the safe
  direction above is applied to a member who is resolvable but no longer in good
  standing, because for this rule they are functionally a non-member (D-R3). The
  standing test is the single predicate both sides are built from, so a
  participant cannot fall between them and escape the rule entirely — which is
  what happened before the #2364 review. It is keyed off standing only, never
  `ageTier`, so an active organisation member is unchanged.
- **An unaccepted member-guest invite cannot host.** `consentStatus: PENDING` is
  not operationally present (D-12) — the kiosk, the arrival roster, bed
  allocation and the arrival emails all leave that row out — so counting it as a
  host would let a member suppress the review with an adult who never agreed to
  come, and the lodge would then receive the non-member guests unaccompanied.
  The review clears by itself the moment the invite is accepted.

Nights come from the sparse `BookingGuestNight` rows (#713), so a non-contiguous
stay is judged night by night. Rows predating #713 fall back to the GUEST's own
`stayStart..stayEnd` envelope, never the booking's.

**Split bookings (#738).** A mixed party awaiting payment is stored as a member
booking plus a linked non-member child. Judged alone the child contains no member
at all, so the evaluation borrows the direct parent's (or child's) adults as
host-only participants whenever that sibling belongs to the SAME member and is
live. Uncovered guest-nights still come only from the booking's own rows, so one
party yields one hazard rather than two. Group bookings are explicitly NOT
affected: a joiner's booking belongs to a different member, so an organiser's
adults never host somebody else's guests and "the same booking" keeps meaning
what it says.

That borrowing makes the dependency **symmetric**, and reconciliation has to
match it: shortening the member's own stay on the parent takes a host away from
the child, and extending it gives one back, without a single row on the child
changing. Every mutation path therefore reconciles the mutated booking AND the
live same-member siblings the borrow reads, inside the same transaction
(`reconcileAdultMemberHostingReviewWithSiblings`). The fan-out is one level and
that is exact rather than a safety margin — the relation is direct-parent /
direct-child, so expanding from a sibling could only lead back. A sibling always
opens PENDING: an admin's on-behalf reason belongs to the booking they were
making, never to a row reached through it.

**Consequence.** Hosting is a REVIEW, not a refusal — the club chose "admin
review required", and D-R4 makes it always administratively overridable. A
member's booking is made and an admin decides afterwards. The hosting review
lives in its OWN `Booking` columns (`adultMemberHostingReview*`) rather than the
shared `requiresAdminReview` / `adminReviewStatus` pair, because several booking
paths wipe those the moment the minors-only rule stops applying, and an unrelated
guest edit must not silently discard an admin's hosting decision. The two hazards
are reported together as structured codes at read time
(`bookingReviewReasonCodes`), which is what "without overloading the legacy single
review string" means here. A pending hosting review deliberately does NOT block
lodge check-in: the minors gate is a child-safety stop, whereas the fix for a
hosting hazard — an adult member joining the booking — is not something anybody at
the door can do.

**Admin exemption.** Stated per path, like minimum stay's:

- **Booking create** refuses an authorised **on-behalf** booking that trips the
  rule with HTTP 409 `ADULT_MEMBER_HOSTING_CONFIRM_REQUIRED` until the admin
  supplies a reason, which is then persisted with their id against an APPROVED
  review. Role alone buys nothing: a dual-hat admin booking for themselves is a
  member here, exactly as #1442 decided for minimum stay. `/admin/book` answers
  that 409 with a reason panel on both submit paths — confirm and save-as-draft,
  since the check runs before the draft fork — mirroring the over-capacity
  warn-and-confirm beside it. A `*_CONFIRM_REQUIRED` refusal no surface can
  satisfy is a permanent block, so the contract test pins that every such code
  the create route can return has a client that branches on it.
- **The reviewer is a real foreign key.** `adultMemberHostingReviewedById`
  carries a `SetNull` relation to `Member` and a `member-merge.ts` spec, like
  every other actor-attribution column on `Booking`. Member merge repoints it and
  member deletion nulls it; a bare id would be invisible to the DMMF
  completeness guard and D-R4's "who let this through" would rot into a dangling
  id the database never surfaces.
- **Every other path opens the review PENDING for everybody, admin included.**
  Accepting a hosting exception is a deliberate act with a reason attached, not a
  side effect of an unrelated edit, so a modification, a guest change or a
  waitlist confirm never auto-approves a hazard it just created.

**Re-evaluation.** The reconciler derives everything from live rows and is
idempotent, so it runs at the end of every booking path that can change the
party: create (draft, confirmed, waitlisted, and the split child), batch modify,
date modify, admin date shift, guest add, guest removal and waitlist confirm —
each inside its own transaction, with the caller's `tx`. It also runs on every
path that CREATES a whole party without going through `booking-create.ts`: the
public booking-request approval and its held-booking conversion, the
quote-time hold, both school/member whole-lodge approvals, and the verified
non-member group joiner. Those are the parties the rule most obviously targets —
every guest a non-member, the owner a non-login contact — and leaving them
unrecorded meant the hazard was present but invisible until some unrelated later
edit materialised it months on. They all open PENDING and none of them is
blocked: approving a REQUEST is not the reasoned acceptance of a hosting
exception that D-R4 asks for. `adult-member-hosting-review.test.ts` enforces this
structurally — every module in `src/` containing a `booking.create(` must reach a
hosting recorder, and no module outside the review service may call the
single-booking reconciler. A hazard **clears**
whenever current facts cover every night, for any reason: an adult member was
added, a guest left, the nights moved, the member was reinstated, the policy was
switched off, or the booking moved to a lodge that never had the rule. It
**reopens** as PENDING, dropping the previous decision, only when the uncovered
guest-night set or the policy revision materially differs — a renamed guest or an
extra host on an already-covered night does not re-prompt an admin who has
already decided.

**Scope boundary.** #2364 stops at configuration, the evaluator and these
integration seams. The member request surface, the admin execution UI, durable
proposal state and capacity reservation from `HOLD` all belong to #2365; the
capacity mode is frozen onto the snapshot and aggregated here, and reserves
nothing.

**Owner decision (3 Aug 2026), #2569: two independent dimensions.** The policy is
no longer one setting. A club configures a CONSEQUENCE and a HOST-QUALIFICATION
scope set, each with a club-wide default and a per-lodge override that carries an
explicit inherit option, and the two are resolved SEPARATELY — a lodge may
override one while inheriting the other, so `ResolvedAdultMemberHostingPolicy`
reports where each came from.

- **Three consequences.** `DISABLED`, `ADMIN_REVIEW_REQUIRED` (unchanged: the
  booking is made and an officer is asked to look) and `ENFORCED` (the booking is
  refused). `ENFORCED` raises `AdultMemberHostingRequiredError` — HTTP 409,
  `exceptionEligible`, carrying the SAME frozen violation the review mode records,
  aggregated by the same `aggregatePolicyExceptionViolations` and re-derived
  server-side when the member walks through the #2365 door. There is no second
  refusal path and no second reason code; only whether the booking is allowed to
  exist while it waits differs. The refusal is thrown from inside the mutation
  transaction, so a modification that would break the rule rolls back.
- **`INHERIT` remains lodge-only for the consequence**, and the second dimension
  inherits by a different mechanism: both host-scope columns NULL TOGETHER
  means "this row did not decide". The database CHECK holds them to all-null or
  all-set, so a half-configured scope set cannot exist for the resolver to guess
  at, and a NULL set on the club row resolves to the built-in default.
- **Two scopes, and these two** (owner decisions, 3 Aug 2026). `SAME_BOOKING` is
  the pre-#2569 rule kept verbatim. `SAME_BOOKING_OWNER` counts a qualifying adult
  member attending another eligible booking with the EXACT same `Booking.memberId`,
  at the same lodge on the same night (#2576) — one account's own bookings covering
  each other, never `createdById`, a shared email, a Family Group link or
  `parentBookingId` alone. The spec's third scope, `ANY_MEMBER_AT_LODGE`, is
  REMOVED (#2575): a booking must not become compliant because an unrelated member
  happens to be at the lodge. The originally planned `NOMINATED_HOST` workflow is
  REMOVED with it (#2576) — no nomination, invitation, acceptance or host-search
  machinery exists or is planned. Both are removals rather than deferrals, so there
  is deliberately no hidden, reserved or refused value for either in the database
  or the application; bringing one back means re-deciding it.
- **The built-in default is same-booking only, and that is what makes the upgrade
  a no-op.** Every pre-#2569 row carries NULL scope columns, so every existing
  club keeps judging exactly the coverage it judged before. Nothing is broadened
  to same-owner coverage, no club is moved onto `ENFORCED`, and the
  member-facing review sentence is byte-identical for a club on the default set.
- **OR across enabled scopes, decided per night.** A non-member guest-night is
  compliant where AT LEAST ONE enabled scope supplies eligible adult-member cover
  for that exact night; different nights may be covered by different scopes and
  different members, and EVERY such night must be covered. The seam is
  `HostingParticipant.hostScope` (absent means `SAME_BOOKING`): the evaluator
  counts a host only where the club has that host's scope switched on, so a wider
  scope is added by stamping its participants rather than by changing the rule. A
  #738 split sibling is deliberately `SAME_BOOKING` — a split pair is one party
  the database stores as two rows, not a second booking at the lodge.
- **An active policy with no scope enabled is refused, not interpreted.** The
  admin route and config transfer both refuse it, and the evaluator throws
  `EmptyAdultMemberHostScopeSetError` rather than treating it as permissive
  (which would drop the club's rule) or as universal (which would flag or refuse
  every booking).
- **Host identities are never disclosed to the booking owner.** Member-facing
  refusal bodies are built by `buildAdultMemberHostingRefusalBody`, which strips
  `qualifyingHostsByNight[].memberIds` while keeping the nights and the scopes
  that covered them. The frozen snapshot an officer reviews keeps the ids in full
  for validation and audit. Applied under every scope, not only the wider one: a
  redaction that fires under one setting is a redaction nobody tests. Under
  `SAME_BOOKING_OWNER` the covering stay is on the member's own account, so the
  member may be told that another of their bookings supplies or depends on cover
  (#2576 §11) — what is withheld is the internal member id, not the fact.
- **School and organisation workflows are excluded** (§13), and only they. The one
  approval that covers them — `approveSchoolBookingRequest`, since
  `BookingRequestType.SCHOOL` carries school groups and organisations alike —
  passes `enforcement: "REVIEW_ONLY"`, which evaluates and records the hazard
  exactly as the review consequence does and never refuses, and the choice travels
  to their split siblings so one half of a #738 pair cannot be exempt while the
  other is refused. The MEMBER whole-lodge approval is deliberately NOT exempt: it
  is a member-owned booking flow, which the first release covers (§2), and the §13
  reasoning is about teachers, organisation leaders and custodians. An enforcing
  lodge therefore refuses that approval, rolling it back untouched, and the officer
  is told the rule with no exception door — they are the authority it leads to.
  `adult-member-hosting-call-sites.test.ts` pins the exemption to that one site
  tree-wide.
- **An explicit admin decision is an approval.** D-R4's on-behalf reason still
  lets an officer make a non-compliant booking under `ENFORCED`: the reason is
  attributable and is recorded against the approved review, which is the same
  authority the exception door leads to.
- **The officer queue says which consequence produced the request.** The reason
  label is the same under both, and the situations are opposite: under `ENFORCED`
  there is no booking (or no change) until the officer approves, under
  `ADMIN_REVIEW_REQUIRED` there already is one and the officer is recording a view
  of it. The queue reads the consequence off the FROZEN violation, never the live
  policy row — the club may have changed the setting since, and the decision is
  about what happened at the time — and says nothing about beds, because the card's
  own badge derives the hold and two derivations of one fact drift.

**Same-owner coverage (#2576).** `SAME_BOOKING_OWNER` reuses every definition
`SAME_BOOKING` already has — qualifying adult member, exact guest-night, membership
standing, age, member-guest consent, exceptions, reason and evidence structures —
and adds only WHERE the host may be. Its rules:

- **The relationship is the exact `Booking.memberId`.** An administrator entering
  bookings on behalf of different members never links them.
- **Only genuinely confirmed active attendance counts.** Drafts, holds,
  payment-pending, waitlist entries and offers, bookings awaiting review or an
  exception, bumped, cancelled, archived and expired bookings supply nothing, read
  through the canonical lifecycle helpers rather than a second status list.
- **Exact lodge and exact NZ lodge-night.** Lodge A on Friday covers neither Lodge
  B on Friday nor Lodge A on Saturday, so a stay may be partly covered.
- **Coverage is existential, not an assignment.** Evidence records the source
  booking observed at evaluation time; it never becomes a stored authorisation, so
  another eligible source keeps the dependent booking compliant with no incident
  and no loss-of-coverage message.
- **Ownership is never attendance.** A booking owned by an adult member supplies
  nothing unless a qualifying adult member is actually recorded as attending the
  relevant lodge-night. Any qualifying adult member participant may cover, not only
  the account holder.
- **No capacity is consumed twice** (§15). The covering adult arrives as a
  `hostOnly` participant: their real attendance on their own booking is evidence
  for the dependent booking, and they are never duplicated as a guest on it. The
  source booking's own guests remain that booking's question.
- **Re-evaluation stays bounded** to the same `memberId`, lodge and nights. The
  lodge-wide sweep #2575 rejected is not built. A queue item names one owner, one
  lodge and an explicit night list, so no shape of item can express a wider sweep,
  and a malformed night list yields no work rather than an unbounded read.
- **Coverage is existential, not an assignment.** Stated again because it is the
  invariant most easily broken by an optimisation: nothing stores a permanent
  dependency on a particular person or booking, both `where` builders are re-derived
  from live rows at every evaluation, and evidence naming the source observed once
  never becomes an authorisation.

**Changes that would take cover away (#2576 §6 to §9).** `SAME_BOOKING_OWNER` is
the hard precondition only for CROSS-BOOKING strand checks: without it, one booking
cannot depend on another and there are no dependents to refuse or fan out to. It is
not a licence to skip the booking being changed. Under `SAME_BOOKING` alone, a
confirmation or a change to an attending member's active/age/consent/subscription
qualification can still open or resolve that booking's incident, so own-booking and
member-qualification seams always queue under `ENFORCED`; they take the owner lock
only when cross-booking scope is enabled. The CONSEQUENCE then decides what happens.
Under `ENFORCED`, the full behaviour below.
Under `ADMIN_REVIEW_REQUIRED` nothing is ever refused and no incident is ever
opened — an uncovered booking is a permitted state there and the pending review is
already the officer's signal — but the dependents are STILL re-read. That is the one
staleness this scope introduces which the review consequence cannot catch by itself:
with `SAME_BOOKING` alone a booking's cover can only move through its own rows or its
split siblings, both reconciled on every write, whereas here a change to a DIFFERENT
booking can strand it and nothing else would ever look, leaving it recorded as
compliant indefinitely.

- **An ordinary member's self-service change to their OWN booking is REFUSED** when
  it would leave another booking on the same account uncovered — cancelling, a lodge
  or date change, a participant-night change, removing the qualifying adult member,
  or losing member-guest consent. `SameOwnerCoverageWouldBreakError` is a 409 raised
  from inside the mutation transaction, so the change rolls back, and it names the
  affected booking reference, its lodge and the uncovered nights.
- **The ACTOR is not the owner, and the refusal is gated on the actor** (§6, §11).
  Every booking in the stranded list has the changed booking's `memberId`, which
  makes it the OWNER's booking — it does not make it safe to show whoever made the
  change. The guest DELETE route deliberately admits a member from another account (a
  member-linked guest taking their own row off a CONFIRMED or PAID booking), so the
  refusal is reachable by an actor with no right to see it. `resolveDependentDisposition`
  therefore raises `BLOCK` only when the acting member IS the booking owner, and
  escalates for anybody else: the change is allowed, the owner is emailed, the
  incident is raised, and the actor is told nothing about the other booking. That is
  also the only humane answer — every remedy the message offers belongs to the owner,
  so a refused guest could not have complied by any means available to them. A call
  site that forgets to pass the actor fails towards escalation, never towards
  disclosure.
- **"Newly" uncovered is the test, not "uncovered".** A booking already carrying an
  uncovered state cannot be fixed by abandoning today's unrelated edit, so refusing
  over it would trap the member. The comparison is the shared material-identity key
  (`adultMemberHostingStateKey`) against the dependent's own stored review snapshot
  or its open incident — the same definition that decides whether an officer's
  review decision still applies.
- **An authorised officer is ASKED TO CONFIRM, then ALLOWED and ESCALATED** (§7).
  §7 requires the override to carry the permission, an explicit confirmation, a
  mandatory reason, the affected bookings and nights, and an audit event — and an
  override that is never asked for cannot carry a confirmation or a reason. So an
  officer change that would strand a dependent raises
  `SameOwnerCoverageOverrideRequiredError` (409, `requiresOverrideReason: true`)
  naming what would be stranded. That is a block on the UNCONFIRMED change, not on
  the officer: they re-submit with `hostingCoverageOverride`
  (`{ acknowledged: true, reason, strandedStateKey }`, minimum 10 characters) and
  it proceeds as `OFFICER_OVERRIDE` recorded against their member id with their
  reason on the incident. `strandedStateKey` is the versioned digest of the changed
  source booking plus the sorted dependent-booking/exact-night set the officer was
  shown. The retry re-derives it from authoritative rows under the per-owner lock; a
  changed non-empty set rolls the whole mutation back and returns a fresh prompt,
  so confirmation of one set is never authority over a new booking or night. If
  coverage improved to no stranded bookings while the prompt was open, the change
  proceeds without manufacturing an override audit or an empty confirmation prompt.
  Unknown nested override fields are rejected. Where nothing would be stranded they
  are asked nothing. The affected
  booking keeps its status, its beds and its payments and gets an urgent compliance
  incident; nothing in the coverage machinery writes `Booking.status`, so automatic
  cancellation is forbidden in as many words. Nothing automated can ever be gated by
  this: only surfaces going through `hostingCoverageActorOptions` with a live officer
  session can raise it, and every cron, webhook and lifecycle path passes `ESCALATE`.
  Approving a pending modification-policy exception uses this same two-step path:
  the first attempt stays pending and returns the exact affected bookings and
  nights, while the retry carries its own private `hostingCoverageOverride` reason.
  The member-facing approval explanation is never reused as that authority. The
  booking detail's officer edit and cancellation controls consume the same strict
  client-only prompt contract. They bind the prompt to the complete rejected
  mutation — including shift pricing mode, refund method and the explicit email
  choice — and retire it permanently if any proposal field changes. A retry reuses
  that exact proposal without asking the email question again; a refreshed 409
  replaces the key/list and clears only the private reason and confirmation. The
  affected booking details render only for `viewerAuthorizationRole === "ADMIN"`;
  member self-removal and ordinary draft confirmation never gain this override UI.
- **A change to one PERSON's standing records the check it owes** (§8). "Membership
  becoming inactive, lapsed, cancelled or archived" heads §8's list, and only the
  evaluator half of it is automatic (an archived or cancelled member stops
  qualifying). `enqueueHostingCoverageReevaluationForMember` is the other half, called
  in the same transaction as the archive, account-deletion anonymisation (before
  deactivation and guest unlink remove the attendance evidence), membership
  cancellation, single or bulk active/age-tier changes, consent approval,
  subscription settlement/reversal and member merge repoints. It fans out over the
  bookings that person ATTENDS — not owns (§2)
  — on live current-or-future stays, one bounded item per booking naming THAT
  booking's owner, lodge and nights, so the drain can never widen it into the
  lodge-wide sweep #2575 rejected. Gated on `ENFORCED` and deliberately NOT on the
  scope: a lapse removes cover under `SAME_BOOKING` just as surely, and the drain
  reconciles through the shared evaluator, which honours whichever scopes the lodge
  has on. Member-guest consent loss reaches the same place through the shared removal
  path, which reconciles inside the caller's transaction. Each high-level enqueue
  invocation first proves its exact source owners and non-null actor under one sorted,
  de-duplicated `Member FOR KEY SHARE NOWAIT` statement. A missing member, contended
  row, changed source owner/lodge, or final attribution outside that private proof
  rejects the complete outer mutation with the fixed safe 409; a later call in one
  bulk transaction also fails fast and rolls back the earlier work rather than
  waiting while it holds a different participant set (#2597).
  Before even its first attendance read or empty return, the shared standing
  fan-out locks its subject member `FOR UPDATE NOWAIT`. That exact strength fences
  the lodge-only booking-request hold's linked-member `KEY SHARE`; `FOR NO KEY
  UPDATE` would not conflict and is forbidden. The hold takes its lodge key,
  re-reads the transaction-current request links, locks their exact sorted member
  ids, and re-reads every row as existing, active and unarchived before its
  versioned request claim or any guest creation. Hold-first makes the standing
  mutation retry so its next attempt includes the committed guest. Standing-first
  makes the hold wait and then refuse the inactive/archive row before creation in
  every consequence mode, including `DISABLED` and review-required. Account
  deletion inherits the same central fence after its existing global → affected
  lodge → member-lifecycle prefix; it carries no route-only duplicate.
  Under its target `Member FOR UPDATE`, deletion also re-checks the complete Xero
  contact-create reservation/recovery blocker plus every RUNNING member CONTACT
  UPDATE before anonymising. A member UPDATE first commits a short `FOR KEY
  SHARE` reservation, calls Xero outside transactions, then completes its
  operation and canonical link together under that Member `FOR UPDATE`. Retries
  rebuild from the current Member only; a missing/deleted member never falls
  back to stored pre-deletion PII. The symmetric create reservation, manual Link
  and provider-returned local-link paths re-read
  the canonical deleted-member marker under their own Member lock before any
  provider call or attribution. A deleted account can therefore neither send its
  pre-deletion profile to Xero nor regain a contact link. Manual Link commits the
  Member pointer and FK-less canonical CONTACT ledger row in the same transaction,
  so member merge cannot leave a ledger row naming a deleted losing identity.
  Account deletion deactivates that CONTACT ledger in the same anonymisation
  transaction that clears the Member pointer.
- **Every confirming path re-reads the facts at confirmation, and the census proves
  it two ways** (§9). Most reconcile inside their own transaction, which REFUSES an
  uncovered booking at an enforcing club. Those that cannot — capacity claimed, money
  in flight or settled — record the bounded re-evaluation inside the confirming
  transaction and escalate after commit, which is §8's treatment of payment lifecycle
  and automated status transitions. The set includes the single payment settle door
  (whose payable set includes DRAFT), the fully-credit-covered settlement, inbound
  Xero PAID, the admin waitlist force-confirm, the member's zero-dollar waitlist
  confirmation, the draft confirmation, the
  saved-card auto-charge cron, the officer "confirm pending guests" claim, the
  Internet Banking switch, group-settlement child confirmation, and the
  group-settlement reaper's `CONFIRMED -> PAYMENT_PENDING` revert, which de-confirms
  a coverage SOURCE. `adult-member-hosting-call-sites.test.ts` asserts both who USES
  each seam and — separately — that no confirming write uses NEITHER, because the
  first assertion alone cannot see a path that skips the rule entirely. That
  distinction is load-bearing: DRAFT, WAITLISTED and WAITLIST_OFFERED are all outside
  `ACTIVE_BOOKING_STATUSES` and so invisible to the strand check, making those gaps
  deterministic rather than races.
- **The coverage race and the member-merge attribution race have one ordered
  handshake** (#2576, #2597). The coverage decision is closed by a per-OWNER
  advisory lock (`hosting-coverage-owner`).
  An earlier design argued no new lock was needed because coverage is same-lodge by
  definition, so the per-lodge capacity lock already serialised both sides. That was
  false in both directions at the time: cancellation and booking writers did not all
  share one key. The direct guest-add route now composes global → lodge, but the
  booking-request capacity hold remains a lodge-only active linked-guest writer; the
  shared subject/linked-member row protocol above closes every standing-change edge.
  The invariant itself is per-owner, so the key is the owner (the
  same reasoning behind `lockBookingMemberNights`); it is taken by the evaluator, the
  settle step, the enqueue-only seam and the member fan-out, always LAST after the
  existing global → sorted lodge → roster-date → applicable member tiers and the
  queue-participant Member rows, and only where the scope is enabled. Ordinary seams
  try sorted owner keys before their re-entrant blocking acquisition, so a repeated
  bulk call cannot wait while holding an earlier key.

  Member merge takes the counterpart direction without losing an obligation. After
  its relation moves it plans the bounded survivor-attendance and captured
  loser-owned booking union, locks master, loser and every ancillary owner in one
  sorted `Member FOR UPDATE`, and re-plans under those rows. Drift returns 409; no
  participant is added late. It then takes sorted coverage-owner keys, re-points both
  queue owner and FK-less actor rows that landed after the ordinary relation sweep,
  folds the actual counts into the critical merge audit, creates actorless
  `SYSTEM_CHANGE` work, and only then deletes the loser. Ordinary-first therefore
  commits before the merge sweep, while merge-first makes ordinary `NOWAIT` and roll
  back. Policy CRUD/config-transfer retain their earlier policy-set serialization,
  and notification providers retain #2596's exact-token, post-transaction boundary.
  See [`CONCURRENCY_AND_LOCKING.md`](CONCURRENCY_AND_LOCKING.md).
- **An incident is only ever opened for a booking the club has accepted.** §7 and
  §16 are about a booking that becomes uncovered AFTER confirmation, so the opener
  requires confirmed active attendance. This is load-bearing rather than tidy: the
  auto-charge claims PENDING → CONFIRMED, queues the work, and releases the claim
  back to PENDING if the charge fails — without the test the drain would put a stay
  nobody confirmed in front of an officer as an emergency. It does not RESOLVE a
  standing incident on a regressed booking either, because that booking still holds
  its beds and reporting `COVERAGE_RESTORED` would be untrue.
- **One active incident per booking; owner notification is fenced, at-least-once delivery** (§16). The partial
  unique index `HostingCoverageIncident_active_booking_unique` makes the first an
  invariant against a concurrent second opener rather than a hope; the loser folds
  into the winner instead of surfacing a constraint violation. The stored `stateKey`
  is a fixed-width digest of the material-identity key, so a large party cannot
  outrun the column and make two different problems compare equal. The owner's
  notification takes a short delivery lease with an opaque claimant token before
  the send, but `notifiedStateKey` is stamped only after transport reports success.
  Immediately before provider input is read, a guarded update renews the lease only
  while the incident is unresolved, unnotified, and that exact state/token is still
  current. An expired-but-unreclaimed claimant can therefore continue, while a
  successor token and the old worker race on the row and only one wins. A final exact
  read then freezes recipient data and the incident's own evidence at the renewed
  timestamp; a stale or reclaimed worker calls no provider and never substitutes a
  later live booking review into an older claim. Completion and release match the
  same token, so a stale sender cannot complete or clear a successor's lease. Missing email,
  placeholder/bounce suppression and a deliberate per-booking `noEmails` switch are
  terminal while the incident stays visible to officers. An unreadable `noEmails`
  flag is transient: the notification lease is released and the exact queue claim
  fails, because `hosting-coverage-lost` deliberately has no independent EmailLog
  retry authority. The provider stays outside transactions, leaving only the narrow
  race after the final token read rather than holding a transaction across delivery.
  At most one exact claimant is active for each renewed lease. There is still one
  unavoidable post-provider ambiguity: if the provider accepts the message and the
  process dies before `notifiedStateKey` is stamped, the next lease may send the same
  transition again. The provider has no idempotency-key contract; stamping before
  transport would trade that rare duplicate for a permanently lost notice. This is
  therefore at-least-once delivery with one durable success stamp, not an
  exactly-once email guarantee. A crashed sender's lease expires after 15 minutes.
  The re-evaluation queue uses the
  same 15-minute token fencing for completion and failure, claims serial work one row
  at a time, and excludes ids already attempted by that drain: a slow later item is
  not pre-leased and a released failure cannot burn several attempts in one pass.
- **Resolution is recorded, not inferred**, as one of `COVERAGE_RESTORED`,
  `BOOKING_AMENDED`, `EXCEPTION_APPROVED` or `BOOKING_CANCELLED` — inferring it from
  the absence of a hazard would report restored cover for a booking somebody
  cancelled. Resolution is idempotent (a guarded `updateMany` on `resolvedAt: null`)
  and a club that turns enforcement off has its incidents closed rather than left as
  rows nobody can act on.
- **Three of the four resolutions fire from a change to the AFFECTED booking, and
  that needed its own seam.** The re-evaluation fan-out is built on
  `sameOwnerCoverageDependentWhere`, which excludes the booking being changed
  (`id: { not: booking.id }`), so every list the settle step computes is a list of
  OTHER bookings and nothing done TO an affected booking could reach its own
  incident. `resolveOwnCoverageIncidentAfterChange` closes it, from facts the same
  transaction has just written: the booking is no longer happening →
  `BOOKING_CANCELLED`; an officer has APPROVED its hosting review →
  `EXCEPTION_APPROVED`; the reconciliation that just ran CLEARED the review, so its
  own facts no longer carry the hazard → `BOOKING_AMENDED`. `COVERAGE_RESTORED` is
  deliberately not decided there — it is a fact about ANOTHER booking supplying
  cover, which only the post-commit drain can establish against committed rows.
  `booking-exception-approval.ts` closes the incident in the same transaction as the
  officer's decision for the same reason: an approved exception AUTHORISES the hazard
  rather than removing it, so the drain's "is the violation gone" test can never see
  it, and the next pass would otherwise re-affirm a `critical` incident against the
  officer's own decision. Approval means approval for THIS hazard: a materially
  different uncovered state reopens the review as PENDING and drops the decision, so a
  stale approval cannot suppress a new problem.
- **The queue is at-least-once; database effects are idempotent and provider delivery
  has an explicit ambiguity.** Work is recorded in
  the transaction that caused it, drained inline immediately after that commit
  (best-effort, since the authoritative change must not be undone by a follow-up
  problem) and again by the `hosting-coverage-reevaluation` general-cron job, which
  is the authority on completion. `attempts` increments at CLAIM time, so a process
  that dies mid-item still counts up and a poison item retires. Incident/review and
  queue completion effects are guarded and idempotent; email is the stated
  at-least-once exception when a crash lands after provider acceptance but before
  the durable success stamp.
- **The Booking Officer queue is in the bookings area.** Every unresolved incident
  appears prominently above the ordinary `/admin/bookings` list, with booking
  reference, owner, lodge, dates, uncovered guest-night count, cause and direct
  navigation. The support Stuck States dashboard mirrors the count and oldest 50
  direct rows, but is not the only way to discover or act on the incident. Resolving
  the underlying condition clears the row automatically; there is no separate
  acknowledgement that could hide a still-uncovered booking.
- **The inline drain is scoped to the booking that was just written; the cron drains
  everything.** A member's request passes `{ bookingId }`, which resolves that
  booking's owner and lodge and claims only their items with a small limit. An
  unfiltered inline claim meant that after an officer's bulk cancellation or a
  membership sweep left a backlog, the next unrelated member's guest edit would run up
  to 25 OTHER owners' reconciliations — each fanning out to as many as 25 dependents,
  each able to send a synchronous loss-of-cover email — inside their request before it
  answered. Correctness survived (failures are swallowed and the cron re-runs the
  items) but the route could hang. The job-shaped callers that genuinely span owners —
  a bulk deactivate, a membership archive, the group-settlement reaper and settle, the
  confirm-pending cron — pass a limit instead of a booking, because a group's children
  belong to different joiners and one person can attend bookings owned by several
  accounts.
- **Every path that can ENQUEUE must also DRAIN**, and the census asserts it
  tree-wide rather than against a hardcoded list: any file naming one of the three
  enqueue seams must also name `settleHostingCoverageAfterCommit(`. The
  transaction-scoped helpers are exempt because they run inside somebody else's `tx`
  and have no commit of their own — and a second assertion now PROVES that exemption's
  premise by checking their callers, which is how the member-guest consent decline and
  expiry path was caught reconciling through the shared removal service and committing
  without draining.
- **The dependent reads have their own ceiling, ordered and logged.** The
  safe-failure argument for the SOURCE read inverts for them: a truncated source read
  sees fewer hosts and errs towards flagging, while a dependent dropped by the ceiling
  is neither refused under `BLOCK` nor enqueued, and the drain silently skips it. So
  `SAME_OWNER_COVERAGE_DEPENDENT_LIMIT` is a separate constant that cannot be tuned by
  somebody reasoning about the other one, both reads order by `checkIn` then `id` so
  the truncation is reproducible rather than whatever 25 rows Postgres returned, and
  `warnIfCoverageDependentCeilingBound` logs owner and lodge when it binds.
### The officer-note split on booking requests (#2562)

A Booking Officer's decision carries **two** notes, and which audience reads which
is an invariant, not a convention. It is **table-wide**, which means all three
officer surfaces that decide a request on these tables and not just the
policy-exception one: `BookingChangeRequest` holds both kinds of row, and its
LOCKED_PERIOD half is decided from a different panel
(`booking-change-requests-panel.tsx` → `PATCH
/api/admin/booking-change-requests/[id]`) that writes the same column.

- `adminNotes` is **member-visible**, on both request tables and for both kinds of
  `BookingChangeRequest` row. It is the decision explanation, written for the
  member: rendered on their own request list, on their booking page under "Change
  Requests", and interpolated into the approval and refusal emails. Every officer
  screen labels it as member-visible *before* the decision is submitted, so nobody
  discovers the audience afterwards. A box headed only "Admin notes" over this
  column is a defect — it is what let an officer type a judgement about a member
  into the sentence that member then read verbatim.
- `internalNotes` is **never member-visible**, on either table or either kind. It is
  the officer's private commentary — a judgement about the member, a reference to
  somebody else's booking, a note for the next officer — and is read only by
  admin-guarded surfaces (the two officer queues and the per-request detail
  endpoint, all behind `requireAdmin`). Every officer surface that offers the
  member-facing field offers this one beside it, because an officer with no private
  field writes private things in the public one.

Four structural properties hold that boundary, so it does not depend on any single
call site remembering it:

1. **The member DTO has no slot for it.** `toMemberExceptionRequestItem`
   (`src/lib/member-exception-requests.ts`) is a strict allowlist that never spreads
   a row, and its INPUT type does not accept `internalNotes` — handing the private
   note to the member projection is a typecheck failure, not a privacy incident.
2. **Every member-reachable read names its columns and omits the column.**
   `readMemberExceptionRequests` does, and so does every handler on
   `/api/bookings/[id]/change-requests` — GET **and** POST — through the shared
   manifest in `booking-change-request-member-view.ts`, whose census test proves the
   two halves of the manifest cover the whole scalar enum. So a column added to the
   model fails that test until somebody decides in writing whether a member may read
   it, and on the member path there is nothing in memory for a later mapper edit to
   leak. The member's booking page selects `adminNotes` and not `internalNotes`.
3. **No email, notification or member-facing template names it.** The approval and
   refusal emails compose their optional line from `adminNotes` alone.
4. **The audit log records its EXISTENCE, never its text**
   (`internalNoteRecorded: boolean`). The audit trail is read by more surfaces than
   the officer queue, and copying the text there would make it private in one place
   and not the other.

**A private note is never a substitute for the member-facing one.** Refusing a
policy-exception request still requires `adminNotes`, and so does approving an
adult-member hosting exception (D-R4's reason-for-the-record): a refusal the member
cannot read is a refusal they cannot act on. The exception decision route says so
in its own 400 message rather than silently accepting an internal note in its
place, and the locked-period panel keeps BOTH decision buttons disabled until that
request's own member-facing field is filled in. "That request's own" is part of the
rule, and it is held STRUCTURALLY rather than by a marker: the panel draws every
open request's form at once and keeps **one draft per request id**
(`decisionDrafts[request.id]`), which each field reads, writes and submits from, so
a note begun against one request is neither submitted with another nor able to
unlock another's buttons — whichever field is typed in, in whatever order. Two
earlier shapes both failed that: the original guard read
`reviewingId === request.id && !adminNotes.trim()`, which left every untouched row
decidable with no explanation at all; the shared-slot repair that followed still let
the internal-note and modification-id handlers move the ownership marker while the
previous row's sentence sat in the shared slot, so a keystroke on one card put
another member's explanation into this card's field, unlocked its buttons and posted
it under that member's request. The sibling policy-exception queue is an accordion
(one `openId`, one mounted form, draft reset on open) and its decision path refuses
to act for any card that is not the open one.

The column is an expand-only addition
(`20260803040000_add_policy_exception_internal_notes`), nullable with no backfill on
both tables, so a decision written by an older deployment carries `internalNotes`
NULL — which reads correctly as "the officer left no private note", because that
deployment had no field to write one in.

### The member's own request area (#2562)

The member-facing projection of an exception request states only facts, never
intentions:

- **Capacity comes from the reservation ledger, never from the policy's capacity
  mode.** `capacityHeld` is true only where live `PolicyExceptionReservationNight`
  rows exist. It is therefore false for **every** new-booking request whatever its
  mode says (the ledger keys to an existing `BookingChangeRequest`, and there is no
  booking yet), and false for a modification whose incremental footprint came out
  empty — a pure shrink. The generic sentence "your beds are held while we review"
  is false for the whole new-booking population and appears nowhere.
- **A recorded conflict is reported, not hidden.** A `REQUESTED` row with
  `lastConflictAt` set reads as "an officer tried and the lodge was full", never as
  "nobody has looked". Those are different facts and the second is one the member
  would act on.
- **Approval is never described as the moment beds are secured**, on either the
  pending or the approved sentence. An approval creates the booking the member's own
  wizard would have created (PENDING or PAYMENT_PENDING), which holds nothing until
  it is paid, so a pending new-booking row says availability is rechecked at review
  *and* that an approved new booking still holds no beds until it is paid.
- **The created booking is described from TWO facts about its own row**, both
  established by the caller and neither derived from the other:
  `createdBookingHoldsCapacity` (`bookingHoldsCapacity`) and
  `createdBookingAwaitsPayment` (still inside `ACTIVE_BOOKING_STATUSES`). "Holds no
  beds" is equally true of an unpaid booking and of a cancelled or reaped one, so the
  instruction to open it and pay it is conditional on the second fact; a closed
  booking gets a sentence that says it is no longer live, and an unreadable one gets
  the rule with no instruction at all.
- **Withdraw and replace are offered only where the API would accept them**,
  derived from the same `status = REQUESTED` condition the cancel and supersede
  services' guarded claims name.
- **The request action is offered only where the SERVER classified the refusal as
  reviewable.** One shared rule (`readExceptionOffer`,
  `src/lib/booking-exception-offer.ts`) decides it for both wizards, and it fails
  closed: an allowlist of reviewable refusal codes that can never contain a
  hard-stop code, a required non-empty `exceptionReview`, the server's own
  `exceptionEligible: true` on every violation, and a known capacity mode. One
  unrecognised violation disqualifies the whole refusal, because a request can only
  override the rules it froze.

### Subscription-lockout booking pricing (#2533)

**Owner decision (2 Aug 2026), extending the #2364 lapsed-member framing.** The
same idea #2364 applies to a lapsed member — "not a member in good standing is,
for this rule, a non-member" — is extended to the money axis for an unpaid
subscription:

> A subscription-locked member can still book for others in their family, but if
> that individual's subscription is not paid they get charged **non-member
> rates** (and are **told why**), and there still has to be **at least one
> paid-up adult member on the booking**.

**Three rules, one predicate reused.** The pure evaluator lives in
`policies/subscription-lockout-pricing.ts` and mirrors the hosting evaluator's
shape (facts in, decisions and member-facing sentences out, no I/O):

- **Unpaid member → non-member rate.** A member (`isMember`) for whom the
  booking-time gate says a subscription is *required* this season
  (`requiresPaidSubscriptionForMemberForBooking`, which already folds in the
  Xero-off bypass, membership-type opt-outs and the per-age-tier rule) and whose
  subscription is *not* PAID prices at the built-in NON_MEMBER rate. This is the
  existing `rateSource: "TYPE_POLICY_FORCED"` resolution
  (`resolveGuestRateMembershipTypes`), so it routes the correct non-member Xero
  item code with no new pricing or invoicing path — the same route a
  `NON_MEMBER_RATE` membership type already takes.
- **At least one paid-up adult member present.** A qualifying participant is a
  #2364 host (active, uncancelled, unarchived, ADULT, operationally present) whose
  subscription is ALSO settled (PAID, or not required for them).
  `participantQualifiesAsHost` is reused verbatim and the subscription fact ANDed
  on top, so the standing half can never drift from the hosting rule — a lapsed
  adult with a paid subscription fails on standing, a paid-up-membership adult
  with an unpaid *subscription* fails on money, and only somebody clear on both
  counts satisfies the requirement. An empty party fails.
- **Told why.** Two member-facing sentences name neither a person nor an amount:
  the rate reason states that member rates are unavailable while the subscription
  is unpaid and how to restore them; the refusal names the two escape routes
  (renew, or add a paid-up adult). The rate reason is surfaced today, read-only,
  on `GET /api/member/subscription-status` (`memberRateNotice`), worded to be true
  under BOTH the current hard-block lockout and the decided non-member-rate
  direction so it never over-promises a booking.

**Enforcement is wired, behind one club setting (#2543).**
`MembershipLockoutSettings.mode` (`SubscriptionLockoutMode`) picks between three
mutually exclusive answers, and it is the ONLY thing that can move a club's money
here:

- **`NO_BLOCK`** — no subscription gate at all; unpaid members book at member
  rates.
- **`HARD_BLOCK`** — the historical behaviour: 403 `SUBSCRIPTION_REQUIRED` /
  `GUEST_SUBSCRIPTION_REQUIRED` on the create, confirm-draft, modify-quote,
  guest-add and group-join paths. **The effective default**, so no club moved.
- **`NON_MEMBER_PRICING`** — the rule above: the unpaid member is repriced, told
  why, and the booking must carry a paid-up adult member.

**Independent booking failures are reported together.** A member create or member
group-join can fail both the paid-up-adult rule and enforced adult-member hosting on
the same party. Those paths evaluate both before returning and answer with
`BOOKING_POLICY_REQUIREMENTS_NOT_MET`, both allowlisted `reasonCodes`, and one
aggregated `exceptionReview`; they do not stop at whichever evaluator happened to
run first. The hosting half passes through `buildAdultMemberHostingRefusalBody`
before aggregation, so its internal qualifying-host member ids never enter a
member-facing combined response. A single failure keeps its existing response code
and shape.

**Nothing moved on the release that shipped this, and `mode` is the ONLY record of
the policy.** Owner directive on #2561: the change completes in one release rather
than keeping dual-read/dual-write compatibility alive for a later contract release.
Two migrations, one deploy:

- `20260803000000_subscription_lockout_three_way_mode` (expand) adds the enum and a
  nullable `mode`;
- `20260803010000_contract_subscription_lockout_drop_enabled` (contract) BACKFILLS
  `mode` from the legacy boolean (`true → HARD_BLOCK`, `false → NO_BLOCK`), makes it
  `NOT NULL DEFAULT HARD_BLOCK`, and DROPS `enabled`.

So a club that had deliberately switched the lockout off stays off, and one that had
it on keeps hard-blocking — but that mapping now lives in the migration rather than
in a read-time fallback. `normalizeMembershipLockoutSettings` has no legacy branch:
a recognised `mode` wins, and the only null left is "no settings row exists at all",
which resolves to the same `HARD_BLOCK` the column defaults to. The backfill's
correctness is pinned against real rows by
`prisma/migration-verification/20260803010000_contract_subscription_lockout_drop_enabled.ts`,
whose mutants include the two that would move a club's money: an inverted mapping,
and an unconditional `HARD_BLOCK` that would silently re-enable the lockout for every
club that had turned it off.

**That drop needs a maintenance window, and the ledger says so.** The contract row is
the repo's first `old_code_compatible=windowed` declaration: the previous release's
Prisma client names `enabled` on every read of this model, and the booking gates
resolve the policy through that read, so the old colour cannot take a booking between
migrate and cutover. Verified rather than assumed — a client generated from the
previous schema fails with `The column MembershipLockoutSettings.enabled does not
exist in the current database`, and recovers after the `rollback.sql` that ships
beside the migration (`NO_BLOCK → false`, `HARD_BLOCK` and `NON_MEMBER_PRICING →
true`, plus `mode` back to nullable-without-default). Deploy sequence in
`DEPLOYMENT.md` → "Windowed migrations"; rehearsal transcript in
`docs/PRODUCTION_UPGRADE_RUNBOOK.md` §7.1.

**Bundle-format compatibility outlives the column.** A configuration bundle exported
before #2543 carries `enabled` and no `mode`, and those files are still on operators'
disks. `enabled` is no longer an exported field, so config-transfer's `reconcile`
hook maps the bundle KEY to the mode it means on the way in. Without it the key would
be an unknown field, silently dropped, and a club importing a pre-#2543 bundle to
turn the lockout off would be told it worked while every unpaid member went on being
refused. The reverse derivation is gone with the column: there is no boolean left to
write back.

**The mode is resolved once per request and passed down - to the money as well as
to the gates.** Every consumer reads it through `member-subscription-eligibility.ts`:
`resolveSubscriptionLockoutMode()` outside transactions (it reseeds the
financial-year cache, which can reach Xero), and `peekSubscriptionLockoutMode()` as
the FALLBACK for a caller that holds none. Each write path resolves the mode once and
hands it to `evaluateNonMemberPricingRequirements` **and** to
`resolveGuestRateMembershipTypes` / `priceBookingGuestsWithMembershipTypePolicy`
(`subscriptionLockoutMode`); `prepareGuestPlan`, `calculateModifiedPricing`, the
waitlist sweep and `removeBookingGuestInTransaction` take it as a value their
in-transaction code cannot reach for the database to obtain. Two reasons, both
correctness rather than speed:

- **Consistency.** An independent read per pricing call let an admin's mid-request
  save have the route gate branch on one regime and the price be computed under the
  other - the "priced as a member here, refused there" drift #2543 exists to remove.
  `modify-quote` performs seven or more pricing passes in one request and differences
  two of them into the member's settlement delta, so a save landing between those two
  made the delta wrong by the whole member/non-member spread on every remaining guest.
- **Connections.** The pricing gate runs inside booking transactions that hold the
  per-lodge capacity lock. Reading the two (uncached) settings rows through the module
  client there checks out a SECOND pool connection underneath the lock, which
  `docs/CONCURRENCY_AND_LOCKING.md` names as the pool-starvation shape and forbids
  twice by name for `validateMinimumStay` and `loadAdultMemberHostingPolicy`. Being
  handed the mode removes that read entirely, in every mode, for every club.

**A failed mode read fails the request; it never quietly charges member rates.** The
reprice resolver does not swallow errors from the mode read - an empty reprice set
means "member rates", so a transient pool timeout would have undercharged an unpaid
member permanently and invisibly (the rate is snapshotted per guest row) on a booking
the route gate had already waved through. One leniency remains, and it is inherited
rather than introduced: `loadEffectiveModuleFlags` swallows its own database errors and
returns every module DISABLED (logging at error level), which resolves to `NO_BLOCK`.
`main` has the identical outcome through `isSubscriptionEnforcementActive` - a failed
flags read there skips the hard block and the unpaid member books at member rates just
the same - so #2543 neither widens nor narrows it.

**The financial-year reseed is gated on the Xero module, not on the mode.** A club that
has deliberately switched the lockout off resolves `NO_BLOCK` — from the `mode` the
contract migration backfilled out of its old boolean — with Xero still on, and every
request-path reseeder in the tree routes through
`resolveSubscriptionLockoutMode` (the booking write paths, `findUnpaidMemberGuests`, the
member notice builder). Gating the reseed on `mode !== "NO_BLOCK"` therefore left such a
club with no request-path reseed at all: after a container restart `getSeasonYear` and
`computeAgeTier` would resolve against the March default instead of the club's real
year-end month, and the rate resolved for a booking can differ from the correct one. The
reseed runs before the mode is consulted, restoring the pre-#2543 condition.

**Only the refusals are mode-gated, never the lookups.** `findUnpaidMemberGuests`
/ `findUnpaidMemberGuestNames` still run under `NON_MEMBER_PRICING`: they are what
raise the D-8 neutral refusal for an unpaid member guest from beyond the booker's
family, and that privacy boundary is not the lockout policy's to relax.

**There are SIX mode-gated refusal sites, not five.** The five route-level gates
(create, confirm-draft, modify-quote, guest-add, group-join) plus `prepareGuestPlan` in
`booking-modify-plan.ts` - the APPLY half of the edit flow whose preview is
`modify-quote`, reached from `modifyBookingBatch` and therefore from
`POST/PUT /api/bookings/[id]/modify`. Ungated, it hard-blocked an unpaid member guest in
every regime, so a member was quoted the non-member price with an explanation and then
refused on save with the pre-#2543 403: an edit that could never complete.

**The paid-up-adult requirement is evaluated on REMOVALS too, not only on additive
writes.** Otherwise any party reached the forbidden state in two requests: book with a
paid-up adult member (allowed - the unpaid member repriced on the strength of their
presence), then remove that adult, with nothing to re-evaluate and no review raised. It
is now evaluated over the whole PROPOSED party on the apply path (`prepareGuestPlan`,
which covers adds, removals and date changes in one place) and over what is LEFT on
`DELETE .../guests/[guestId]`. A **consent DECLINE or EXPIRY is exempt** and always
allowed through: D-14 requires that a member who has declined can be taken off, and
refusing it would trap them on a booking they have refused. An ADMIN is skipped as on
every other #2543 gate. What stays gated is the case the rule is about - the booking
owner, or a member self-removing, choosing to take the party's last paid-up adult member
off it.

**The waitlist is the sixth money path and now carries both halves.** The offer sweep
prices through the same gate, so it inherits the reprice, and it passes NO locked night
prices - the whole stay re-bases at current rates and the result is WRITTEN to the
stored booking. Both safeguards now reach it: the offer email states the repriced figure
**and** the reason for it (`subscriptionMemberRateNotice`, rendered from the shared
sentence), and `confirmWaitlistOffer` re-checks the paid-up-adult requirement before the
claiming transaction - outside it, like the minimum-stay check beside it - failing closed
WITHOUT consuming the offer, so the member keeps their place and can fix the party or ask
a Booking Officer instead of the offer being burnt. That refusal answers 409 with the
shared refusal body, not a bare message.

**D-12 is applied on every path, and from the real column.** A member guest whose invite
is still PENDING is not operationally present and therefore cannot be the party's paid-up
adult - otherwise the requirement is trivially satisfiable, since the invite need never be
accepted, and the D-4 sweep later removes the row, leaving a confirmed booking with no
paid-up adult member on it. The Prisma column is `BookingGuest.consentStatus`;
`toSubscriptionLockoutParticipants` reads that for a persisted row and the planned
`memberGuestConsent.consentStatus` for a pre-persist one, so the create path (whose
`guestInputs` already carry the PENDING columns `planMemberGuestConsentWrites` is about to
write) and the guest-add path share one mapping instead of each inventing their own. The
two PREVIEW surfaces hold no consent row, so they derive the same answer from the three
facts the writer would use - a cross-family member guest lands PENDING exactly when the
module is on, the club requires approval, and the actor is a member rather than an admin
acting for them - which is what stops a quote staying silent about a party the save then
refuses. The exception-request re-evaluation takes an explicit `operationallyPresent` per
proposed guest for the same reason: without it a member refused on a booking path could
not reproduce the violation, the request machinery would find nothing to review, and the
409's promised override path would lead nowhere.

**Xero narrates the rate, not the membership flag.** The hut-fee line's
`(TIER, Member|Non-member)` label is derived from `BookingGuest.rateMembershipTypeId`
(`describeGuestRateMembershipLabel`), the same field `resolveHutFeeItemCode` keys on, so
the words on the line agree with the item code the line is coded to. A repriced member
therefore reads as an ordinary non-member line (owner decision, 2 Aug 2026), instead of
"(ADULT, Member)" at the non-member amount inside the non-member item - a contradiction
both the treasurer reconciling member against non-member hut-fee income and the member
receiving the invoice could see. `BookingGuest.isMember` is deliberately NOT moved by the
reprice; it stays load-bearing elsewhere. Known and accepted consequence: the
pre-existing `TYPE_POLICY_FORCED` class flips to ", Non-member" too, because no persisted
marker distinguishes the two reasons for pricing on `NON_MEMBER` rows - and the new
wording is the honest one for that class as well, whose line has always been coded to the
non-member item at the non-member amount. Narration only: no amount, item code, account
code or idempotency key changes, and a guest with a NULL snapshot still falls back to
`isMember`.

**The reprice happens at the single pricing gate**, not at the five write paths.
`resolveGuestRateMembershipTypes` is the one function all ~25 booking-pricing call
sites already pass through, so "consistent across every write path" is a
structural property rather than a review checklist.

**The paid-up-adult requirement has two triggers, and is still not
unconditional** (second trigger: owner decision, 3 Aug 2026). It applies when

- somebody STAYING on the party is being repriced for an unpaid subscription, or
- the **booking owner** is an unfinancial member — whether or not they stay.

Both are judged by the one owing test (`resolveMemberSubscriptionSettlement`, via
the single settlement batch in `evaluateNonMemberPricingRequirements`), so the
owner cannot be judged by a different rule than the party. The owner joins the
FACTS batch only, never `repricedMemberIds`: an owner who is not staying holds no
nights, so counting them as repriced would inflate the violation's count and emit
a rate notice about a charge nobody received.

**Why the second trigger.** `HARD_BLOCK` refuses an unfinancial member *as a
person* — they cannot book at all, even for a party of non-members they will not
join. Keyed only on who stays, `NON_MEMBER_PRICING` let exactly that booking
through with no reprice, no requirement and no notice, so switching a club to the
softer rule quietly opened the one case the strict rule most reliably closed, and
lapsing cost a member nothing so long as they booked for others. In that case the
new trigger is still **gentler than `HARD_BLOCK`, not stricter**: a flat 403
becomes a 409 with an override door and the beds held. An unfinancial owner can
never satisfy their own requirement (they fail the money half of
`participantIsPaidUpAdultMember`), and a paid-up adult member in the party
satisfies it exactly as before — which is what keeps the intended family case
booking.

**Still not unconditional, and that scoping remains load-bearing.** Applied to
every booking in the mode, the requirement would newly refuse bookings that are
legal today and have nothing to do with subscriptions: a paid-up Youth member
booking their own bed, a family whose only member row is a child, an
all-non-member party booked by a financial member. None is touched by either
trigger. "Is a responsible adult member present?" in the general case is
`ADULT_MEMBER_HOSTING_REQUIRED`'s question (#2364), configured per lodge; the two
compose, and a party can trip both.

**`memberRateNotice` follows the reprice, not the requirement**, now that the two
are different questions. An unfinancial owner who is not staying triggers the
requirement with nobody repriced, and the notice claims member rates "aren't
available for those nights" — a statement about a price nobody was charged. That
party gets the refusal (or the quote's early warning) and no rate notice.

**The cross-lodge promotion is the seventh money path, and reached none of the
rule.** `confirmCrossLodgeWaitlistOffer` calls `createConfirmedBooking` DIRECTLY,
so the create route's gate never ran, while the offer sweep had already re-based
the entry's stored price at current rates and inherited the reprice — a party the
create route would have refused could be promoted here and charged non-member
rates instead. Fixed as Phase 0b, with the same semantics as its same-lodge twin:
the mode and the party are read before Phase 1 opens the transaction that holds the
offered lodge's capacity lock; the requirement is judged against the OFFERED lodge,
since that is where the booking will exist; a violation fails closed WITHOUT
consuming the offer (the entry reverts to `WAITLISTED` so the member keeps their
place) and answers with the shared refusal body, which the waitlist-confirm route
already maps to a 409 with no cross-lodge special case. The rate notice rides the
success result too, because a cross-lodge quote can differ from the member's own
lodge by the whole member/non-member spread.

**The two waitlist paths refuse with one shared sentence the booking paths do not
use.** `formatMissingPaidUpAdultWaitlistRefusal` appends "You've kept your place on
the waitlist." to the shared refusal, and both waitlist paths call it so their
answer cannot depend on which lodge the sweep offered. It is scoped to them because
they reject the offer WITHOUT consuming it — neither revert touches
`waitlistPosition`, so the claim is literally true — while a booking-time refusal
has no waitlist place to claim. The frozen violation's own `message` is deliberately
unchanged: it is hashed into exception snapshots and read by the reviewing officer,
so `details`/`violations`/`exceptionReview` keep the policy's wording while `error`
carries the member's. The waitlist-confirm route therefore places
`error: result.error` AFTER the shared-body spread — the body carries its own
`error`, and spreading it last silently discarded the waitlist sentence.

**Every write path passes the owner**, because the requirement is a property of a
set of call sites rather than of behaviour: a path that forgets it silently
enforces the old repriced-only rule while every other path's tests stay green.
`subscription-lockout-call-sites.test.ts` counts the owner argument against the
evaluation calls, file by file. The exception-request re-evaluation resolves the
owner **server-side** — a modification reads the live booking's own `memberId`
rather than trusting the requester to be it — so a refusal that keys on the booker
reproduces there and the 409's door actually opens.

**The refusal is a door, not a wall.** A missing paid-up adult raises
`PAID_UP_ADULT_MEMBER_REQUIRED` — **409, not 403**, deliberately outside
`HARD_STOP_BOOKING_FAILURE_CODES`: the booking *is* permitted, by a Booking
Officer, through the #2363/#2365 exception-request workflow. The violation is
frozen with `capacityMode: "HOLD"` (owner decision 4), so a pending override keeps
the beds rather than making the member race for capacity while an admin reads
their request. `requirements` carries **counts and no identities** — every field is
rendered back to the refused member, and naming who is unpaid would turn a booking
refusal into a financial-status oracle. The fingerprint follows: it hashes the
hazard ("this party has nobody paid-up on it"), not who, so re-saving the same
party shape does not reopen a decided review.

**The FROZEN violation shape is unchanged by the owner trigger; the member-facing
RESPONSE is audience-scoped instead.** An owner-triggered refusal reads
`repricedUnpaidMemberCount: 0`, which discloses that the trigger was not a member of
the party. On ten of the eleven enforcement sites that is a fact the recipient
already holds, because the unfinancial member IS the person receiving the refusal:
create, quote, confirm-draft, modify-quote, guest-add, the modify apply path and
both waitlist confirms all run for the booking's own owner, an admin is exempt from
the check entirely, and the group-join gate passes the JOINER as the owner of the
booking being made rather than the group booking's owner. The eleventh is
single-guest removal, where a member may take their own guest row off **somebody
else's** booking — there the refusal can reach a member of another family while the
trigger is the booking owner's unpaid subscription, which they can see nowhere else
in the app. So `buildPaidUpAdultRefusalBody` takes an audience and the removal path
asks for `OTHER_PARTY_MEMBER` when the actor is not the owner: identical refusal,
wording, HOLD and override door, with that one count withheld. The frozen violation
keeps both counts because the open-state fingerprint is hashed from them, so
redacting there would change which refusals count as the same hazard; only the copy
rendered to the member is narrowed, and no snapshot's shape moves.

**A violation must name the nights it holds.** When the owner arm fires on a party
that yields no nights of its own, `affectedNights` falls back to the booking
envelope: a `HOLD` over zero nights would reserve nothing while promising the
member their beds. Unreachable on the reprice trigger, which implies a member
participant.

**A repriced member stops counting as a host** (owner decision 3). Under
`NON_MEMBER_PRICING` the booking-side loader stamps
`HostingParticipant.subscriptionSettled = false` on them, and
`participantQualifiesAsHost` refuses them — somebody the club is charging as a
non-member is not the responsible member the hosting rule asks for. **Absent means
settled**, so under the other two modes the field is never populated and the
hosting answer is byte-identical to pre-#2543. Deliberately asymmetric, and
narrower than the lapsed-member rule: `participantIsNonMemberGuest` does NOT read
the field, so an unpaid member's own nights do not become uncovered guest-nights
needing admin review. A lapsed membership is gone; an unpaid subscription is a
membership in good standing with a bill outstanding.

**`NON_MEMBER_PRICING` is a relaxation, with two narrow exceptions - stated because
the blanket claim is not true.** It removes hard refusals rather than adding them. But
the paid-up-adult requirement is evaluated over the WHOLE party, while the pre-#2543
gates looked only at the guests a request was ADDING, so two parties that pass today can
land on the new 409:

1. **confirm-draft** has no member-guest subscription gate on `main` at all, so a draft
   owned by a paid-up Youth member containing an unfinancial member guest confirms today
   and is refused under `NON_MEMBER_PRICING`.
2. **modify-quote and `.../guests`** gate added guests only, so a member already on the
   booking with an unpaid subscription can trip the requirement on an edit that has
   nothing to do with them.

Both land on a 409 with an override door and a HOLD on the beds - not a wall - and
neither is closed by adding a new HARD_BLOCK gate, which would change today's behaviour
for clubs that have not adopted the mode. The honest claim is: no HARD_BLOCK refusal
becomes stricter, and these two cases become reviewable rather than impossible.

**The owner trigger adds no third exception**, and the arithmetic is worth stating
because it looks like it should. An unfinancial member booking beds for others is
refused OUTRIGHT under `HARD_BLOCK` today (403 `SUBSCRIPTION_REQUIRED`, keyed on the
booker as a person). Under `NON_MEMBER_PRICING` they now get a 409 with the override
door and the beds held. That is strictly gentler than the behaviour it replaces, so the
list above stays at two. What the trigger IS stricter than is the interim repriced-only
build of #2543, which never shipped: the gap was closed by owner decision before the
mode reached a club.

**Config-transfer maps the legacy bundle KEY, and a broken one fails the dry-run.**
There is no `(mode, enabled)` pair to reconcile any more — `enabled` is neither a column
nor an exported field — but a bundle exported before #2543 still carries the key, and it
still records a real decision. Left unmapped it would be an unknown field: the importer
writes only fields physically present in a bundle (dropping null-valued ones in the
default merge mode) and type-checks only names in the spec's `fields`, so the key would be
silently dropped, the target would keep its own `mode`, and the dry-run would report no
change to the policy. A club importing a pre-#2543 bundle to turn the lockout off would
have been told it worked while every unpaid member went on being repriced and refused. So
the singleton spec's `reconcile` hook maps the key to the mode it means (`true →
HARD_BLOCK`, `false → NO_BLOCK` — the same mapping the contract migration applied to live
rows), on the one code path both the dry-run and the apply use, and it also covers the
bundle a post-#2543 club exported before an admin ever opened the panel
(`mode: null, enabled: false` → `NO_BLOCK`).

Two properties of that hook are load-bearing. It derives ONLY into an absent-or-null
`mode` and never over a value the bundle states, so a hand-edited `"MAYBE"` is refused by
name by the DMMF enum check rather than silently corrected into whatever the legacy boolean
said. And it runs BEFORE the field-validation loop, which is what lets `mode` carry
`required: true` now that its column is `NOT NULL`: `required` fires only on a PRESENT
null, so a pre-#2543 bundle (no key at all) is untouched, a `mode: null` beside an
`enabled` has a real mode by the time the loop sees it, and the one remaining shape —
`mode: null` with nothing to derive from, i.e. a hand-trimmed or partially-written file —
fails the dry-run as an error instead of aborting the whole import transaction on a
write-time Prisma exception. The reverse derivation is gone with the column: there is no
boolean left to write back, and `enabled` never reaches Prisma. No format-version bump is
needed either — an old bundle imports to the right policy rather than to a guess, so there
is nothing for a version gate to refuse.

**Reversal:** set the mode back to `HARD_BLOCK` (or `NO_BLOCK`) in Admin →
Subscription lockout. No migration, no code change, and no already-taken booking is
re-priced — the rate is snapshotted per guest row as it always was, and a guest who
keeps a locked night keeps their snapshot too. Two stored-money exceptions, both
pre-existing behaviours the mode inherits rather than introduces: the waitlist offer
sweep re-bases a WAITLISTED entry's stored price at current rates before the member
confirms (which is why the offer email now states the reason as well as the figure),
and any edit the member themselves makes prices its NEW nights at today's rates. The
paid-up-adult half keys off the same standing predicate as #2364, so a reversal of
*that* half is #2364's reversal (drop the standing clauses from
`participantQualifiesAsHost`), never a narrower one here.

Issue #1668 adds an **admin-only override** (`adminOverride`, honoured solely when
`bookingManagementAuthorizationRole(session.user) === "ADMIN"`, i.e. Full Admin
or Booking Officer) that lifts those date-window locks so an admin can move the
dates of an in-progress or fully-past booking. The override is **date-only**:
the modify / modify-dates / modify-quote endpoints reject any guest, promo, or
name field submitted alongside the flags ("Admin override edits change dates
only"), and status eligibility (`canModifyBookingStatusForRole`) plus the
per-lodge capacity lock still apply. Members and officers-without-`bookings:edit`
see byte-for-byte unchanged behaviour whether or not the flag is present. An
override requires an explicit `pricingMode`:

- **shift** — a pure relocation: the night count is held constant (a provided
  single bound derives the other), every cent is frozen (booking totals,
  per-guest `priceCents`, and each translated `BookingGuestNight.priceCents`
  move with the stay), and there is no change fee, settlement, Stripe, or Xero
  activity. The `BookingModification` row is `ADMIN_DATE_SHIFT` with
  `priceDiffCents`/`changeFeeCents` = 0. All date math is date-only
  (`addDaysDateOnly` on date-only-normalised bounds, per the stay-boundary
  invariant's storage-encoding note), so the delta is
  DST-safe. The member-facing change-notification email is an explicit
  per-action admin choice on **every** admin edit — not only overrides (#1696).
  Whenever an admin / Booking Officer saves a booking edit (dates, guests, or
  promo, override or plain), a dialog asks whether to email the member ("Save
  and email member" / "Save without emailing"); the choice is recorded in the
  audit metadata (`notifyMember`) and an admin/API caller that omits the flag
  defaults to notifying. A member editing their own booking always sends the
  change email, and a non-admin actor can never suppress it — the modify /
  modify-dates routes 403 any `notifyMember` flag from a non-ADMIN caller
  (pricing/capacity override flags still require `adminOverride`). A recalculate
  override that moves money still respects the admin's choice — the amounts
  remain visible on the booking and in Xero regardless. The same per-action
  choice covers the two remaining admin-driven member-facing emails (#1705):
  the standalone **guest-removal** route (`DELETE /api/bookings/[id]/guests/
  [guestId]`) and **cancellation** (`POST /api/bookings/[id]/cancel`, "Cancel
  and email member" / "Cancel without emailing" — the suppression also covers
  the linked provisional split children cancelled with the parent). Both routes
  403 the flag from any non-(booking-management)-ADMIN caller, force notify for
  non-admin actors (cancellation at the service — `cancelBooking` — and guest
  removal in the route handler itself), default to notify when the flag is
  absent, and record a suppressed send as `notifyMember: false` in the audit
  metadata;
  refund/credit settlement, audit, booking events, waitlist processing, and the
  admin-facing alerts are never affected by the choice. **The Xero invoice
  email on the Internet Banking path is deliberately outside this choice and is
  ALWAYS sent** (superseded for the per-booking "No emails" switch — see
  that section below) — it is the member's payment instruction (invoice number + bank
  details), so suppressing it could strand an unpaid invoice the member was
  never told about (owner decision on #1705). Three further cancellation
  emails are **deliberately always-notify** and outside the choice (owner
  decision 2026-07-10, #1730): the joiner emails when a **group organiser
  cancels** the group, the member email on an **admin review-rejection**
  cancel, and the cancellation emails sent by **deletion-request cleanup** —
  in each, the recipient is losing a booking they own, and a missed email
  risks a member arriving for a stay that no longer exists. (All three are
  nonetheless withheld by the per-booking "No emails" switch — see that section
  below — which overrides every always-notify rule on this page.)
  The #1780/#1769b sweep extends this same per-action choice to every remaining
  admin-initiated member email — membership application approve/reject (#1786),
  membership cancellation review (#1787), member archive review and
  account-deletion reject (#1788), family-group child-request and group-create
  approve/reject (#1789), booking review approve/reject (#1790), booking-request
  decline (#1791), and refund-appeal approve/reject (#1792) — each
  default-notify, admin-only (all `requireAdmin()` routes, so no non-admin can
  carry the flag), and audited `notifyMember: false` only when a send is truly
  suppressed (a would-not-send path — e.g. a member with no email on file, or a
  refund appellant with no address — records no notify field). Five further
  sends stay **deliberately always-notify** and outside the choice for the same
  not-strandable-communication reason: the membership-application **induction
  sign-off requests** (token-bearing signer requests), the family group-create
  **partner invitation** (token-bearing; the partner cannot join without it),
  the **account-deletion approval** privacy receipt (the member requested
  deletion and cannot log in afterward), and the booking-request
  **approved/quote** emails (they carry the payment/quote link). On a
  booking-review **rejection** the shared cancellation email above (#1730) is
  the always-notify send, so a suppressed reject still emails the member the
  cancellation and withholds only the review-declined explainer (superseded for
  the per-booking "No emails" switch — see that section below — which withholds
  the cancellation notice too, so a reject on a silenced booking emails the
  member nothing at all; #2259's review dialog says exactly that rather than
  repeating the promise above).
  An account-deletion approve and reject also have exactly one final winner,
  but they do not race for the same transition (#2597). An approval cancels
  future bookings in separately committed transactions before it anonymises
  anything, so it first claims `PENDING -> APPROVAL_IN_PROGRESS` — durably,
  before the first cancellation commits. Rejection may claim only `PENDING`;
  approval may finalise only from `APPROVAL_IN_PROGRESS`, inside the
  anonymisation transaction, so any later privacy failure rolls finalisation
  back to that intermediate claim and sends no receipt. **A rejection can
  therefore never become final after an approval-triggered cancellation has
  committed**, which the single-transition protocol could not guarantee. A
  repeated approval resumes its own claim rather than being refused, so an
  interrupted cleanup can always be completed. A losing concurrent reviewer
  gets a fixed conflict and sends no contradictory message. Cancellations
  already committed before a lost claim are returned as explicit partial
  cleanup, never described as anonymisation.
  `APPROVAL_IN_PROGRESS` is an OPEN state, not a decided one: it has already
  destroyed bookings and still owes the member their anonymisation. Every
  "is there an outstanding request?" reader — admin queue, pending counts,
  dashboard, the member's own re-request guard, and the member-merge blocker —
  must therefore treat it as open via `OPEN_DELETION_REQUEST_STATUSES`.
  Filtering on `PENDING` alone would hide a half-finished deletion from the
  queue that has to finish it, and would silently unblock a merge that then
  re-points the request at the surviving member.

- **recalculate** — the existing full-reprice machinery with the locked-period
  clamps lifted, so locked-night pricing semantics are otherwise preserved
  (a night the guest already bought keeps its stored `BookingGuestNight` price).

Under an override, an over-capacity target is **warn-and-confirm** rather than a
hard block: the first apply raises `OverCapacityConfirmationRequiredError`
(HTTP 409, code `OVER_CAPACITY_CONFIRM_REQUIRED`, with the over-capacity nights),
and the admin must resubmit with `confirmOverCapacity: true`. The capacity lock
is still acquired, and the confirmed overbooking is recorded (`capacityOverridden`
on the modification's `newData` and in the audit trail). Statuses outside the
active lifecycle (DRAFT, WAITLISTED, WAITLIST_OFFERED, BUMPED) hold no capacity,
so both pricing modes skip the capacity decision for them entirely — a move that
cannot overbook must never prompt for (or record) an overbooking confirm. Every override move is
audited as `booking.modify.admin_override` with before/after dates, `pricingMode`,
and `confirmOverCapacity`, and is linked (best-effort, post-transaction) to the
booking's most recent APPROVED-but-unlinked `BookingChangeRequest` **that the
move actually fulfils** — the request must be date-only (no guest changes) and
every date it names must equal the applied value, so an unrelated move can never
mark a different ask as applied — closing the approve → apply trail. The modify-quote preview mirrors apply exactly for the
same input (same date resolution, capacity signal, and member-night conflict
check), so the operator never sees a clean preview for a move that would fail.

**Per-booking "No emails" switch (#2258, owner decision D10, 2026-07-27).**
Separately from
the per-action `notifyMember` choice above — which is a one-off decision made at
the moment of a single admin action — a booking can carry a persistent
`Booking.noEmails` switch that withholds **everything** the system would send
about that booking for as long as it is on: confirmation, modification, payment,
reminders, arrival information, cancellation, waitlist offers, chore rosters,
and the Xero-sent invoice email. It is enforced in ONE place, the mailer
(`sendEmail` in `src/lib/email/core.ts`), plus the three paths that bypass the
mailer (the retry cron, and the two invoice emails Xero sends on our behalf).
The rules are:

- **Keyed strictly on the booking, never on the recipient address.** An
  address-keyed switch would also swallow two-factor codes, password resets,
  magic-link logins and email-change notices — account lockout, not a
  preference. Every send therefore carries a REQUIRED, typed `bookingContext`
  (`{ bookingId, recipient } | "none"`), so a new send site is a compile error
  until its author states which it is. For a concrete booking the context also
  names the recipient category (an explicit member id, public/non-login, or
  aggregate operator), so address matching can never stand in for authority.
- **Authenticated booking links follow the booking-detail read gate (#2362).**
  A concrete booking email receives the canonical, encoded
  `/bookings/<booking-id>` URL only when the recipient is active, can sign in,
  and is the owner, a linked booking guest, or holds bookings-view admin access;
  the outbound address must also still equal that member's current direct or
  flattened inherited mailbox.
  Deleted bookings remain Full-Admin-only. Public/non-login contacts, aggregate
  reports, unrelated members, failed authority reads, and templates outside the
  live booking-scoped inventory receive no authenticated booking URL. Bearer
  payment, quote, consent, and response links stay distinct and unchanged.
- **Admin-audience mail is never withheld.** The registry's
  `EmailTemplateDefinition.audience` is the authority, so admin/system alerts
  (payment failure, duplicate-capture refund, and the rest) still reach an
  operator even when the booking is silenced.
- **The read fails CLOSED.** Unlike the SES bounce check, which deliberately
  fails open, an unreadable switch withholds the send: the mailer records the
  row FAILED (so the retry cron re-evaluates it) and transmits nothing.
- **Every withhold is auditable.** The withheld send is written as an `EmailLog`
  row with status `SKIPPED_NO_EMAILS` and the booking's `bookingId`, with no
  retained body — so the booking page can list exactly what was held back
  (#2259), and the retry cron cannot replay it (its query requires a retained
  body, and the status is terminal).
- **The retry cron re-evaluates before every replay.** A `FAILED` row can
  predate the moment the switch was turned on, so `cron-email-retry.ts` re-reads
  it from the row's `bookingId` and fails closed the same way. It also repeats
  the booking-detail authority check from durable `EmailLog` recipient/context
  provenance; the address is matched to that identity's current direct or
  flattened inherited mailbox, never used as identity by itself. Built-in and
  stored-override DELIVERY copies are re-finalized before the guarded retry
  claim, so a revoked/stale recipient loses the detail CTA while bearer actions
  and page fragments remain intact. Stored override SOURCE and re-save behavior
  stay byte-for-byte unchanged. Legacy rows with no durable context retire
  without sending. New booking retry bodies live only in the authority-aware
  `bookingRetryHtmlBody` column; legacy `htmlBody` stays null so an application
  rollback to the pre-#2362 worker cannot replay them without these checks.
- **Waitlist candidacy excludes a silenced booking.**
  `processWaitlistForDates` filters on `noEmails: false`, so no NEW offer is
  made to a silenced entry and, in the ordinary case, no offer clock starts for
  a member who would not be told. That exclusion is not retroactive and does not
  cover every ordering, so two cases remain and both are surfaced rather than
  denied:
  - the switch is turned **on while an offer is already live** — the clock keeps
    running and the offer is not retracted. `setBookingNoEmails` returns
    `hasLiveWaitlistOffer`, and #2259's acknowledgement dialog warns on it
    **before** the admin confirms (from the same predicate,
    `bookingHasLiveWaitlistOffer`, so the warning and the route's answer cannot
    disagree about what "live" means) as well as after the write;
  - the **post-commit race** — `processWaitlistForDates` commits the offer and
    fires the email un-awaited afterwards, so a switch flipped in between leaves
    a live offer with a withheld send. (The retry cron can likewise rewrite an
    already-FAILED offer row to `SKIPPED_NO_EMAILS`.)

  In both, the entry is holding a bed the member was never told about, so the
  admin waitlist board reports the distinct `suppressed_live_offer` state with
  `needsOperatorAction: true`. A withheld offer on an entry whose offer has
  already lapsed is the benign `suppressed` state and needs no action. A
  silenced entry that is still `WAITLISTED` produces no EmailLog row at all, so
  the board marks it from the flag ("silenced — will not be offered").
- **A silenced waitlist entry keeps its place in the queue.** It is skipped for
  offers but is NOT removed, and it still counts toward the position quoted to
  the members behind it — the position numbers other members see are unchanged
  by anyone's switch. (Deliberate: position is member-visible, and silently
  re-numbering a queue because of an internal admin setting would be a worse
  surprise than a stalled entry an officer can see and fix.)
- **Xero-sent invoice emails are gated too, which SUPERSEDES the #1705 carve-out
  above for this switch only.** #1705 decided the Internet Banking invoice email
  is outside the per-action `notifyMember` choice and always sent. D10 says the
  per-booking switch "suppresses everything", so when it is on the
  `emailInvoice` call is skipped and a withheld audit row is written naming the
  invoice. **The invoice itself still exists in Xero and is unchanged** — only
  the emailing is skipped, so an admin sends it **from Xero by hand**. Clearing
  the switch does NOT resend it: invoice creation short-circuits on the stored
  `payment.xeroInvoiceId` and never reaches the email step again, and the
  `emailInvoice` idempotency key would no-op regardless. When the switch could
  not be READ (as opposed to being on) the sync operation is left PARTIAL so an
  operator sees it — but the operations panel's payment repair must never be run
  on an email-only PARTIAL: every one of them is an Internet Banking booking
  whose Xero payment is deliberately skipped, so recording a payment would
  falsely settle an unpaid invoice. That repair is refused for email-only
  PARTIALs. The per-action `notifyMember` carve-out is untouched: with the switch
  off, the invoice email is still always sent. The group settlement invoice is
  one combined bill addressed to and paid by the **organiser**, so it is gated on
  the organiser's own booking and on nothing else — a joiner's switch does not
  suppress the organiser's bill, and each joiner's own group emails are gated on
  that joiner's child booking.
- **Setting it requires an acknowledgement.** `POST
  /api/admin/bookings/[id]/no-emails` is admin-only (403 otherwise) and refuses
  an enable without `acknowledged: true` (400, nothing written). Both set and
  clear are audited, and `noEmailsAt` / `noEmailsByMemberId` record who and
  when, mirroring the `wholeLodgeHold` audit columns. Clearing needs no
  acknowledgement — a stuck switch must always be clearable — and does **not**
  re-send anything withheld while it was on.
- **The acknowledgement is a real admin decision, not just a request field
  (#2259).** The control lives in the Admin tools card on the booking detail
  page and is gated on `bookings:edit`. Turning it on opens a two-button dialog
  ("Yes — I will tell the member myself" / "Cancel") carrying the plain
  consequence — no emails at all for this booking, including cancellation
  notices and payment reminders, and the admin is responsible for telling the
  member directly. It is deliberately **not** a checkbox: a checkbox is missable
  and the consequence is a member who is never told their booking was cancelled.
  Nothing is written until the dialog is answered.
- **The booking carries a persistent warning listing what was ACTUALLY withheld
  (#2259).** Read from the `SKIPPED_NO_EMAILS` audit rows, not a fixed sentence:
  the admin has to know WHICH messages the member never received in order to
  relay them, and the list includes the Xero-sent invoice emails, which are
  inside the same guarantee. Each row shows the template's registry display name
  (`withheldEmailDisplayName`), its subject and its timestamp. The banner
  **keeps warning after the switch is cleared** whenever withheld rows exist,
  because clearing re-sends nothing — a member never told about a cancellation
  is still never told.

  One documented exception (#2350): the additional-payment chase cron checks the
  switch ITSELF and skips before it reaches the mailer, deliberately, so that no
  stamp is burned and the reminder is still due once the switch comes off. Since
  the mailer never runs, no `SKIPPED_NO_EMAILS` row is written and that skipped
  chase does not appear in this list. It is the one booking message the banner
  cannot name — and the only one that is not lost by being withheld, because it
  will be sent for real later.
  Rows are **grouped per template with an exact count**, read with aggregates
  (`getWithheldBookingEmailSummary`). That is a correctness property, not a
  presentational one: a chore-roster send fans out to one row per guest per
  date (~56 for a week for a party of eight), so a flat newest-first list both
  buried the single cancellation that mattered and could hit the old
  undisclosed `take: 100` cap. The groups come from a database-side `groupBy`,
  which returns one row per distinct template; representative subjects are then
  fetched by matching the per-template maxima under an explicit cap, and a
  group is never dropped for want of a subject because the aggregate — not the
  row read — produces the list. (An earlier attempt used
  `findMany({ distinct })`; Prisma only pushes `distinct` into the query when it
  LEADS the `orderBy`, so ordering by `createdAt` fetched every withheld row for
  the booking and deduped in memory — the same unbounded read the `take: 100`
  had been masking, under a comment claiming the registry bounded it.)
  Each group carries a `remedy` saying what the officer must actually DO, and
  the three values are not interchangeable:
  - `relay` (the default) — the content is information the officer can simply
    state. The Xero invoice is here: it still exists in Xero and can be sent by
    hand from there.
  - `auto-regenerates` — `split-guest-payment-link` only. The link is decided
    BEFORE it is minted, so none exists, and the settlement cron re-mints and
    re-sends once the switch is off. Clearing the switch is the whole remedy.
  - `resend-roster` — `chore-roster`, which was briefly and wrongly treated as
    the case above. `admin-roster-service.ts` DELETES the guest's existing chore
    token, mints a fresh one, and only then sends: a live 48-hour link exists,
    the guest's previous link was destroyed, and the guest currently holds
    nothing that works. `sendChoreRosterEmail` has exactly one caller — the
    admin roster action, with no cron behind it — so nothing regenerates it and
    the officer must re-send the roster by hand.
  The banner also points at the email-failure queue, because three classes are
  structurally absent from it: a send that failed closed on an unreadable
  switch, a withheld send whose own `EmailLog` write failed, and rows queued
  before the feature shipped.
- **Two consequences are stated in the acknowledgement dialog because nothing
  can record them.** A **live waitlist offer** can only PREDATE the switch
  (candidacy exclusion prevents new ones), so its offer email already went out:
  the member HAS been told and CAN still accept, and the dialog says not to
  reassign the bed. What is lost is the expiry warning and the acceptance
  confirmation. Saying "the member cannot accept" would be worse than silence —
  an officer believing the bed dead might reassign it out from under a member
  still entitled to it. A **still-WAITLISTED** booking is skipped for offers
  ENTIRELY, so no offer is made, nothing is withheld, and no row is ever
  written; the dialog states it before the officer commits and the banner
  repeats it, and "waitlist offers" is deliberately absent from the banner's
  withheld-categories sentence, which would otherwise imply an offer was made
  and only its email held back.
- **A member must never learn the switch exists.** The booking detail page
  serves members and admins from one file, so the control, the banner, and every
  `noEmails` value the page produces sit behind the page's admin predicate — and
  the withheld list is not even QUERIED for a member. Gating the render alone is
  insufficient: a prop threaded unconditionally is serialised into the RSC
  payload, so the switch would be readable off the wire with nothing drawing it.
  `booking-no-emails-ui-contract.test.ts` enforces both over the AST.
- **The per-action `notifyMember` prompts are not offered while the switch is
  on (#2259 honesty rule).** The rule behind that prompt family (#1769a) is that
  an admin is only asked a question the system will honour; with the switch on
  the message is withheld either way, so asking invites the admin to choose
  "…and email member" and believe the member was told. Every booking-bound
  prompt therefore drops to the send-nothing path and states the position
  instead: confirm-pending-guests, the admin edit, the admin cancel, the booking
  review queue, the waitlist force-confirm, and the refund-appeal review. The
  same contract test asserts the closed world — a new prompt must be classified
  booking-bound or not, with its reason, rather than silently escaping the rule.
- **The silenced path sends NO `notifyMember` flag, never `false`.** This is a
  correctness requirement, not a style choice, and the contract test enforces
  it. `notifyMember: false` tells the ROUTE not to send at all, so the mailer's
  gate never runs, no `SKIPPED_NO_EMAILS` row is written, and the withheld-list
  banner cannot name the cancellation the officer just performed in silence —
  on an otherwise quiet booking it would read "Nothing has been withheld yet"
  immediately afterwards, while the operator guide tells the officer to work
  down that list. The compensating control would be blind to its own trigger.
  Sending no flag lets the send be ATTEMPTED and withheld, which records the
  row. The member's outcome is identical either way. It is also the honest
  audit record: `false` would say the officer declined and `true` would say
  they opted in, and with the choice removed neither happened — every one of
  these routes treats an absent flag as "no explicit choice", and only audits
  an explicit one. That the SWITCH decided is durably recorded by the withheld
  `EmailLog` row plus the `booking.noEmails.set` audit entry, so no new field
  was added to six money- and booking-critical routes to state it twice.
  Deliberately EXCLUDED and why: the chore-roster send (per DATE, fanning out
  across many bookings, where the mailer's own gate silences each one
  individually), the public booking-request decline and the admin create flow
  (no `Booking` row to be silenced yet), and every membership, family, deletion
  and application prompt (keyed on a member, not a booking).


Booking **creation** is normally today-or-future: `POST /api/bookings` and the
create service both reject a past check-in ("Cannot book in the past"). Issue
#1695 adds an **admin-only, on-behalf-only** exception — the same
`bookingManagementAuthorizationRole(session.user) === "ADMIN"` gate as #1668 —
so a Full Admin or Booking Officer can record a stay that already happened. The
opt-in `allowPastDates` flag (valid only with `forMemberId`, and only with a
check-in strictly in the past — a today-or-future check-in carrying it is a
400) permits a past check-in within a **365-day rolling lookback**
(`RETROACTIVE_BOOKING_MAX_LOOKBACK_DAYS`); it is enforced at the route **and**
re-checked in `createConfirmedBooking` against the **resolved stay envelope**
(guest nights can expand the stay before the requested check-in, #713 — the
route's lookback and lock-date guards also run on the envelope check-in).
Two internal callers legitimately create a booking whose check-in is already
past and carry the service-only `allowPastCheckIn` marker instead: group join
(the child inherits the organiser's whole-stay dates, #1387) and cross-lodge
waitlist confirm (a 48-hour offer accepted after NZ midnight) — the marker
skips only the past-date rejection, never the retroactive semantics, and is
not exposed via the API. Any of the three flags (`allowPastDates`,
`confirmOverCapacity`, `notifyMember`) present without the ADMIN role is a
403; the flag combination is validated (any flag without `forMemberId` → 400,
`confirmOverCapacity` combined with `draft`/`waitlist` → 400, retroactive
`draft`/`waitlist` → 400). Because a
retroactive booking invoices at its check-in (the invoice **issue date stays =
checkIn**, no clamp), a create-time **Xero lock-date guard** protects it: when
Xero is connected the route reads the organisation's `periodLockDate` /
`endOfYearLockDate` (`getXeroLockDates`) and rejects a check-in on or before the
effective lock date (409 `XERO_PERIOD_LOCKED`, with unlock instructions). The
guard is **skipped when Xero is not connected** and **fails closed** (retryable
503 `XERO_LOCK_DATE_CHECK_FAILED`) when the lock dates cannot be read; the Xero
call is made outside any DB transaction and its result is cached ~5 minutes.
The guard still fails closed for every cause, but now **classifies that cause**
(#2105): the `XeroLockDateCheckFailedError` carries a `reason` of
`reconnect_required` (the Xero connection needs re-authorising — a revoked or
missing token/tenant, surfaced by the taxonomy's `XeroReconnectRequiredError`),
`rate_limited` (Xero's daily API budget is exhausted — `XeroDailyLimitError`),
or `transient` (a temporary outage or unclassified failure). The `reason` and
the cause-specific admin copy are emitted **only for the admin audience**
(`getXeroLockGuardErrorResponse` omits it for members) — member-facing bodies
stay the generic wording so they disclose no Xero connection state. The code
(`XERO_LOCK_DATE_CHECK_FAILED`) and status (503) are unchanged for both.
Independently, admins can run a **click-only connection-health probe**
(`GET /api/admin/xero/status?probe=1`): it refreshes the token and reuses the
cached lock-date/org read, returning `tokenHealth` of
`ok | reconnect_required | rate_limited | error`, and is cached server-side
30–60s so repeated clicks make no extra Xero call. A daily-limit cooldown maps
to `rate_limited` **without any API call** (the in-process gate throws before the
network request), so the probe can never burn the shared daily budget; it never
runs on page mount or a poll. The most recent recorded usage `errorMessage`
(redacted) is surfaced alongside the health chip.
The same guard protects the **booking modify paths**
(`xero-period-lock-guard`), with two deliberately asymmetric scopes:
- **Admin override** (#1697): a **recalculate** override can queue a
  **check-in-dated primary-invoice write** — the invoice date/narration update
  on a booking whose payment is not yet settled, or the invoice create a
  zero-dollar recalculate performs — and is rejected (same 409/503 contract, at
  the modify-quote preview and at apply in both modify services, before their
  transactions) when the check-in the booking would end up with lands on or
  before the effective lock date; a check-out-only recalculate is guarded via
  the unchanged past check-in. Supplementary invoices and modification credit
  notes are dated at the day they are raised (not check-in), so on an
  already-paid booking a recalculate writes no check-in-dated document — the
  override guard **still fires there by design**: **deliberately conservative,
  a settled owner decision** (#1697, re-affirmed and closed on #1718 —
  workarounds for the over-block on paid bookings are shift mode or briefly
  unlocking the period).
- **Ordinary (non-override) date edits** (#1729) get a **NARROW guard** at the
  same pre-transaction points (both modify services and the modify-quote
  preview): it fires only when the edit would **actually queue the
  check-in-dated invoice update** — issued Xero invoice, dates changing,
  payment not settled — via the settlement classifier's own predicate
  (`wouldQueueCheckInDatedInvoiceUpdate`, shared so guard and
  `queueXeroBookingEditSettlement` can never drift). Error text is
  **actor-appropriate**: admins get the unlock instructions, members get a
  "contact an administrator" 409 (and a softer fail-closed 503) — same codes
  either way; a member's request against a booking they do not own skips the
  guard silently (the transaction's 403 answers it — no lock-date disclosure
  to non-owners). **Identity-only edits (guest name fixes) are never guarded**
  (owner decision, #1729): the outbox backstop covers that rare strand rather
  than blocking a typo fix. Also outbox-backstopped, not guarded: the
  check-in-dated invoice CREATE a $0-collapsing ordinary edit can queue for a
  never-invoiced booking, and guest-range edits that move the stay envelope
  without date fields in the request.

**Shift overrides are exempt**: a shift writes no Xero documents.
As at create, only past check-ins are guarded.
Over-capacity nights on **any on-behalf create** — past (#1695) or
future-dated (#1767) — are **warn-and-confirm** (the same
`OverCapacityConfirmationRequiredError` → 409 `OVER_CAPACITY_CONFIRM_REQUIRED`
contract as #1668, capacity lock still taken, `capacityOverridden` recorded),
with one carve-out: an on-behalf create that opted into the **waitlist
fallback** keeps the capacity-exceeded outcome so the route can create the
WAITLISTED booking instead of prompting. (The former v1 carve-out that
hard-blocked a **non-member hold-eligible (PENDING) party** was retired by
#1771: the persisted override is now honoured by `cron-confirm-pending`, so the
hold re-check confirms rather than bumps the overbook.) A **member self-create
can never overbook**: without `isOnBehalf` the service keeps the hard capacity
block regardless of any flag, and the route rejects the flags outright (403
non-admin, 400 without `forMemberId`).
The member confirmation / hold email is an **explicit per-create choice**
(`notifyMember`, honoured only for on-behalf creates) recorded in the
`booking.created_on_behalf` audit metadata alongside `allowPastDates`,
`confirmOverCapacity`, and `capacityOverridden`; `sendAdminNewBookingAlert` and
the Xero invoice email are unaffected by the choice.

A **deliberately over-capacity booking is never destroyed by a later capacity
re-check** (#1771). Every over-capacity admission — on-behalf create
(#1668/#1695/#1767), date/batch modification (#1668), waitlist force-confirm,
confirm-pending-guests overbook (#1366), and admin capacity-hold (#1764) —
**persists** the decision on the booking as `Booking.capacityOverriddenAt` +
`capacityOverriddenByMemberId`. The marker records "a deliberate overbook on the
booking's **current** nights": one-shot admissions stamp it once, while the date
and batch modification services **reconcile** it (re-stamp if the new range is
still an admin-confirmed overbook, **clear** it if the change moved the booking
back within capacity) because they re-evaluate capacity on the new nights — so a
stale flag can never suppress a legitimate cancel after a booking is modified
from an over-capacity range into a fitting one. It is not cleared on cancel (a
cancelled booking never re-enters a re-check). Every payment-time / settlement
capacity
re-check — `markBookingPaymentSucceeded`, payment links, `cron-confirm-pending`,
`charge-saved-method`, `switch-to-internet-banking`, the Internet Banking
invoice-paid reconcile, and group settlement — **must** consult
`bookingHasCapacityOverride(booking)` and, when set, settle/advance the booking
to its correct terminal state instead of cancelling+refunding, 409ing, or
bumping it. The DRAFT-scoped re-checks (`create-payment-intent`,
`confirm-draft`) are exempt because #1767 prevents a DRAFT from ever carrying an
override. Members can never overbook, so this marker only ever appears behind an
explicit, audited admin act.

A **finished stay's card obligation never lingers unseen** (#1709, #1723). Two
**disjoint** admin queues surface every uncollected card obligation on a stay
whose check-out is on or before NZ today, both driven by the shared
predicate/href helpers in `src/lib/unpaid-finished-stays.ts` (the dashboard
attention cards, the sidebar Needs Attention badges via
`admin-pending-counts`, and the bookings-list deep links all consume the same
helpers so the surfaces can never drift):

- **Unpaid finished stays** (#1709/#1731): `deletedAt` null +
  `status = PAYMENT_PENDING` + `checkOut ≤ today` — the whole booking price is
  still owed (a retroactive card create qualifies from the moment of
  creation). Deep link:
  `/admin/bookings?status=PAYMENT_PENDING&checkOutTo=<today>`.
- **Unsettled finished-stay additions** (#1723 path 2, owner decision B — the
  card additional-payment flow stays): `deletedAt` null + `checkOut ≤ today` +
  `status ∈ {CONFIRMED, PAID, COMPLETED}` + payment
  `additionalAmountCents > 0` with `additionalPaymentStatus` null or not
  `SUCCEEDED` — a settled stay whose upward modification delta (admin
  recalculate, guest add, date change) was never collected. The payment
  summary columns mirror the LATEST ADDITIONAL payment transaction. The
  in-memory twin of this predicate is `isAdditionalPaymentOwed`
  (`src/lib/additional-payment-chase.ts`), which takes the booking status as a
  REQUIRED argument for exactly this reason: cancelling a booking leaves
  `additionalAmountCents` and `additionalPaymentStatus` untouched, so an
  amount-only test reads a cancelled booking as still owing. `PAYMENT_PENDING`
  is deliberately excluded so the two queue counts can be summed without
  double-counting a booking — a narrowing for counting, NOT a claim that such a
  delta is uncollectable (see "Who may pay one" below). Deep link:
  `/admin/bookings?additionalOwed=owed&checkOutTo=<today>` via the bookings
  list's `additionalOwed` filter (AND-composed, so explicit status/date
  filters in the same URL still narrow).
- **Unsettled additions on a stay still ahead** (#2350): the same predicate
  with `checkOut > today` instead of `checkOut <= today`, so the two halves are
  disjoint by construction and their counts sum without double-counting. This
  is the half that can still be chased while the member is paying attention;
  the finished half is a follow-up conversation. The dashboard shows one card
  with a split label ("N upcoming, M finished") and the sidebar badge shows the
  sum, both deep-linking to `/admin/bookings?additionalOwed=owed` - the whole
  queue, with no date bound, because the bookings list has no upcoming-only
  filter to point at.

### Booking-policy exception requests (#2365, epic decision D-R5)

The durable member-request + admin-decision flow for eligible SOFT policy
failures. It NEVER covers a hard failure — whole-lodge capacity, invalid/past
dates, authentication, subscription/membership eligibility, duplicate
member-night, payment, privacy or data-integrity — which stay firm refusals
(the #2363 allowlist is the only thing that can enter review). These invariants
hold over the store (`BookingChangeRequest`, `kind = POLICY_EXCEPTION`) and the
pure workflow logic (`src/lib/booking-exception-requests.ts`):

- **The proposal is immutable and self-proving.** A request freezes the complete
  proposal — the whole proposed booking for a new-booking request, the live base
  footprint AND the full proposed result for a modification — and a SHA-256
  `proposalHash` over its canonicalised form (recursively key-sorted JSON, sorted
  and de-duplicated per-guest nights, content-ordered guests). The hash is
  order-independent, so re-freezing the same facts is byte-identical, and it
  changes if any night, guest or — for a modification — the live base drifts. An
  approval recomputes it to prove it is executing exactly what was reviewed.
- **The evidence is frozen and authoritative.** `frozenEvidence` is the #2363
  aggregate — every covered structured violation with its reason code, policy
  id/version, resolved scope, exact affected NZ nights, requirements and frozen
  per-policy capacity mode — plus the HOLD-if-any-HOLD aggregate. An approval may
  override ONLY these reviewed violations, and nothing that is not on the #2363
  allowlist can be stored (`freezePolicyExceptionEvidence` refuses it).
- **A held request's provisional reservation is per-night and directional.**
  Today only the MODIFICATION path writes a reservation; a modification request
  reserves ONLY the incremental beds beyond a capacity-holding live booking
  (`max(0, proposed - live)` per night, because that live booking already holds
  its own footprint and #2365 forbids touching it before approval), OR the FULL
  proposed footprint when the live base is **not** capacity-holding (a
  DRAFT / generic PENDING / un-held PAYMENT_PENDING / WAITLISTED / BUMPED booking,
  which contributes nothing to occupancy for a delta to sit atop). A shrinking
  modification reserves nothing. New-booking requests do **not** yet write a
  reservation — that hold is DEFERRED to #2526, and their approval-time NO_HOLD
  capacity recheck is what prevents overbooking until then; the full-proposal math
  `computeProposalReservation` already returns for a `NEW_BOOKING` snapshot makes
  wiring that later purely additive. A held modification is never written larger
  than the lodge's real headroom — the create path admission-checks under the
  lodge lock and refuses an over-capacity hold. (The reservation math is
  `computeProposalReservation`. Since #2525 the footprint is durable as
  `PolicyExceptionReservationNight` rows that the canonical per-lodge capacity
  calculation counts as occupancy — alongside capacity-holding bookings and
  custodian holds — so a pending request cannot be oversold; a held request never
  overbooks because its reservation is claimed under the same per-lodge capacity
  lock the occupancy read takes.)
- **Drift is set algebra over the frozen and current violations of the SAME
  proposal.** At approval the frozen proposal is re-evaluated against today's
  policy configuration. A reviewed rule that no longer trips (policy switched off
  or relaxed) is executed WITHOUT an override and the resolution is recorded; a
  reviewed rule that still trips at a different revision or with different content
  (`violationFingerprint`), or any brand-new violation, is a materially different
  question the member must resubmit — it is never silently overridden. Only
  reviewed violations that still trip unchanged are overridable.
- **The message is required.** `memberMessage` is trimmed, non-empty and at most
  1000 characters, normalised once at the request boundary so every later surface
  renders exactly the stored value.
- **Every transition is guarded and single.** Only a `REQUESTED` request may move,
  and only to `APPROVED`/`REJECTED`/`CANCELLED`/`SUPERSEDED`/`EXPIRED`; the guarded
  `updateMany` plus the integer `version` token make a lost claim run no side
  effect (the `BookingRequest.version` discipline, #1923). `REJECTED`,
  `CANCELLED`, `SUPERSEDED` and `EXPIRED` release the provisional reservation;
  `APPROVED` turns it into the executed booking's own beds inside the same
  transaction.
- **Every held bed is on a deadline, and only a held bed is (#2553).** A
  request that actually reserves beds is stamped at creation with an immutable
  `holdExpiresAt` — `POLICY_EXCEPTION_HOLD_TTL_DAYS` (7) from creation, capped at
  the start of the first night it holds, floored at
  `POLICY_EXCEPTION_HOLD_MIN_TTL_HOURS` (24) so a late request still gets a real
  review window. It is written once and never rewritten, so a member's expiry
  cannot move under them and the reaper's clock is an auditable fact of the
  request rather than a live setting. The `policy-exception-hold-reaper` cron then
  moves each past-deadline request `REQUESTED -> EXPIRED` through
  `resolvePolicyExceptionRequestTerminal`, the SAME guarded-claim-plus-atomic-
  release path the other terminal outcomes take, so beds are returned under the
  global -> per-lodge locks exactly once and no forked release exists to drift.
  The converse holds for every row the current code STAMPS: `holdExpiresAt` is
  NULL, and the reaper's scan never sees the row, whenever no capacity is at stake
  — a `LOCKED_PERIOD` row, a `NO_HOLD` aggregate, or a HOLD aggregate whose
  incremental footprint came out empty (a pure shrink). A cron may release stranded
  beds; it may never close a live request that costs the club nothing to leave open.
  **The one stated exception, because the #2553 migration deliberately does not
  backfill:** a row written before that migration (or by a draining old colour) can
  be holding beds *with* `holdExpiresAt` NULL, and the reaper ages that row out from
  `createdAt` plus its own earliest held night under the identical rule. So NULL is
  never a safe proxy for "this request holds no capacity" — a scan or predicate that
  tests `holdExpiresAt IS NOT NULL` would silently skip exactly the stranded holds
  this invariant exists to catch. The live `PolicyExceptionReservationNight` rows are
  the only reliable test, which is why the reaper's scan filters on them.
  Concurrency safety comes from the `version` CAS rather than a job-level lock: a
  decision landing between the scan and the claim wins, and overlapping cron cycles
  produce exactly one expiry and one release. A lost claim is silent; a past-deadline
  row the shared transition REFUSES outright (not a policy-exception row, or an
  unparsable `proposalSnapshot`) can never self-heal, so it is counted as
  `unresolvable` in `CronJobRun.resultSummary` and logged at warn rather than
  reported as a clean run. **An expiry is never silent, and never inside the release
  transaction (owner decision, 2 Aug 2026).** Three records, in this order: the
  `EXPIRED` status the member already sees on their booking's Change Requests card;
  a `booking-policy-exception-request.expired` AuditLog row, so the request's audit
  timeline reads created -> expired; and a `policy-exception-request-expired`
  courtesy email to the member who raised it, telling them the request lapsed and
  its held beds were released. The audit write and the send both happen AFTER
  `resolvePolicyExceptionRequestTerminal` returns a claimed outcome, and both are
  logged-and-swallowed on failure: a bounced notice can neither roll back a
  capacity release, nor cause one to be re-run, nor stop the reaper closing the
  run's other stranded holds. The one-open-request slot is freed too, so a lapse
  never locks the member out of resubmitting.
- **Approval is atomic with execution (#2525).** `approveAndExecutePolicyExceptionRequest`
  reauthorizes from fresh DB roles, re-reads under global -> per-lodge locks,
  applies the drift rules above, claims `REQUESTED -> APPROVED` with the `version`
  CAS, releases the reservation, and invokes the transaction-aware canonical
  booking service (`createConfirmedBooking` / `modifyBookingBatch`, made
  tx-accepting in #2525) — all in ONE transaction, so there is never a window in
  which a request is `APPROVED` but its booking does not yet exist. A NO_HOLD
  aggregate (nothing was reserved) re-checks capacity at approval and keeps the
  request `REQUESTED` with a recorded reason on a conflict, rather than failing it.
  Provider calls and the member approval/rejection notice run after commit.

### Member request surfaces for policy exceptions (#2524)

The request-CREATION half of the flow above (`booking-exception-request-service.ts`
and its routes). Reservation, approval and execution are the #2525 seam
(`booking-exception-execution.ts`); nothing here crosses it. These invariants
hold in addition to every #2365 invariant above:

- **A new booking has its own store.** A `BookingChangeRequest.bookingId` is a
  required FK, so a NEW-booking proposal cannot live there. New-booking requests
  are stored in the dedicated `NewBookingPolicyExceptionRequest` table; a
  MODIFICATION request stays on the `POLICY_EXCEPTION` `BookingChangeRequest`.
  Both freeze the identical immutable proposal + `proposalHash`, `frozenEvidence`
  + `aggregateCapacityMode`, required `memberMessage`, attempt/conflict metadata
  and integer `version` claim token.
- **The violations are re-evaluated server-side, never trusted from the client.**
  A request stores exactly the violations `evaluateProposalPartyViolations`
  re-derives from current policy for the proposed party (minimum stay + adult
  member hosting); a proposal that trips none is refused (nothing to review), and
  a non-allowlisted code can never be stored (`freezePolicyExceptionEvidence`).
- **At most one open request per subject, enforced by the database.** A
  `REQUESTED` row holds a deterministic `openStateKey`
  (`nbpe:{requestedByMemberId}:{proposalHash}` for a new booking,
  `pe:{bookingId}:{requestedByMemberId}` for a modification) under a NULL-distinct
  unique index; every terminal transition NULLs it. A concurrent duplicate races
  into a unique violation (409), never a second open row, and a `LOCKED_PERIOD`
  row (slot always NULL) is untouched.
- **Creation never changes a live booking.** A new-booking request creates no
  booking; a modification request writes only its request row and leaves the live
  booking's dates, guests, pricing and payment exactly as they were. The live
  change is #2525's approve-and-execute.
- **Cancel/supersede are guarded and side-effect-safe.** Member cancel and
  supersede are guarded single `updateMany` transitions on `status = REQUESTED`
  (scoped to the owner, and to `POLICY_EXCEPTION` on the shared table); a lost
  claim runs no side effect — no status change, no notification, no replacement
  request.
- **The officer is notified after commit, never in-band.** The on-request Booking
  Officer alert is fire-and-forget after the request commits; an alert failure is
  logged and never fails the member's request.

### Officer decision on a policy exception (#2526)

The DECISION half of the flow above: `src/lib/booking-exception-approval.ts` (the
real #2525 hooks) and `PATCH /api/admin/booking-exception-requests/[id]`. These
invariants hold in addition to every #2365/#2524/#2525 invariant above:

- **Approving executes; it is never a status flip.** The officer's approval hands
  #2525's engine the real hooks, and the engine claims the request AND runs the
  canonical booking service (`modifyBookingBatch` / `createConfirmedBooking`) in
  ONE transaction. There is no mark-approved-then-call-service gap, so a request
  can never end up APPROVED with nothing behind it.
- **The capacity recheck checks the FULL proposed party and EXCLUDES the live
  booking.** For a modification this makes the full-party check exactly an
  incremental-headroom check against a capacity-holding base, and the correct
  full-footprint check against a non-holding one. Counting the live base and
  then checking only the delta would double-count it and FALSE-KEEP-PENDING an
  approval that should execute (safe direction, wrong answer). A new-booking
  proposal excludes nothing.
- **The recheck window covers every frozen guest night.** The window is the union
  of the frozen party's envelope AND every night its guests hold, not the
  envelope alone. A stored snapshot is DATA: a guest night outside its own
  envelope would otherwise never be capacity-checked by the engine at all, even
  though `createConfirmedBooking` expands the envelope to cover it and books it —
  so the engine's "it asserts capacity itself rather than trusting the executor
  seam" would not be true for those nights. Widening can only make the check
  stricter. Freezing closes the same gap from the other end, expanding the
  proposed envelope to cover every guest night, so the officer's card and the
  engine's window describe the same stay.
- **Capacity stays a hard refusal.** The approval never passes
  `confirmOverCapacity` and never sets `adminOverride`; an approving officer is
  not a capacity-override actor. `createConfirmedBooking`'s non-throwing
  `capacityExceeded` outcome is THROWN
  (`PolicyExceptionExecutionCapacityError`) so the whole approval rolls back.
- **Never a false keep-pending.** Every "still pending" answer the route gives is
  true at the moment it is given: the engine's kept-pending outcomes are returned
  before the claim (NO_HOLD) or via a rollback signal (HOLD), and an execution
  refusal aborts the transaction — undoing the claim, the reservation release and
  every row the canonical service wrote. Equally, once execution has committed
  the request is reported APPROVED and never as pending. **The post-commit phase
  cannot contradict that.** The canonical services' deferred thunks run AFTER the
  commit and await unguarded provider, audit and notification work; the engine
  contains a throw there and returns `executed` with `followUpFailed: true`, so
  the officer reads "approved, but some follow-up work failed" instead of being
  told nothing happened about a booking that now exists — which sent them either
  to a 409 blaming a third party, or to creating the booking a second time by
  hand. A failure in one deferred phase never skips the other.
- **A kept-pending capacity conflict is always recorded.** `conflictCount`,
  `lastConflictAt` and `lastConflictReason` are what the officer's card and the
  member's own request list read to tell "the lodge is full" apart from "nobody
  has looked yet", so the record must survive the rollback that carries the HOLD
  signal. A store whose held requests reserve nothing (`holdsReservation: false`
  — the new-booking store, whose reservation ledger is keyed to an existing
  booking) is rechecked BEFORE the claim, so its conflict commits in the one
  transaction that commits. A store that genuinely holds beds is still rechecked
  after the release, and its conflict is written in its own transaction after the
  rollback.
- **The live proposal is verified by replay, not by trust.** A modification
  request freezes the raw member delta beside the proposal
  (`requestedChanges.delta`). `verifyLiveProposalIntegrity` replays that delta
  against the LIVE booking and requires the resulting base+proposed pair to hash
  to the frozen `proposalHash`. One equality proves both halves: the live booking
  has not drifted, and the delta still produces the proposal that was reviewed. A
  missing, malformed or tampered delta fails closed — but not with the same
  explanation. Drift and tampering are reported as proposal drift; a row carrying
  no replayable delta at all (one created before the delta was frozen) gets its
  OWN message, because it is unexecutable while nothing about the booking has
  moved, and blaming a live edit sends the officer and the member looking for an
  edit that never happened.
- **"What the delta produces" is computed by ONE implementation.** The replay is
  proof only while the frozen party is what the canonical planner will really
  build, so the two are the same arithmetic rather than two that agree by
  inspection: `resolveModificationStayRanges`
  (`src/lib/booking-modification-stay-ranges.ts`) is called by
  `resolveTargetDates`, by `prepareGuestPlan`, by the freeze, and — since #2563 —
  by the modification PREVIEW (`POST /api/bookings/[id]/modify-quote`), which
  until then assembled its own copy of the same rules. Four surfaces, one
  implementation: the price a member is quoted, the party an officer approves and
  the party the save writes are the same arithmetic, and the route keeps only the
  presentation half (mapping the resolver's structured range error onto its 400
  body, with the resolver's own wording so preview and save refuse identically).
  It owns the
  planner's real semantics — the range-input flag is GLOBAL (ANY range anywhere
  switches the whole request into a mode where every guest without their own
  entry keeps their STORED range and night set, and the dates-moved reset never
  runs), and a stored sparse night set (#713) survives instead of being flattened
  to its envelope. A per-guest lookalike of that rule froze, hashed and
  capacity-checked a party the execution never created: a date change plus a
  partial `guestStayRanges` had an officer review three guests on three nights
  and committed 3 + 2 + 2 — a different party, a different price, and a
  minimum-stay/hosting judgement made on a party that never existed.
- **Only the reviewed rules are overridden, and ADMIN is not borrowed for
  anything else.** Minimum stay is overridden by running the canonical
  modification as an ADMIN actor (the service enforces the rule only for
  non-admins), which is safe ONLY because #2525's drift gate has already proved
  the frozen proposal trips exactly the reviewed violations — a newly-tripping
  rule is `newViolations` and never reaches execution. A reviewed rule that has
  since CLEARED is not overridden at all; the resolution is recorded instead.

  But `role === "ADMIN"` is overloaded. The same condition also grants
  `skipAuthorization` (dropping the beyond-family member-guest refusal), makes a
  member-guest add consent-free and always-notify, skips the D-8
  profile/bookability gate, skips the cross-family marker, skips the member-guest
  unpaid-subscription check, and auto-approves the adult-supervision review. The
  drift gate cannot cover any of them: `evaluateProposalPartyViolations` evaluates
  minimum stay and adult-member hosting only, so those rules sit outside the
  "exactly the reviewed violations" proof entirely. Borrowing ADMIN for them would
  let a member attach an unrelated member to a booking, consent-free, on a card
  that only ever said "minimum stay".

  So the approval passes `reviewedMemberProposal: true`, and every
  guest-authorisation question in `prepareGuestPlan` is decided from ONE derived
  flag (`guestAuthorizationIsAdmin`) that the input turns off — the plan and the
  pricing pass read the same answer, so they can never disagree about whether the
  family boundary applied. The reviewed minimum-stay override still keys on
  `role`, so it is untouched. The flag can only ever make the guest rules
  STRICTER, and an ordinary admin edit leaves it unset and behaves exactly as
  before.
- **An approved hosting exception is recorded as decided.** The canonical
  modification reconciles the hosting hazard from the rows it just wrote and
  deliberately opens it PENDING (an unrelated edit must never auto-approve one).
  When the approval reviewed that rule and it still trips, the officer's decision
  is written in the same transaction (`recordAdultMemberHostingReviewDecision`,
  guarded PENDING → APPROVED with an attributable reason, D-R4) so an approved
  request never leaves a pending hosting review nobody will action. The
  reason-agnostic check-in block (#1422) is untouched: any pending admin review
  still gates check-in, and this workflow adds no exemption to it.
- **The adult-supervision review is never decided by proxy.** A party with a minor
  and no adult (#1372, `requiresAdultSupervisionReview`) is a different rule from
  either policy-exception reason code: the drift gate cannot evaluate it, the
  officer's card never mentions it, and a minimum-stay-only approval requires no
  written reason at all. An approval therefore opens it PENDING and BLOCKED, with
  the MEMBER's own words as the justification — exact member parity — rather than
  stamping it APPROVED in the name of an officer who was never shown the hazard.
  The child-safety check-in block stays armed until a human looks.
- **Reauthorization is from fresh database roles.** The session guard decides
  whether the officer may open the screen; the engine re-reads the officer's
  CURRENT roles inside the approval transaction and requires `bookings: edit`,
  an active login-capable account, and no forced password change. Access revoked
  between opening the queue and clicking Approve refuses with no write.
- **A decision is explicit, attributable and single-flight.** Approve requires
  `confirm: true`; overriding adult-member hosting and every refusal require a
  written reason; both carry the `expectedVersion` the officer's screen showed,
  so a decision made against a stale queue loses the guarded CAS instead of
  deciding a request that changed underneath it. A failed attempt of the officer's
  own can move that version (a NO_HOLD conflict bumps it), so the queue re-reads
  itself on every failure — otherwise their next click lost the CAS and they were
  told the request "changed while you were reviewing it", which blamed a third
  party for their own previous attempt and made "approve it again once beds free
  up" unreachable without a manual reload.
- **The officer decides a party they were shown.** Approving executes the frozen
  party for real, so `GET /api/admin/booking-exception-requests/[id]` describes
  it — each guest's name, age tier, whether they are a member guest, whether they
  are outside the requester's family (resolved from the LIVE boundary), and how
  many nights they hold — and the queue card loads it on demand before the
  decision. A guest count cannot show an unrelated member being attached to
  somebody else's stay, or a party of minors with no adult, and without the party
  on screen the audit record attributes to the officer a decision they had no way
  to make.
- **The money question is asked, not discovered.** A change that reduces a settled
  booking's price makes the canonical service demand a card-or-credit choice. That
  choice is not part of the reviewed proposal (the proposal decides WHAT changes;
  this decides how the money moves), so it lives on the decision form, and the
  route answers a missing one with `needsSettlementMethod` and its own actionable
  message. It is never reported as "still pending": that named no action, the
  screen offered none, and it made the archetypal shorten-my-paid-stay
  minimum-stay exception permanently un-approvable through the queue.
- **The member can read the decision.** Their own request list returns the
  officer's note (so a refusal comes with its reason rather than a bare
  `REJECTED`), the last capacity conflict (so a request still sitting at
  `REQUESTED` can be told apart from one nobody has looked at), and the booking
  an approval created. The note is returned on EVERY status, not only refusals,
  and the officer's own field says so — the same text is reused as the audit-grade
  override reason on the booking, so it must never be written believing it is an
  internal aside.
- **An approved request is announced.** A MODIFICATION is announced by the
  canonical service's own change notice. A NEW booking is not: a members-only
  party resolves to `PAYMENT_PENDING` on the default payment method, for which
  `createConfirmedBooking` deliberately sends nothing — a member normally learns
  what to pay because they are standing in the wizard being redirected to
  checkout, and an approved exception request happens while they are elsewhere.
  `PAYMENT_PENDING` holds no beds, so silence meant the lodge could fill, or the
  booking be reaped, with the member none the wiser that they had one. The
  new-booking executor therefore sends a dedicated approval email after commit
  (`sendBookingPolicyExceptionApprovedEmail`) naming the stay, what is owed, and
  the officer's note. The two never double up — only the new-booking flavour uses
  it.
- **Both request tables are decided by the same algorithm.** The engine takes a
  `PolicyExceptionRequestStore` (modification = `POLICY_EXCEPTION`
  `BookingChangeRequest`, new booking = `NewBookingPolicyExceptionRequest`);
  the lock order, reauthorization, guarded CAS, drift gate, capacity recheck and
  post-commit ordering are shared, so the two flavours cannot drift apart. A
  new-booking request holds no provisional reservation, so its release is a
  no-op — its safety comes from the approval's own capacity recheck plus the
  canonical create's hard refusal.
- **A new booking is authorised, not merely created.** `createConfirmedBooking`
  validates guest member links not at all: every other caller runs
  `resolveLinkedBookingMembersWithBoundary` →
  `assertLinkedBookingMembersCanBeBooked` → `normalizeBookingGuestInputs` →
  `planMemberGuestConsentWrites` itself, first. The new-booking executor runs that
  same sequence — as the REQUESTING MEMBER, per the reviewed-rules invariant above
  — and dispatches the consent and family-add notices after its commit. Without it
  a member could name any active member's id in an exception request and have an
  approval attach them: no beyond-family refusal, no consent row and no
  notification (on any club, module on or off), no profile/bookability gate, and a
  guest row keeping the REQUESTER's declared age tier and membership, which also
  priced them at the member rate.

  Request CREATION runs the boundary resolution too, so a party naming a member
  the requester may not book is refused at submission and no officer ever reviews
  a party that cannot be executed. That is a usability gate, not the security
  boundary: the approval's own pass is judged against the LIVE boundary at
  approval time and fails the whole approval closed.
- **Attempts count.** A supersede carries the predecessor's `attemptCount` forward
  + 1, so the card's "Attempts" is the number of times the member has actually
  asked. Every replacement starting again at 1 told an officer that a request
  resubmitted three times was a first ask.

### Chasing an outstanding additional payment (#2350)

Until #2350 nothing chased the member for an uncollected upward change and no
admin surface showed one. These rules now hold:

- **Who is owed anything at all.** `isAdditionalPaymentOwed`
  (`src/lib/additional-payment-chase.ts`) is the in-memory twin of
  `buildAdditionalOwedWhere` and tests BOTH halves: booking status in
  {`CONFIRMED`, `PAID`, `COMPLETED`} (one shared list,
  `ADDITIONAL_OWED_BOOKING_STATUSES`), and `additionalAmountCents > 0` with
  `additionalPaymentStatus` other than `SUCCEEDED`. The status half is not
  decoration: booking cancellation marks the additional intent `FAILED` (or
  leaves it PENDING where no intent exists) WITHOUT zeroing the amount, so an
  amount-only test would show cancelled bookings as owing and would email their
  members a payment demand. It takes the status as a required argument so a
  caller cannot forget it.
- **Who may PAY one.** The member-facing surfaces use a second, deliberately
  wider list, `ADDITIONAL_PAYABLE_BOOKING_STATUSES` — the owed list plus
  `PAYMENT_PENDING`, which the owed list drops only to keep the two admin queue
  counts summable. Both surfaces that can move money gate on it: the booking
  page's `AdditionalPaymentCard` and
  `GET /api/bookings/[id]/additional-payment-secret`. The member dashboard's
  owed total is scoped instead by its own query (`ACTIVE_BOOKING_STATUSES` +
  `COMPLETED`), wider again. **What every one of them excludes is CANCELLED and
  BUMPED**, and that is the invariant: a member is never shown, and can never
  complete, a card payment for a booking the club has stopped counting.
  Enforcement is not cosmetic — cancellation marks the additional intent
  `FAILED` without zeroing the amount, and the cancel path asks Stripe to cancel
  only an intent that was still *outstanding*, so an intent that had already
  failed (a declined card) stays confirmable at Stripe. Before this gate the
  owner of a cancelled booking could open the booking, be offered "pay this
  extra", fetch a live client secret and complete the charge; the late-capture
  backstop (#1350) auto-refunded and alerted, but the member had still been
  charged for a booking that no longer existed.
- **What the member is told.** While the stay is still ahead, the member is
  emailed at most twice per obligation: `ADDITIONAL_PAYMENT_REMINDER_DAYS`
  (3) days after the extra was raised, and
  `ADDITIONAL_PAYMENT_FINAL_REMINDER_DAYS_BEFORE_CHECK_IN` (2) days before
  check-in. The pre-arrival reminder also names the amount when one is owing.
  Nothing is ever auto-cancelled or auto-expired, and the chase stops the
  moment `checkOut <= today` - a finished stay belongs to the queue above.
- **Nothing raised before the chase existed is chased, and the cutover is a
  fact rather than a plan.** An obligation whose episode started before the
  cutover is never emailed about by the cron: on first deploy every pre-existing
  delta is already past the day-3 threshold, so without this the first pass
  would mail the whole backlog at once, and legacy rows with no ADDITIONAL
  transaction would date the demand from the payment row's creation rather than
  the day the price changed. Those deltas stay on every admin surface and can
  still be chased by hand — and the exclusion is per EPISODE, so a later upward
  change (or a member retrying a failed charge) is chased normally.

  The cutover is **derived, not hand-written**: it is the `startedAt` of the
  FIRST `CronJobRun` row for `additional-payment-reminders`
  (`resolveAdditionalPaymentChaseStartedAt`). If there is no such row, this pass
  is the first, so it sends nothing and the row it writes becomes the cutover —
  whenever the deploy actually happens. A hand-edited constant pinned to a
  migration date was the previous design and it was enforced by nothing: had the
  deploy slipped past it, every obligation raised in the gap would have been
  backlog mailed on the first pass, which is the exact failure the guard exists
  to prevent. Run rows are pruned after 90 days, which can only move the cutover
  forward to the oldest surviving run — still months behind anything this job
  chases three days after it is raised. A read failure sends nothing that pass:
  not knowing where the cutover is must never mean "email everyone".
- **What makes it idempotent.** Two nullable stamps on `Payment`,
  `additionalReminderSentAt` and `additionalFinalReminderSentAt`, written by a
  guarded `updateMany` BEFORE each send, so a cron rerun (or two runners
  racing) claims nothing and sends nothing. The stamps are read RELATIVE to the
  current obligation - which starts at the latest ADDITIONAL
  `PaymentTransaction.createdAt`, falling back to the payment row's own
  creation for legacy rows - so a stamp left by an earlier, settled delta never
  suppresses the chase for a later one, and no writer has to reset them.

  Every claim also FENCES the obligation the read decided on: the full owed test
  (booking status included), the exact `additionalAmountCents`, and no ADDITIONAL
  transaction newer than the episode being chased. The episode fence is the
  load-bearing one - a member retrying a failed charge mints a new Stripe intent
  and therefore a new ADDITIONAL transaction row at the SAME amount, which an
  amount-only pin would not notice; the email would quote the old obligation
  while the stamp (written at `now`) counted as the new episode's, burning its
  first reminder for good. A lost claim is re-read and re-decided rather than
  treated as another runner's win.
- **One clock for automatic and manual, in both directions.** An admin can
  re-send the same email from the booking page (`POST
  /api/admin/bookings/[id]/additional-payment-reminder`, `bookings:edit`,
  audited). It writes the stamp for whichever reminder is currently due - and
  when that is the last-chance one it closes BOTH stamps, exactly as the cron's
  own final branch does. Writing only the day-N stamp made the cooldown
  one-directional: an admin re-send inside the pre-arrival window was followed
  by the cron's near-identical email at the next three-hourly tick.

  `ADDITIONAL_PAYMENT_RESEND_COOLDOWN_MINUTES` (60) is honoured by BOTH senders,
  in both directions: an automatic nudge inside the window refuses a manual one
  with a 429, and a manual one inside the window makes the cron read "not due"
  (in its decision AND in its claim's WHERE). Stamps alone were not enough — a
  manual send late on the NZ day before the last-chance window opens writes only
  the day-N stamp, and the next tick after NZ midnight would have found the
  final reminder unstamped and sent it minutes later. The cost is that a due
  reminder can slip to the following tick, three hours, not a lost email. On a
  send failure the stamps are given back, so a failed re-send never silently
  disarms the automatic chase.
- **Only a transmitted message counts as sent, and a stamp is only ever spent on
  a message that went out or one that will be replayed.** `sendEmail` RETURNS
  rather than throws when it withholds a message (a suppressed address, a
  walk-in placeholder address, the "No emails" switch flipping on after the
  check), so both senders inspect the outcome. The manual re-send answers with
  what really happened instead of a success. Both then apply the SAME rule with
  the SAME single exception: the stamps go back, unless the withhold was an
  UNREADABLE "No emails" switch, which leaves a `FAILED` `EmailLog` row the
  retry cron replays (re-checking the switch first) — restoring there would risk
  the member getting two copies, so the 503 reply says the message is queued and
  tells the admin not to re-send rather than inviting a retry the cooldown would
  refuse.
- **Silence is refused, not swallowed — and unreachability is checked before
  anything is claimed.** A booking with the "No emails" switch on is skipped by
  the cron with no stamp burned (so the reminder is still due once the switch
  comes off) and refused outright by the manual re-send with an explanation - an
  admin standing at the screen must not read a silent withhold as a successful
  send. Both fail CLOSED if the switch cannot be read. The cron additionally
  checks the recipient BEFORE claiming - a walk-in placeholder `.invalid`
  address, or an active bounce/complaint suppression - so an unreachable member
  costs one skipped pass instead of a burned stamp and a manufactured bounce row
  every three hours, and the reminder stays cleanly due for whenever the address
  is fixed or the suppression cleared. That pre-check is what makes the shared
  stamp rule above affordable in a job that runs eight times a day.

Three side doors into the finished-unpaid state are closed at the door
(owner decisions 2026-07-11, #1723):

- **Past-dated waitlist force-confirm** (path 1, decision B — allow, flag at
  creation): a force-confirm that lands `PAYMENT_PENDING` on a booking whose
  check-out has already passed is allowed but flagged at creation —
  `createdUnpaidFinishedStay` in the audit details/metadata, an
  `unpaidFinishedStay` field in the route response, and an amber "Unpaid
  finished stay created" card on the admin waitlist page. $0 force-confirms
  (land `PAID`) and parked-for-review outcomes carry no obligation and are
  not flagged.
- **Upward modification of a settled past stay** (path 2, decision B): kept
  on the card additional-payment flow rather than blocked; the uncollected
  delta counts on the second queue above.
- **Stale group join** (path 3, decision A — exclude): a group whose
  organiser booking's last night is over (`checkOut ≤ NZ today`, the same
  cutoff as the queues — a stay checking out today accepts no new joiners;
  an action window on dates, named as such by the stay-boundary invariant in
  "Booking Dates And Capacity", not a presence rule) leaves
  the joinable set entirely: `hasGroupStayFullyEnded` gates the public
  summary's `isJoinable`, the member join (409), the non-member join request
  (409 `GROUP_STAY_ENDED`), and the emailed-token verify (`not_joinable`),
  sitting directly after the open/deadline check and ahead of the
  payment-mode/active-booking gates.

A booking left with only non-adults (YOUTH/CHILD/INFANT) requires admin
approval regardless of how it got there or whether it was already paid: every
edit path — including single-guest self-removal, which is never blocked for a
written justification — flags the booking (`adminReviewStatus: PENDING`, with
an automatic note on the removal path) so it lands in the admin review queue.
Review parking moves a booking to AWAITING_REVIEW only from the pre-payment
statuses (DRAFT/PENDING/PAYMENT_PENDING — DRAFT parks in create parity, #2266,
with `draftExpiresAt` nulled so the 72-hour expiry cannot sweep a booking out
from under its reviewer); a paid or confirmed booking is flagged in place, and
approving it clears the review without re-opening the payment lifecycle.
Rejection cancels through the shared cancellation flow, which refunds captured
payments per the policy (a legacy DRAFT-status queue entry — pre-#2266 rows
only — is cancelled directly by the review route with a guarded
DRAFT → CANCELLED flip, since a draft holds no capacity and has no payment).
The invariant is also **enforced at the doors, not only at the writers**
(#2266): `confirm-draft` and `create-payment-intent`'s DRAFT arm both refuse
(409) any booking with `requiresAdminReview` and a non-APPROVED
`adminReviewStatus`, so even a writer bug that leaves a review-flagged DRAFT
behind cannot let a minors-only booking reach PAID with its review pending.

Because a paid minors-only booking is deliberately **not** parked to
AWAITING_REVIEW (Option A / F27, issue #1372 — parking a paid booking would
collide with the captured-money invariant #1100), a second gate protects the
child-safety concern: while a paid/completed booking carries a PENDING admin
review it is **blocked from lodge check-in**. The block is reason-agnostic
(#1422) — ANY pending admin review gates check-in, not only the adult-supervision
reason (today the only such reason, but a future review type inherits the gate
automatically). Server enforcement lives in the shared
`checkinNotBlockedByPendingReviewFilter()` where-fragment, which **excludes** the
booking from the arrive/depart and roster generate/confirm queries
(`src/lib/lodge-date-scoping.ts`) so its guest resolves to null server-side
(arrive returns 404, roster-confirm 400); the check-in reminder cron skips it as
well. The lodge **guest list** (the roster staff read on the kiosk) is the one
surface that now **shows** the blocked booking rather than hiding it — flagged
"Blocked from Check-In — see Booking Officer" with its arrival toggle disabled,
so staff can see who is held while the booking stays un-arrivable server-side
(defense in depth). The booking keeps its PAID status throughout; clearing the
review to APPROVED makes it check-in-eligible again. When the flag newly trips on
a paid booking a best-effort admin email fires (template `admin-minors-review`,
gated by its own `adminBookingReviewRequired` notification preference #1422),
since nothing changes the booking's visible status to signal the block.

The member **edit** panel collects this justification proactively (#2104): it
mirrors the `requiresAdultSupervisionReview` predicate client-side (the same
inlined check the create wizard uses) and renders a required reason field as soon
as an in-progress edit would leave the post-edit party minors-only — unless the
viewer is acting as an admin (admins auto-approve) or the booking is already
flagged/reviewed (the server only demands a reason on the FIRST trip). As a
belt-and-braces fallback for any client/server drift, the modify route returns
the machine-readable `REVIEW_JUSTIFICATION_REQUIRED` code, on which the panel
reveals the same field and re-surfaces the request. The server
(`resolveModifyReviewUpdate`) remains the sole enforcer; the client field only
saves the member a round-trip.

A quote hold spans the whole quote lifecycle (issue #1254). Sending a quote
places the hold automatically: the held booking (AWAITING_REVIEW, a
capacity-holding status) reserves the beds/guest-nights before the send is
finalized, so a quote is never emailed for dates it cannot reserve — if the
lodge is full the send fails loudly (409). The hold survives acceptance: on
accept/approve the same held row becomes the request's converted booking and
moves AWAITING_REVIEW → PENDING, which keeps holding via rule (b) above, so an
accepted-but-unpaid quote does not lose its bed before payment. Accept and the
no-payment cancel are serialized on the global booking advisory lock (#1311): the
cancel re-reads the held status under that lock and flips to CANCELLED only while
it is still AWAITING_REVIEW/WAITLISTED/WAITLIST_OFFERED, so a cancel racing an
accept can never clobber the just-converted PENDING booking back to CANCELLED —
the loser returns 409. The guest swap
at accept updates the held booking's existing guest rows in place (stable
`bookingGuest` ids) instead of delete-then-recreate, so an admin's pre-assigned
`BedAllocation` rows, #713 night sets, promo guest targets, and chore
assignments are preserved. The hold is released on cancel (requester declines
the quote), expiry, or a capacity-reduction bump: the quote-expiry cron
(`cron-quote-expiry-reminders.ts`) frees the bed behind any SENT quote whose
response link has lapsed, and the accepted-but-unpaid booking is released by
the same hold-deadline machinery as any other PENDING request booking
(`cron-confirm-pending.ts`). Every release path detaches
`BookingRequest.heldBookingId` so a later re-quote can never reuse a released
row.

An accepted-but-unpaid quote hold is **not** protected against a later reduction
of lodge capacity for its nights (owner-ratified, #1317). At the hold deadline
`cron-confirm-pending.ts` re-checks capacity for those nights under the booking
advisory lock; if capacity has since been lowered below what is booked, the
still-unpaid hold is bumped/cancelled (no charge, bumped email sent) exactly as
any other over-capacity PENDING request booking would be. The capacity-priority
rule above ("a later *member* booking can no longer bump an accepted-but-unpaid
quote") is unchanged — only an admin lowering the nightly capacity can reclaim an
unpaid hold. Paying the hold moves it to a fully capacity-holding status and ends
this exposure.

School approval re-checks per-night capacity for the FINAL guest list on both
branches before anything flips to a capacity-holding status (#1352, #1911,
#1881). Fresh-create is a capacity-only admission and takes the canonical
per-lodge capacity lock. Held-reuse excludes the held booking's own guests from
the capacity check and takes global `lock(1)` -> per-lodge because it must
exclude cancellation/release of the existing AWAITING_REVIEW booking. It
re-reads the request and hold under both locks and claims
`AWAITING_REVIEW -> CONFIRMED` with a status-guarded update; a lost claim rolls
back every guest/member/payment/audit side effect. A hold reserves only the
originally held
guest count, so an admin child-count override at approval can never confirm
more beds than actually remain on any night; the admin sees the same
capacityExceeded outcome as the fresh path.

A booking converted from (or held for) a public/school booking request keeps
the held booking's immutable concrete lodge even when the request stored a null
default-lodge selector and the configured default later changes. Held generic
and school conversions lock that concrete lodge, fully re-read the request and
booking, and reject any explicit lodge mismatch before mutation. The booking
keeps its officer-negotiated price, flat-split across guest rows; the quote's
per-tier rates are not persisted on the booking. Before a school group
arrives, the school contact confirms who is attending (#1101): a tokenized
public page (hash-stored, rotated per reminder email) applies identity-only
name updates through the same price-preserving machinery as quoted-booking
edits, and the explicit confirmation is stored on the booking request.
The booking's owning contact is an admin decision taken where the owner is
first materialised — a capacity hold, or approval when no hold exists (#1255):
the admin either creates a new non-login `NON_MEMBER`/`SCHOOL` contact or maps
the request onto an existing non-login `NON_MEMBER`/`SCHOOL` contact, and
mapping reuses that contact's Xero contact instead of spawning a duplicate. A
booking request is never mapped onto a `canLogin:true` member, a held request's
owner stays fixed until the hold is released (an admin **Release hold** action
cancels the `AWAITING_REVIEW` held booking through the shared cancel path,
freeing the beds and re-enabling the contact choice). Because this is an admin
re-mapping rather than a requester cancellation, the release suppresses the
customer "booking cancelled" email (`cancelBooking`'s
`suppressCustomerNotification` option — the detach/reconcile/audit still run),
and it deliberately does **not** revoke the requester's quote response token:
the link stays active, so the admin is warned to re-send a fresh quote after
re-mapping. Releasing a hold (and declining a held request) refuses with HTTP
409 rather than cancelling if the requester accepted the quote concurrently —
i.e. the held booking has already left `AWAITING_REVIEW` (`cancelBooking`'s
`requireRequestHold` guard, #1406) — so a just-accepted booking is never
cancelled and its payment links never revoked out from under the requester.

An admin decline releases the capacity hold from ANY held/editor state, not just
`VERIFIED`/`PRICED` (#1423): a decline is valid from all six states the admin
panel shows the Decline button for — `VERIFIED`, `PRICED`, `QUOTED`,
`QUOTE_SENT`, `QUERY_PENDING`, `MODIFICATION_REQUESTED`
(`DECLINABLE_BOOKING_REQUEST_STATUSES`) — and each can carry a live
`AWAITING_REVIEW` hold that the decline frees (claim-first: the `DECLINED` flip
lands before any hold release, so a wrong-state decline `409`s and never touches
the hold).

A DECLINED request is untouchable by every other actor. In the SAME transaction
as the `DECLINED` claim, the decline retires any outstanding `SENT` quote
(`SENT` -> `SUPERSEDED`; `SUPERSEDED` = admin retired it, distinct from a
requester-cancel `CANCELLED`). Because `loadSentQuoteByToken` requires
`status === SENT`, that retirement alone `409`s all four requester quote actions
(accept / modify / query / cancel) on a still-live link, and the pre-expiry
reminder cron (which selects only `SENT` quotes) skips the declined request
instead of nudging it. As defence-in-depth against a request finalised between a
requester POST's token load and its write, the accept re-arm, the modify/query
re-status, and the losing-accept capacity revert are each status-guarded with
`status notIn [DECLINED, CANCELLED]`: a late accept or modify/query `409`s (no
new booking, Payment, or PaymentLink; no resurrection to
`MODIFICATION_REQUESTED`/`QUERY_PENDING`), and the revert simply does not
un-decline the request. The guards still permit a re-arm from
`CONVERTED`/`APPROVED`, preserving approve's `convertedBookingId` idempotency
(#1232 double-accept returns the one existing booking). Per-teacher hut-leader records are always created fresh. The held owner is re-validated at conversion:
if a previously mapped contact is no longer a valid non-login contact by the time
the requester accepts (login enabled, archived, deactivated, role changed), the
accept still succeeds — a fresh non-login contact is substituted and both a
durable admin-attention audit row (`booking_request.owner_substituted`) and an
active `admin-owner-substitution` admin email alert (gated by the
`adminXeroSyncError` preference, F20 residual #2 / #1377) are raised post-commit
so the substituted Xero contact can be reconciled. When the Xero module is off, the
manual-invoice admin notification names the resolved booking owner (the mapped
contact when mapped), not the raw request school/contact.
Headcount or tier changes still go through the admin re-quote flow, and
unconfirmed lists inside the prompt window surface on the stuck-state
dashboard. Standard edit paths (batch
modify, date change, guest add, single-guest removal, and the modify-quote
preview) refuse such bookings rather than silently repricing every guest at
season rates — the change is made by re-pricing or issuing a revised quote
from the booking request. The one exception (#1099) is identity-only edits:
guest name fixes never run the pricing engine — stored totals, per-guest
prices, and night rows are echoed back unchanged on every booking, quoted or
not — so they pass the block, and quoted bookings are additionally exempt
from the paid-name lock (renaming placeholder students after the school has
paid its invoice is the intended workflow).

The paid-name lock on free-text (non-member) guest names blocks changing who a
booking is for after full payment — an unauthorised transfer/resale. It has one
narrow exemption (#1386): on an **identity-only** edit (no structural change) of
a fully-paid, non-quoted booking, an identity-preserving spelling **typo** may
be corrected. A change qualifies only when, on names normalised as trim +
lowercase + collapse-internal-whitespace: (a) neither new part is blank; (b) the
first name and last name each keep the same word/token count (a typo never adds
or removes a name part); (c) no positionally-aligned token is a whole-token
replacement — for each aligned first/last token pair, at least half of the
longer token must be preserved (edit distance × 2 &lt; max token length), which
refuses surname-family swaps like "David Ng" → "David Wu" and "Ann Ho" →
"Ann Lo" even though their overall distance is ≤ 2; and (d) the
Damerau-Levenshtein distance (adjacent transposition = 1 edit) between the
normalised full names is at most `min(2, floor(0.25 × lengthOfLongerFullName))`
— at most two edits and never more than a quarter of the longer name, distance 0
(pure case/whitespace) included. Anything else keeps the hard reject ("only
spelling corrections are allowed after payment; contact the office to change who
a booking is for"), so a same-surname given-name swap ("John Smith" →
"Jane Smith", distance 3) and a full swap ("John Smith" → "Aroha Ngata") are
refused. The rule is enforced server-side (`src/lib/guest-name-similarity.ts`,
mirrored in the modify-quote preview); it never reprices or rechecks capacity
(the identity-only price-preserving path still applies), and every allowed fix
writes a `BookingModification` audit row discriminated as `GUEST_TYPO_FIX` (with
a `paidNameTypoFix` snapshot flag) carrying old→new names, actor, and time.
Member-linked guest names remain unrenameable regardless.

**Residual risk (accepted, audit-mitigated):** the per-token and distance bounds
above stop wider swaps, but a SINGLE-character change that keeps most of a
token is fundamentally indistinguishable from a spelling typo by string
comparison, so short one-edit substitutions such as "Kim" → "Tim", "Sam" →
"Pam", or "Rob" → "Bob" are STILL accepted after payment. This is
self-serviceable by the booking owner (`booking.memberId === actor`) on
PAID/CONFIRMED bookings and cannot be closed in code. Its only mitigation is the
`GUEST_TYPO_FIX` audit trail, which admins should periodically review for
suspicious post-payment renames.

A price reduction against an issued-but-unpaid Xero invoice (pay-on-account,
no captured payment) is corrected for the full net delta — there is no captured
money and therefore no cancellation-policy tier to apply — via a modification
credit note against the primary invoice, which is never reissued. Consequently
the true outstanding balance on such an invoice is the current `finalPrice`
plus any billed change fee, i.e. the original total minus the modification
credit notes already issued. Cancellation must clear that true outstanding and
must not read the captured-amount mirror (`payment.amountCents`), which stays at
the original total until asynchronous Xero reconciliation folds the credit note
into `refundedAmountCents`.

The paid-path twin of that rule: cancellation of a booking with a captured
payment computes its refundable base as
`min(amountCents − refundedAmountCents, finalPrice + changeFee) − changeFee`,
never from the raw Payment mirror alone. Prior reductions can leave the mirror
stale (an Internet Banking invoice paid at its reduced amount, or a
penalty-window retention), and an uncapped base pays out more than the booking
is worth. The cancel preview applies the same cap so the member is never
promised more than the cancel will pay.

A credit-settled modification reduction allocates against the payment's
captured transactions (`applyLocalRefundAllocation`) in the same transaction
that writes the `MemberCredit`, exactly as a card-settled reduction does via
the refund ledger. `refundedAmountCents` therefore reflects every settlement
method, and no ordering of edit/cancel operations may produce a different
total payout (refunds plus credits) than another ordering reaching the same
final state.

A net-positive booking edit that mixes a price reduction with a larger
late-change fee bills Xero the SIGNED components on one supplementary invoice
(#1356): a negative price-adjustment line beside the positive fee line, so the
invoice total and the payment recorded against the Stripe clearing account
both equal the net the member was actually charged — the same net the
additional Stripe PaymentIntent captured. The negative line posts to the
`hutFeeRefunds` account mapping, like every other give-back (a club that
prefers a single ledger line maps `hutFeeRefunds` to the same code as
`hutFeesIncome`); positive lines stay on `hutFeesIncome`. Clamping the negative component
would over-record income and Stripe-bank receipts by the dropped reduction
and break bank reconciliation. A supplementary invoice exists only for a
positive net; a mixed-sign edit whose net is zero or negative settles through
the modification credit-note paths, and both the outbox enqueue and the
executor refuse (skip, replay-safely) rather than gross-bill the fee. The
booking-vs-Xero repair pass applies the same rule: it verifies supplementary
invoices against the modification net and queues missing ones with the signed
components. On the credit-note side the repair pass sizes by STORED evidence
(#1427): abs(net) is only an upper bound, because the primary path caps the
credit at the policy-limited settlement the modification row cannot
reconstruct. Queue actions and the amount-evidence expectation prefer the
resolved note's own enqueue payload (then oldest-first — the first enqueue
is the primary-path settlement decision; CANCELLED attempts rank last), and
replaying that amount rebuilds the identical amount-embedding correlation
key, so the local outbox dedup holds and a recent attempt that already
reached Xero dedups within Xero's idempotency window — then link metadata,
then executed note totals, then (last resort) a bare legacy payload.
Operation evidence, object resolution, and blocking detection are all
discriminated by the operation's queue-type hint: the immutable `queueType`
COLUMN (#1347), then the payload's own name, then the correlation-key
segment — decisive for the pre-column executed ledger, whose payloads were
overwritten at dispatch before the column backfill copied them. An
account-credit-note op beside the invoice-applied note (same
entityType/operationType) therefore never sizes, resolves as, blocks, or
pollutes the mismatch evidence of the invoice-applied note — in the
worst case that confusion allocated the member's UNAPPLIED account-credit
note against the already-paid primary invoice (double-refund exposure). A
net-negative modification positively settled by an account credit note (link
role or executed op hint) is complete as-is: it has no invoice-applied note
to repair and produces no finding. A
stored amount outside (0, abs(net)] is ignored as inconsistent, so an
over-sized note still flags against abs(net); the deliberate limit of
evidence-first is that a wrongly-enqueued amount INSIDE the range reads as
the app's recorded decision and reports clean — the alternative (flagging
every non-abs(net) note) drowned real drift in a false positive on every
policy-tiered booking. When no stored evidence exists and the payment has
captured money (by aggregate status or a captured transaction row), BOTH the
missing-note queue and the missing-allocation queue become manual-review
findings instead of auto-applying abs(net); auto-queueing abs(net) remains
correct only for the no-captured-payment case, where the full delta is a
pure bookkeeping correction (#1015). A live-but-not-retryable credit-note or
allocation operation surfaces as blocked rather than silence (and a
FAILED-unretryable one says so, not "pending"). The manual retry stack replays the operation's STORED amounts
first (the #1354 queued-payload-first rule): the Xero idempotency key embeds
the amounts, so replaying the enqueued values keeps the retry deduplicable
against the original attempt, preserves a policy-limited credit-note
settlement the modification row does not record, and lets the enqueue-time
`queueType` distinguish an unapplied account-credit note from an
invoice-applied one. Only fully-legacy rows fall back to the signed
modification record — a rebuilt supplementary invoice keeps its reduction and
a rebuilt credit note refunds the absolute net, never the absolute price
component alone (which would over-credit by the fee).

A cancellation's card-refund debt must be durable before any external call
(#1349): the claim transaction that flips the booking to `CANCELLED` also
writes the payment-recovery operation, carrying the per-transaction refund
allocation frozen from the under-lock read. No crash point between the claim
commit and the Stripe refund may leave the debt unrecorded, and no combination
of the inline refund and the recovery cron may pay it twice — both execute the
same frozen slices, so they mint identical Stripe idempotency keys and Stripe
replays rather than repeats. The mirror of this rule is the group-cancel
settlement, which persists its per-child `refundPlan` before its Stripe refund
for the same reason.

Xero contact resolution (`findOrCreateXeroContact` /
`createXeroContactForMember`) performs every provider call — OAuth refresh,
searches, creates, and their retry sleeps — OUTSIDE any database transaction
(#1355): concurrent duplicate creation is bounded by the member-scoped Xero
idempotency key, and only the local link write takes a SHORT advisory-locked
transaction with a re-check (first-writer-wins against a concurrent
resolver). Operation-log success is recorded post-commit only; a local-link
failure after the Xero call marks the operation FAILED, never SUCCEEDED for
rolled-back state.

Stepped Stripe refunds settle into Xero as per-delta credit notes whose cents
must sum exactly to the payment's refunded total (#1354). The amounts billed
to Xero are derived from EXECUTION-TIME state (`refundedAmountCents` minus the
sum of active covering notes), never trusted from an enqueue-time watermark —
so operations executing out of order, replays through the retry stack (which
re-enters delta mode via the queued payload or the enqueue-time `queueType`
column), and races between enqueue and execution all converge on the same
books. Inbound reconciliation MERGES link metadata over the outbound
per-delta keys instead of replacing them; the outbox processor fails errored
operations for every queue type (keeping them replayable rather than
RUNNING-stuck dead-ends); the daily credit-reconciliation cron re-enqueues
the uncovered delta for any flagged payment so historical gaps self-heal; and
a partial unique index allows at most one ACTIVE outbox operation per
correlation key (owner-approved defence in depth — terminal rows may repeat
the key across attempts).

For `source: STRIPE` payments the local refund ledger is Stripe-truth and
inbound Xero reconciliation may only raise it, never lower it (#1353). The
inbound credit-note repair keeps the local `refundedAmountCents` when the
Xero-derived total is below it (logging and raising the deduped Xero sync
alert instead of rewriting), and never flips a REFUNDED/PARTIALLY_REFUNDED
Stripe payment back to SUCCEEDED from Xero-derived data — an operator voiding
a refund credit note in Xero cannot "un-refund" money Stripe has already paid
out, and a missing refund-delta credit note can no longer silently lower the
ledger the missing-credit-note detector compares against (which previously
self-masked the divergence). Internet Banking payments are the deliberate
exception: Xero is their payment rail, so the repair remains authoritative in
both directions for them.

Cancelled-booking soft-delete may hide an operational duplicate only when it
preserves the booking row and no external money/Xero history needs to remain
operator-visible by default. Balanced internal modification deltas that net to
zero are not external financial history by themselves.

## Analytics And Privacy

Google Analytics must not load unless ALL of the following hold (#2573):

- the Analytics module is enabled at Admin → Modules (the master switch);
- a valid GA4 measurement id is stored in `AnalyticsSettings` — the database is
  the sole canonical source, `NEXT_PUBLIC_GA_MEASUREMENT_ID` is not read
  anywhere at runtime, and there is no fallback to it;
- the route is analytics-eligible under the fixed, application-controlled policy
  in `src/lib/analytics-route-policy.ts`; and
- the visitor has explicitly accepted, **whenever the consent banner is
  enabled**.

While the banner is enabled and no accepted choice is recorded at the club's
current consent revision, nothing at all reaches Google: no tag load, no
request, no cookieless ping and no consent-status signal. Declining or
dismissing the banner both count as denied.

While the banner is disabled the tag loads automatically on eligible routes, a
decline recorded *while the banner was showing* is invalidated once, and a
subsequent opt-out through the public Analytics preferences control is honoured
at any consent revision — so the preferences control can never be made
ineffective by turning the banner off.

Advertising storage, advertising user data and advertising personalisation are
denied in every consent signal, in both banner modes, with no setting that
changes it.

Every page view **this application sends** carries `origin + pathname` only, and
is sent only for an eligible route. Never a query string, never a fragment, and
never a reset token, invitation token, verification code, PIN, email address,
member id, booking id or payment id — including in the referrer, which is
sanitised before Google sees it.

It sends **exactly one such page view per address** across client-side
navigation: `send_page_view: false` suppresses the one the `config` call would
send, and the manual event is de-duplicated against the last location actually
sent.

**Both of those hold end to end only if the GA property's enhanced-measurement
option “Page changes based on browser history events” is switched off.** It is a
Google-side setting, on by default for a new web stream and not controllable from
`gtag`, and it works by watching the browser's own history rather than by asking
the application — so with it on Google adds a page view of its own on every soft
navigation, including the navigation that LEAVES the public website for an
excluded route. Next flips the URL in `HistoryUpdater`'s `useInsertionEffect`
(the commit's mutation phase, `next@16.2.12`), while the runtime's kill switch is
a passive effect destroy React schedules after paint, so the resident tag
observes `/login`, `/dashboard` or `/book` while `ga-disable-<id>` is still
false. Whether the resulting hit carries the browser's raw URL or inherits the
sanitised value already `set` on the tag is Google's internal behaviour and is
not verifiable from this repository; under either reading a page view leaves for
an address the policy excludes. The setup panel and `docs/guides/integrations.md`
therefore make switching it off a REQUIRED setup step, and state the disclosure
rather than the double count as the reason. The application cannot switch it off
itself, which is why this is a documented operator obligation and not an
enforced invariant.

Leaving the public website is part of the same guarantee. The runtime is mounted by
the public website layouts only, so a soft navigation into the member, admin or
login/recovery groups unmounts it — and because neither that unmount nor removal of
an injected script node can unload an executed library (and Next may retain the node
for the document), the unmount sets Google's per-id kill switch and queues a denial.
A visitor's opt-out is propagated to other open tabs the same way, over the `storage`
event.

The per-browser choice (`analytics-consent.v2`) stores the applicable consent
revision and which surface recorded it, and is honoured on revisit. Only the
explicit “Ask visitors to choose again” admin action bumps the revision; an
ordinary settings save never does. Every read and write of the configuration is
permission-checked server-side, every change is audit logged, and a save
invalidates the public configuration cache so a removed or invalid measurement
id can never leave a stale tag active.

Every one of these fails CLOSED: a missing row, an invalid measurement id, a
disabled module or a database read failure all mean no analytics, and the public
website still renders normally.

## Membership Lifecycle

Membership application, nomination, cancellation, archive, delete, family, and
dependent changes must preserve financial history, booking and guest history,
audit history, required family/dependent history, privacy preferences, and Xero
contact/link history where required.

A membership cancellation never credits money owed for a membership that
continues (#2400). One Xero subscription invoice covers every member of a family
or billing group, its lines are per fee component rather than per member, and the
cancellation credit note is for the invoice's whole `amountDue` — so it is raised
only when the leaving member is the last member that invoice covers who has not
themselves been cancelled. "Covered" is the union of
`MemberSubscription.xeroInvoiceId` and the charge's ACTIVE
(`releasedAt IS NULL`) coverage claims: either one can be the only record of a
covered member — a member already PAID when the invoice was raised carries the
coverage claim alone, because `createXeroMembershipSubscriptionInvoice` never
overwrites a PAID subscription, and rows predating coverage claims carry the
invoice link alone — and an uncertain covered set must never authorise wiping a
balance. The coverage half resolves its member through `subscription.memberId`, a
real foreign key, never through the row's own denormalised `memberId`, which is
on member-merge's FK-less snapshot list and is left pointing at a deleted loser.
The union only ever SHRINKS over the life of a cancellation, because a covered
member leaves it when `cancelledAt` is set and nothing in the app writes
`cancelledAt: null` (see the reactivation constraint below) — so an approval
decided on "the leaver is last" cannot be falsified before the outbox drains.

**At most one cancellation ever credits a given subscription invoice.** Several
different cancellations can each reach the "last covered member" state (a whole
family leaving), and the outbox claims per operation, so overlapping drains could
otherwise each raise a full-balance credit note under different Xero idempotency
keys. The right to credit one invoice is a durable first-writer-wins claim — a
`XeroObjectLink` row keyed on the invoice, inserted with `skipDuplicates` before
any Xero call — and a cancellation that loses it raises nothing at all. See
`docs/CONCURRENCY_AND_LOCKING.md`.

Paired with it: the unpaid-invoice approval blocker (#2392) excuses the member's
own subscription invoice **if and only if** the approval is still about to credit
its full balance. Both sides derive that from
`loadMembershipCancellationSubscriptionCreditPlansByMemberId`, so the excused set
is by construction the cleared set, and no cancellation can archive a Xero
contact with a balance nobody is going to credit. "Still" is load-bearing: the
credit-note operation is one-shot and completes even when it deliberately skips,
so once a whole family is cancelled the recomputed answer flips back to "would
credit in full" for members whose credit note already ran and skipped. The
exclusion therefore also consults that operation's RECORDED outcome, and an
invoice whose credit note has settled is never excused again.

Access role, seasonal membership type, age tier, Xero contact-group rule, and
committee assignment are separate axes. `MemberAccessRole` controls application
access via the legacy enum values (`USER`, `ADMIN`, `ADMIN_READONLY`,
`ADMIN_BOOKINGS`, `ADMIN_MEMBERSHIP`, `ADMIN_CONTENT`, `LODGE`,
`FINANCE_USER`, `FINANCE_ADMIN`, `ORG`) and/or a link to a club-editable
`AccessRoleDefinition` (label, description, per-area permission matrix).
`ADMIN`, `LODGE`, `USER`, and `ORG` are protected system roles: code-defined,
never editable or deletable, and Full Admin always keeps full permissions.
Deleting a definition is blocked while any member holds it. Custom
definition-backed roles are privileged for the Full-Admin
separation-of-duties gate, exactly like the seeded bundles;
`Member.role` is limited to `USER`, `ADMIN`, `LODGE`, `NON_MEMBER`, and
`SCHOOL`, and `financeAccessLevel` is a compatibility field. Neither field may
be used as a runtime permission gate or for new membership-category semantics.
Bundled and definition-backed rows are composed by the central admin
permission matrix (maximum level per area); they must not be projected into
legacy `Member.role = ADMIN`. Finance portal access derives from the merged
`finance` area level, never from the enum values or `financeAccessLevel`.
"User Type" (User / Organisation / Admin / Lodge) is a derived presentation
concept over access-role tokens, not a stored field: the Edit Member screen's
User Type select and the members-list Access column derive it via
`deriveUserType` (any privileged token other than `LODGE` ⇒ Admin; `LODGE` ⇒
Lodge kiosk; `ORG` ⇒ Organisation; otherwise User) and save it back as plain
`accessRoles` tokens — the Admin type's "Also a club member" checkbox is the
`USER` token. No new stored classification field may be introduced for it,
organisations cannot hold admin roles, and the server-side Full-Admin gates
on access-role writes remain the authority (the UI only mirrors them).
The admin population is protected against lock-out on the seven member-write
paths that can deactivate, de-login, or archive an EXISTING account (#1604,
extended by #1622): member edit, bulk update, lifecycle archive,
deletion-request approval, membership-cancellation approval, family-group
login-holder transfer (`POST /api/admin/family-groups/[id]/login-holder`), and
linking a member as a dependent with `disableLogin`
(`POST /api/admin/members/[id]/dependents/link`). On those paths the last
active, login-enabled Full Admin can never be deactivated, de-logined, or
archived — by anyone, including another Full Admin — and only a Full Admin may
deactivate, de-login, or archive an account holding a privileged role. Both
guards are enforced server-side; the last-admin count runs inside each
mutation's transaction, and "Full Admin" means an active, login-enabled member
with the `ADMIN` access-role row (the runtime grant), not a bare legacy
`Member.role`. The login-holder transfer both revokes and grants `canLogin` in
one operation, so it counts active Full Admins on its post-write read view — the
incoming holder's grant is part of the evaluated end-state. This is a
closed-world guarantee: every other `canLogin` writer in the codebase either
CREATES a brand-new member (booking-request/school/group/Xero-import contacts,
nomination and family-request dependants, plus admin member-create and CSV
member-import rows — whose `canLogin` value seeds a new row, never de-logins an
existing one), GRANTS `canLogin` on an existing member without ever revoking it
(the application-approval mapping **promotion path** — mapping an applicant onto
a non-login member sets `canLogin: true`, a fresh password, and
`emailVerified: true`, and cannot strand an admin because it only ever adds a
login), or passes `canLogin` only as a read/token filter
(`normalizeAssignableAccessRoleTokens`, list/where clauses), and so cannot
strand an existing admin. The one remaining path that can clear `canLogin` on an existing
admin and is NOT guarded is indirect — the age-down cron, where editing a date
of birth to a minor tier can indirectly clear `canLogin` (informational).

Membership-cancellation eligibility is an account-holder question, never a
permissions one (#2383). `isMembershipHolderRecord` (`src/lib/member-roles.ts`)
is the single rule, shared by `createAdminMembershipCancellationRequest`, the
admin member page's gate (pinned to that call site by the #2354 AST contract
test), and — since #2391 — the member-raised route in
`loadCancellationCandidates`: its own eligibility gate, and the per-candidate
verdict for every member of the requester's family groups. It refuses exactly
two record classes, both of which are not account holders: the lodge kiosk
device login, and booking-request contact records (`NON_MEMBER`, plus non-login
`SCHOOL` — the school flow's owner contact and teacher records).

The member-raised route adds exactly two further conditions, and they are about
being able to operate your own profile, never about what class of account it is
(#2391): the requester must be `active` and `canLogin`. Both are retained
deliberately — a closed account or one with no login of its own cannot raise
anything from its own profile — and neither narrows what is cancellable, because
those memberships remain reachable from a relative's family request and from the
member page. The family candidate query therefore carries NO role filter: a
relative who is also an admin, or an organisation account sharing the family
group, is listed and eligible, and the two non-holder classes are listed with a
reason rather than dropped silently. A self-raised participant is the requester,
so `requiresOwnConfirmation` is false and the row is created `REQUESTED` with
`confirmedAt` set — structurally identical to an admin-raised participant, and
never waiting on a confirmation email nobody would action (which matters most
for an organisation account, where there is no "adult participant" in the human
sense).

Both member-raised queries select `role`, `canLogin`, `financeAccessLevel` and
the `accessRoles` rows (`cancellationCandidateSelect`), for the same reason the
admin path does: an unselected column arrives `undefined` and would misclassify
a person as the kiosk device. Unit tests cannot catch that — Prisma is mocked —
so the query shape itself is asserted.

The kiosk test is a record-CLASS test, never a "holds lodge access" test.
`LODGE` is a freely tickable checkbox in the member editor ("Can use lodge kiosk
and lodge operations tools") with no exclusivity guard, so a Booking Officer who
also runs the lodge screen carries a `LODGE` row while being an ordinary
fee-paying person. Refusing on the presence of the token would hide the
cancellation action from such a person silently — the #2354 failure mode this
rule exists to eliminate. The rule is therefore `deriveUserType(...) === "lodge"`
over the record's login-blind stored tokens: refused only when `LODGE` is the
record's ENTIRE classification, which is exactly when the admin UI labels its
User Type "Lodge (kiosk account)". A record whose only tokens are `USER` and
`LODGE` is still refused, and is correct to be: it is indistinguishable from a
kiosk, and the refusal agrees with the User Type the operator is shown.

The `canLogin` term applies to `SCHOOL` alone and must not be generalised:
`SCHOOL` is the legacy role of BOTH a real organisation account (User Type
"Organisation", which stores an `ORG` row; the admin UI only ever sets it on a
login-capable account, though `createMemberSchema` does not enforce that on
write — an API caller could store `role: "SCHOOL"` with `canLogin: false`) and
every school booking-request contact (always created `canLogin: false`);
non-login is the line `MAPPABLE_CONTACT_SCOPE`
(`src/lib/non-member-contact.ts`) already draws between them. Every other
account is cancellable, including admins of every class — the rule this replaced
was legacy `role === "USER"`, which refused only the Full Admin bundle while
accepting all four scoped admin classes, and swept up organisations that hold
real fee-paying memberships. The privileged-target and last-Full-Admin guards
above are what make widening this safe: they run inside the approval
transaction, so a cancellation can never strand the club with no active,
login-enabled Full Admin, and only a Full Admin may approve one against a
privileged account. Separation of duties holds on the self-cancellation case a
widened rule newly reaches — `assertCancellationApprovalIsIndependent` refuses
an approval by the member who raised the request — so a club's sole Full Admin
must appoint a successor before their own cancellation can be approved. That
guard fails CLOSED on a null `requestedByMemberId` (the FK is
`onDelete: SetNull`, so hard-deleting the raiser nulls it): "we cannot tell who
raised this" means "not you", never "anyone". Rejection is unaffected, so such
a request is never stuck. The approval queue also surfaces, per participant,
whether the target holds privileged access (the guard's own predicate) and
whether it is an organisation account, so an approval that is permitted but
mistaken has a human check in front of it.

Both callers of the rule must feed it the same shape. The admin member page is
served `resolveAccessRoleTokens` output, which is EMPTY whenever
`canLogin === false`; the server reads the stored `MemberAccessRole` rows, which
are NOT cleared when login is disabled (the family login-holder transfer
de-logins cluster members and leaves their rows). `isMembershipHolderRecord`
therefore accepts raw rows and resolved tokens interchangeably and applies the
same login-clearing to both — the rows are consulted only for a login-capable
record — so the page can never offer an action the server answers with a 422.
The legacy `role` column is exempt from that clearing and still identifies a
de-logined kiosk. The AST contract test pins the call site, not the shape, so
this property is pinned by unit tests over the helper instead
(`src/lib/__tests__/member-roles.test.ts`).

Cancellation approval does NOT clear `MemberAccessRole` rows,
`financeAccessLevel`, or the legacy `role` column (#2383, confirming existing
behaviour). Archive approval, deletion anonymisation, and bulk deactivate all
leave them too. **`active: false` is the load-bearing flag**, not
`canLogin: false`: `requireAdmin` (`src/lib/session-guards.ts`) rejects an
inactive member, and it does not select `canLogin` at all, while
`getAdminPermissionMatrix` zeroes the matrix only on an explicit
`canLogin === false` — pass it a row set without that field and the full bundle
resolves. De-logined accounts that still hold live rows therefore exist today
(the login-holder transfer again), so nothing may be built on "no login means no
permissions". The dormant rows are what keep the account inside the
canLogin-blind `memberHoldsPrivilegedRole` guard for any later archive, and
deleting them on cancellation would be novel and would weaken that later guard.
The corollary is a hard constraint on any future work: **a path that reactivates
a member who kept privileged roles would silently restore every one of them.**
Any path that is added must clear or re-grant the roles deliberately.

What refuses reactivation today, precisely. Two paths write `active: true` onto
an existing member — bulk update (`action: "reactivate"`,
`src/app/api/admin/members/bulk-update/route.ts`) and the member edit service
(`updateAdminMember`, `src/lib/admin-member-detail-service.ts`). Every other
`active: true` in the codebase is on a `member.create` (or the schema's
`@default(true)`), i.e. a brand-new row that can resurrect nobody. Each of the
two refuses **three** states, with a 409 naming which:

- **Cancelled** (`cancelledAt` set) and **archived** (`archivedAt` set) — and
  nothing in the application writes `cancelledAt: null` or `archivedAt: null`, so
  those two states are terminal.
- **Deleted** — a member an approved deletion request has anonymised (#2620).
  This one is NOT covered by the `cancelledAt`/`archivedAt` refusal and was
  wrongly documented here as if it were. Anonymisation
  (`POST /api/admin/deletion-requests/[id]`) sets `active: false` but stamps
  **neither** flag, so a deleted account passed both guards, and `active` is
  exactly what bulk Reactivate flips. Because anonymisation also retains
  `canLogin`, `googleSub`, `emailVerified` and the second factor, `active: false`
  was the only thing between the erased person and a working session carrying
  their retained admin roles — and a deleted row is `active: false,
  cancelledAt: null`, i.e. squarely inside the members list's **Inactive**
  lifecycle filter, so an officer undoing a mistaken bulk deactivate could
  restore one without intending to. Deletion is recognised by the anonymisation
  markers it writes — the `DELETED_ACCOUNT` password-hash sentinel and the
  `@deleted.invalid` address — through the single shared predicate
  `isDeletedAccountRecord` (`src/lib/deleted-account.ts`). Every path that must
  recognise a deleted account consults that one predicate; a second copy of the
  marker test is the drift the module exists to prevent.

Reactivation refusal is not the whole defence for a deleted account, because it
protects only the application's own write paths. **A deleted account yields no
session even with `active: true`** (#2620): all three sign-in providers refuse on
the same predicate, independently of `active` — password and magic-link
`authorize` return null (the password path still burns its dummy bcrypt compare,
so the refusal stays timing-identical to an unknown email), and
`resolveGoogleProfile` returns `refused`. The Google path is the one that most
needs it: it resolves on `googleSub` alone, never on email, and anonymisation
does not clear `googleSub`. Behind all three, the per-request token refresh in
the `jwt` callback sets `sessionInvalidated` for a deleted member, so `auth()`
nulls the session on the member's next request — which also covers a session
minted *before* the deletion, since deletion revokes no tokens today. The
members list surfaces the state as a distinct "Deleted" lifecycle chip and takes
the row out of bulk selection, so the mistake is hard to make as well as
refused.

The marker predicate is a strong signal, not a schema invariant: it holds because
the anonymisation write is the only producer of either marker and nothing else
clears them. One path does overwrite both — the membership-application approval
MAP branch (`src/lib/nomination.ts`) rewrites `email` to the applicant's real
address and, on the non-login→login promotion, writes a fresh `passwordHash` — so
a mapped-over deleted row stops being recognisable as one. That path writes no
`active`, so it cannot itself mint a session for an inactive member. Stamping
`cancelledAt` (or a dedicated `deletedAt`) at anonymisation time would make the
state structural instead of inferred; it is deliberately still open, because it
would also change how deleted members appear in every lifecycle filter and count.

The same fact constrains session-authenticated routes: cancellation neither
clears the rows nor invalidates the JWT (`auth()` invalidates only on
`passwordChangedAt`, and re-stamps `token.accessRoles` from the retained rows on
every request), so any route that resolves admin access from a member row must
re-read `active` rather than trusting the rows. `requireAdmin` does; the display
preview branch of `GET /api/display/state` did not, and now does (#2383) — it
was unreachable before, because a cancelled member could not previously hold an
`ADMIN` row.

Application-approval mapping (link + overwrite of an existing member at approval
time) preserves the login-uniqueness and auth invariants: it never creates a
second `canLogin: true` member for an email (the create-path `canLogin` guard is
relaxed only when the sole login holder for the applicant email IS the mapped
target; a different login holder still 409s), and it never writes
`passwordHash`/`canLogin`/2FA/`emailVerified` on any target except the defined
non-login→login applicant promotion above — a login-capable target (applicant or
family) keeps its existing auth untouched, and a mapped family member's email is
never rewritten. Mapped targets keep their existing season membership coverage:
a target already holding a seasonal assignment or subscription for the season is
excluded from new-member subscription billing (surfaced as a note), so mapping
never double-charges or overrides an existing coverage arrangement. Confirmation
timestamps on a mapped target are set only when currently null and are never
regressed, and the overwrite is bound to a previewed HMAC token so any drift in
the computed outcome refuses the approval.
The applicant MAP path also carries the #1026 privileged-email gate: when the
mapping would change the login email of a login-capable target holding a
privileged access role, only a Full Admin may approve it — a scoped admin's
preview shows a blocking error, and because the acting admin's roles are
recomputed inside the approval transaction (part of the tokenized outcome), a
Full-Admin-minted preview replayed by a scoped admin fails closed with a 409
token mismatch. Same-email mappings and the non-login promotion path (where
`hasPrivilegedAccess` is canLogin-aware and therefore false) are unaffected.
On-behalf booking must not depend on `membership:view`: a Booking Officer
(`bookings:edit`) reaches the booking owner's or target member's family group
through the bookings-scoped pickers
(`GET /api/admin/bookings/[id]/eligible-family`, resolving the owner from the
booking server-side, and `GET /api/admin/bookings/eligible-family?forMemberId=`),
each gated on `bookings:edit` and returning exactly one member's family group
via the shared `resolveMemberFamily` helper. This decoupling means a club that
customises the Booking Officer role to drop `membership:view` can still attach
the correct member identity — and therefore correct member pricing — instead of
silently re-adding the member as a mispriced non-member. The member-scoped
`GET /api/admin/members/[id]/family` remains gated on `membership:view` for
membership surfaces.
MG4 (#2309) adds a **third** bookings-scoped picker, and it is the one
exception to the sentence above — stated here rather than left for a reader to
discover, because the exception is deliberate and owner-decided (D-20).
`/api/admin/bookings/[id]/member-guest-candidates` finds a member to add as a
**member guest** on the booking being edited, and it has two modes with two
different gates. The **email mode** (`POST`, the address in the body so it never
reaches an access log or a `Referer`) behaves exactly like the two pickers above:
`bookings:edit` only, no membership access required. The **name mode** (`GET`,
a name fragment) **does require `membership:view`**, and a Booking Officer
without it gets a 404 on that mode alone — the same answer the member route
gives when open search is off — and falls back to the exact-email box. That
preserves #1376 in full: the officer keeps every capability, including correct
member identity and member pricing, and loses only a type-ahead over the
membership roll they were deliberately not given access to. A picker that
browsed the whole roll from inside a booking would have undone #1376 through a
door nobody thought to look at. The same decision statement governs whether the
club's member-facing open-search setting binds an officer (it does not) — see
the member-guest consent cluster above.
On-behalf CREATION is aligned with modification (#1313/#1442): `/api/bookings`,
`/api/bookings/quote`, and `/api/promo-codes/validate` authorize a
`forMemberId` via `bookingManagementAuthorizationRole` (`bookings:edit`), so a
Booking Officer and a Full Admin drive identical on-behalf behaviour. A
`forMemberId` from a caller without `bookings:edit` is rejected (403) — a quote
or promo check must never silently price the caller instead of the target. No
on-behalf actor may target themselves (separation of duties): an admin's or
officer's own stays go through the member `/book` flow and normal member
payment paths. Portal context determines intent: a dual-hat account
(`USER` token + admin roles) self-books as a plain member with NO admin
bypasses — email verification, Xero-link, subscription, guest-subscription,
and minimum-stay gates all apply to self-bookings; the gate bypasses are keyed
to authorized on-behalf bookings only. Only admin-only accounts (no `USER`
token) are redirected from the member wizard to `/admin/book`.
A Booking Officer may also inline-create a **non-member booking owner** on
`/admin/book` (#1935): `POST /api/admin/bookings/non-member-contact`
(bookings:edit — the #1376 on-behalf scope) mints a non-login owner identical to
what the public booking-request approval creates, with SERVER-FORCED
`role: NON_MEMBER`, `canLogin: false`, `ageTier: ADULT`, and — unlike the
booking-request pipeline, whose verified public address justifies `true` —
`emailVerified: false` (an officer-typed address is unverified). The input
accepts only name/email/phone, so those forced fields cannot be tampered via
payload. Dedupe is suggest-and-pick and never silent reuse: several non-login
contacts may legitimately share an email (the `Member_email_login_unique`
partial index only covers `canLogin: true`), so reuse requires the officer's
explicit pick and is validated by `assertMappableOwnerContact` (non-login
NON_MEMBER/SCHOOL, active, not archived); a login-capable exact-email match is
never reusable and blocks creation with a "pick them in the member search"
error. A walk-in with no email stores a club-internal placeholder on the
reserved `.invalid` domain (`Member.email` stays non-nullable — no schema
change): all outbound email to that owner is suppressed at the `sendEmail`
chokepoint, and the placeholder is excluded from Xero contact email-matching
(`findOrCreateXeroContact` skips the email search and sends an empty address) so
it is never used to match or pushed to Xero as a real address. Non-member
booking owners are priced identically to public booking-request non-members
(both feed the shared pricing engine with non-member guests).
Legacy membership lifecycle/classification code may read `Member.role` only to
distinguish compatibility categories such as non-login/non-member records until
that workflow is fully represented by seasonal membership type.
`SeasonalMembershipAssignment` stores per-season membership policy, including
the source of the assignment and an optional date-only `applyFrom` changeover.
Age tiers remain separate because the same tier can be Full, Life, Associate,
Family, School, or another
configured type. Age-tier Xero groups and membership-type Xero groups may both
exist; duplicate exact rules and multiple managed rules for the same scope are
not valid.
Built-in membership types can never be deleted or merged. A custom type may be
deleted only when it has zero `SeasonalMembershipAssignment` rows; a custom type
that still has assignments must be merged into another type first. A merge
requires an active (non-archived) target that is not the source and whose
allowed age tiers cover every affected member's current age tier. A member on
`NOT_APPLICABLE` merges cleanly only when the target type also allows N/A
(`membershipTypeAgeExemption` FORCED or ALLOWED); the sole exception is
organisation members, whose N/A is a global org force independent of the type's
tiers, so they merge onto any target (#2106). It reassigns every source
assignment to the target and
deletes the source in one transaction, writing both a `MEMBERSHIP_TYPE_MERGED`
and a `MEMBERSHIP_TYPE_DELETED` audit record. Because reassigning an
assignment's membership type never changes its `(memberId, seasonYear)`, the
merge cannot violate the per-season uniqueness constraint. Merges (like every
other seasonal assignment change) do not synchronously resync Xero contact
groups; reassigned members reconcile through the existing periodic/mismatch Xero
tooling, and the admin is warned before confirming when the source and target
Xero rules differ.
The `NOT_APPLICABLE` age tier is the single "no age" classification, driven by
two independent forces resolved by one shared helper
(`resolveEnforcedAgeTier`, `src/lib/age-tier-enforcement.ts`) applied at each of
the enumerated `Member.ageTier` write sites: admin member edit, self-service
profile, delegated family details, seasonal-assignment save, roll-forward into
the current season, and bulk set-role. (The Xero member-import is a separate
write path (#2108): for NEWLY-created members it sets the tier directly — a
FORCED type forces N/A, else the explicit mapped tier, else the DOB-derived
tier, else ADULT — and for matched-EXISTING members it routes through the
seasonal-assignment save above, so this same helper applies.) Precedence,
highest first:

1. **Org force.** Organisation-type members (the `ORG` access role or the legacy
   `SCHOOL` role) always carry `NOT_APPLICABLE`, on every create/update.
2. **Type force.** A member's CURRENT-season membership type is age-exempt when
   its configured `allowedAgeTiers` (`MembershipTypeAgeTier`, #2069) classify as
   `membershipTypeAgeExemption(...)`: **FORCED** = the set is exactly
   `{NOT_APPLICABLE}` — every member on the type is N/A, like an org; **ALLOWED**
   = N/A appears alongside real person tiers, so an admin may hand-pick N/A per
   member while others keep a real tier; **DISALLOWED** = N/A is absent and no
   member on the type may hold it. `ageGroupsApply` (a pricing-shape flag) is
   deliberately NOT consulted.
3. **Manual N/A.** Only accepted when the type is ALLOWED; a previously
   hand-picked N/A is preserved when a later edit submits no tier. A manual N/A
   is rejected for any other member.
4. **DOB-derived restore.** Otherwise the member holds a real person tier: the
   DOB-derived tier via `computeAgeTier` when a DOB exists, else `ADULT`. This is
   what un-forces a member reclassified away from org, or moved onto a
   DISALLOWED type.

Configuration and lifecycle guards:

- Age-exempt config (any `allowedAgeTiers` containing `NOT_APPLICABLE`, FORCED or
  ALLOWED) is valid ONLY on types whose subscription behaviour is
  `NOT_REQUIRED`, so N/A can never bypass the subscription lockout on a paying
  type. Enforced on type create/edit.
- A type allowed-tiers edit is blocked while it would strand a
  current/future-season assignee: either becoming FORCED while a person-tier
  member is assigned, or removing `NOT_APPLICABLE` while a NON-ORG member is
  still on N/A (org members are exempt — the global org force keeps them N/A
  regardless of the type). This mirrors the merge coverage rule; the admin
  reassigns/reclassifies those members first. The offending-assignee check is
  repeated inside the config-write transaction so a concurrent change cannot slip
  a stranded member past the guard (#2106).
- A change that flips a member TO N/A is blocked while they are still a linked
  guest on someone else's future booking. This block is uniform across every
  N/A-flip site: the seasonal-assignment save (the change preview lists those
  bookings for removal first), the admin member edit (manual N/A pick and org
  grant), and the bulk set-role ORG grant (blocked members are reported as
  per-member failures — like not-found ids — so the rest of the batch still
  applies). A FORCED/org flip that leaves `ADULT` sweeps the member's future
  shared-double placements (#1756). The seasonal-assignment save surfaces the
  old/new age tier in its critical audit record, and binds the resulting tier
  into the preview's HMAC token so a tier-relevant drift is stale-detected. The
  same seasonal-assignment save also backs the members-page BULK membership-type
  change (#2107, `bulkSaveSeasonalMembershipAssignments`): each member is
  previewed and saved individually with its own HMAC token and its own critical
  per-member audit row (the run adds one important-severity summary audit), a
  stale token or a linked-guest block isolates that member as a per-member
  outcome without aborting the rest, and the up-to-100 per-member Xero
  contact-group syncs are suppressed in favour of one deferred batched reconcile
  of the changed members after the loop.
- Roll-forward into the current season reconciles each copied member's age tier
  AFTER the copy commits, in bounded chunks (one transaction per chunk, each
  re-reading member + type state) so no single transaction spans the whole
  membership; a failed chunk is logged and skipped (the enforcement sites
  self-heal). The reconcile phase writes one critical summary audit row with the
  reconciled/swept counts and a bounded per-member before/after sample (#2106).
- The Xero member-import (#2108) only ever CREATES current-season assignments,
  never modifies an existing one. That never-overwrite invariant is enforced by a
  PRE-READ skip, not by the save path: when a mapped group carries a
  `membershipTypeId`, a matched-EXISTING member who already holds a current-season
  assignment is filtered out and reported before any write (remediation is the
  bulk-assign tool). A matched-existing member WITHOUT a current-season assignment
  is routed through `saveSeasonalMembershipAssignment` (`source` `IMPORT`;
  existence check, age-exemption force, shared-double sweep, per-member audit; the
  preview-token staleness 409 is a race backstop). The newly-created members'
  `createMany` batch — never the save path — is what is exempt from the
  change-preview gate; it writes an `IMPORT`-source assignment with
  `skipDuplicates`. A membership-type mapping additionally requires
  `membership:edit` on top of the route's inferred `finance:edit` — a
  finance-only admin cannot open the assignment write path. The import writes
  one `important` summary audit row and never triggers a synchronous whole-group
  Xero resync.

`NOT_APPLICABLE` never has an `AgeTierSetting` row: it has no age range, is
displayed as "N/A", and is excluded from every age-based automation — the season
age-up cron, age-tier Xero contact-group sync (N/A members are never added to a
managed age group; a leftover membership is surfaced as a mismatch instead), and
age-based subscription requirements. N/A members are also exempt from membership
entrance fees: both Xero entrance-fee invoice paths (direct and outbox) skip them
before any amount — including an explicit override — is considered. Booking
guests are always people with a real age tier: `NOT_APPLICABLE` is not a bookable
tier, and an N/A account (organisation or age-exempt human) cannot be linked as a
booking guest.
Committee assignment controls public committee/contact presentation
only. Do not add committee positions to access roles or `Member.role`.
`CommitteeRole` master records and `CommitteeAssignment` member links can be
active/inactive independently of access role and seasonal membership type, and
newly linked assignments are hidden until explicitly published by an admin.
A member photo (`Member.photoImageId` → a `kind = MEMBER_PHOTO` `MediaImage`) is
served only through the scoped `/api/members/[id]/photo` endpoint, never the
public `/api/images/[id]` content path — that content route enforces the split
in code by returning 404 for any non-`CONTENT` row, so the invariant holds even
if a `MEMBER_PHOTO` id is learned. A photo is public **only** when the member
is active, holds an active, published `CommitteeAssignment`, **and** the club has
`PublicContentSettings.committeePhotoDisplay != NONE` — the same two conditions
`/api/committee` applies, so every publicly-rostered member is the set whose
photo is servable; otherwise it is visible solely to the member or a
`membership:view` admin, resolved through the same shared session guards the
upload/remove methods use (`requireActiveSessionUser` / `requireAdmin`), so the
serving path cannot skip the force-password-change or two-factor gates (#2242).
Every refusal on that path is the same 404, whatever the reason, so an
unauthorised caller cannot tell a real member id from one that does not exist.
The photo rule is those two conditions alone: the roster
endpoint additionally applies a pathological `take: 500` backstop
(`src/app/api/committee/route.ts`) against a misconfigured or hostile admin
publishing an absurd number of assignments on an unauthenticated public route.
That backstop is far above any real committee (typically <30) so it never trims
a genuine roster, but it is a display bound, not a narrowing of the predicate —
past 500 published assignments the roster would list fewer members than have
servable photos, which is the safe direction (a photo is never made public by
being trimmed off the roster). The committee-public ETag is
an opaque digest, never the raw `MediaImage` id. `committeePhotoDisplay` governs
both halves together — it decides whether the roster renders photos AND whether
the bytes are anonymously servable — so switching it to `NONE` genuinely takes
the images off the public internet. It only ever narrows: it never makes a photo
public that the assignment predicate does not already allow, and it never hides a
photo from the member themselves or a `membership:view` admin (those responses
switch to `private, no-store` instead of the short public cache).
Every stored image has its EXIF/XMP/comment metadata (camera GPS) stripped
first, on every path that stores image bytes: the member-photo upload, the
admin image library, the image manager's batch upload into `public/images`, the
config-transfer bundle import, and the inline club logo held as a base64 data URI
on `ClubTheme.logoDataUrl` (written by the site-style save and by the bundle
import, and rendered inline on every public page). The member-photo path fails
**closed** (an unconfirmable strip rejects the upload, because it is personal
data on a narrow purpose-built path); the others fail **open** through
`storableImageBytes` / `storableLogoDataUrl` — they store the original and log a
warning — because blocking a legitimate admin content upload, a site-style save,
or an operator's whole configuration restore is the worse outcome there. `gif`,
`avif` and `svg+xml` have no stripper and are always reported as unconfirmed, so
they log rather than claim a clean strip. `POST /api/admin/site-style/logo` needs
no strip step: it re-encodes through sharp, which drops metadata unless asked to
keep it.
Committee contact routing is chosen per assignment via
`CommitteeAssignment.contactEmailMode` (`ROLE`, `MEMBER`, or `CUSTOM`, default
`ROLE`). `ROLE` uses the role email alias stored on `CommitteeRole`, `MEMBER`
uses the linked member's own email, and `CUSTOM` uses
`CommitteeAssignment.contactEmailOverride` (required and email-validated when
the mode is `CUSTOM`; forced null under `ROLE`/`MEMBER`). If the selected mode's
address is missing or deactivated, delivery falls back to the role email and
then the member's email so public contact mail is never black-holed.
Booking pricing, booking block checks, and effective subscription lockout may
depend on the member's seasonal membership type for the
booking season; application access and committee presentation must not.
Seasonal membership type changes require a guarded admin preview and reasoned
audit record. Existing future bookings are not automatically repriced by a type
change, and raw subscription, payment, and Xero history must remain intact even
when the effective subscription status is `NOT_REQUIRED`.

When the global two-factor module is enabled, password login is not sufficient
for protected app access. The Auth.js JWT must carry `twoFactorVerified=false`
until a server-side two-factor verification or enrollment endpoint flips it.
The Auth.js session-update trigger is reachable by any authenticated client
(POST `/api/auth/session`), so the jwt callback must never trust a
client-supplied `twoFactorVerified` flag. The claim flips only after the
callback consumes a single-use, short-lived challenge token minted server-side
by the verification and enrollment endpoints and stored hashed in
`TwoFactorSessionChallenge`. Route-group layouts and API guards must enforce
that claim; login form code must not be the only 2FA gate. TOTP secrets, email
OTP codes, recovery codes, and session challenge tokens must never be stored
in plaintext.

A `FamilyGroup` with zero `FamilyGroupMember` rows is inert: it never affects
booking eligibility, pricing, or any member-visible UI, because family
visibility and eligibility everywhere derive from `familyGroupMemberships`
(`getMemberFamily`, `resolveMemberFamily`), never from bare `FamilyGroup` rows.

*(Corrected by the member-guest epic, #2305. "Eligibility everywhere derives from
`familyGroupMemberships`" is no longer true of BOOKING-GUEST eligibility: with
the `memberGuests` module on, a member outside the booker's family group may be
added as a guest, and `familyGroupMemberships` then decides only whether that add
needs the other member's CONSENT — see "Member-Guest Consent". Everything else in
this paragraph — pricing, family billing, the memberless-group rule — is
unchanged, and the family boundary remains the single definition of "family" that
the consent planner, the authorization check and the D-8 collapse all read.)*
Family billing never infers a recipient from group role, login holder, or email
inheritance. In `BILL_FAMILY_VIA_BILLING_MEMBER` mode the explicit billing
member must be an active, unarchived member of that family; missing or removed
recipients are visible exceptions and those families are omitted from invoice
generation. In `BILL_MEMBERS_INDIVIDUALLY` mode there is no family-billing
surface: no billing member is required, requested, or flagged, because every
member is invoiced directly.
Memberless groups are created intentionally ahead of approval — the member
"create group from scratch" flow (#1681) files a memberless group with a
`PENDING` `GROUP_CREATE` request, and the legacy request-join flow leaves a
target-anchored group behind on rejection — and they may accumulate; they must
not be deleted casually because `FamilyGroupJoinRequest.familyGroup` is
`onDelete: Cascade`, so deleting the group destroys the request history. The
only paths from memberless to membered are admin approval of the `GROUP_CREATE`
request (which creates the requester's membership with role `ADMIN` and
auto-files any partner `ADULT_INVITE`) or the legacy target-anchored join flow.
A `CHILD_REQUEST` targeting a group with zero memberships must not be
approvable (422) until that group's creation request is approved.

When a `GROUP_CREATE` request names a partner by an email that matches no
registered member, that partner is invited with a single-use, hash-at-rest
`PartnerInviteToken` (#1682) instead of an `invitedMemberId`, modelled on
`NominationToken` (sha256 hash at rest, single use via `confirmedAt`, expiry,
reminder fields). The token carries `familyGroupId`, `invitedEmail`, and
`createdById`. The invitee registers through the normal membership process and
then claims the token, which files an already-accepted `ADULT_INVITE` into the
group — but only once the group is membered (approved); a claim against a
still-memberless group is refused. The claim is only honoured for a signed-in
member whose own email matches `invitedEmail`, so a forwarded link cannot join
a stranger's group. The create-group route returns the same success response
whether the partner email is a registered member or not, so it cannot be used
to probe membership. Outstanding tokens are visible and revocable to admins;
the inviter of a declared partner may also cancel their own outstanding
invitation from the profile Partner card (#1754) — own `createPartnerLink`
tokens only, unclaimed only, audited — and an idempotent daily cron sweep
hard-deletes expired tokens (TTL 30 days, longer than the 7-day nomination
TTL because the invitee must complete the membership process first).

The declared Partner/Husband/Wife relationship (#1742) is a `MemberPartnerLink`
row: a symmetric, consent-based link between two ADULT members, stored as a
canonical ordered pair (`memberAId < memberBId`, DB CHECK constraint — which
also makes self-partnering unrepresentable) with a `PENDING -> CONFIRMED`
lifecycle. It is independent of family groups and is the eligibility signal for
double-bed shared occupancy (#1741). Invariants: **at most one CONFIRMED
partner per member at a time**, enforced in `src/lib/member-partner-link.ts`
under `pg_advisory_xact_lock` on both member ids (sorted order, so pair
transactions cannot deadlock) and backstopped by two raw partial unique indexes
(`MemberPartnerLink_memberA/B_confirmed_unique WHERE status = 'CONFIRMED'`,
documented in `prisma/partial-unique-indexes.tsv`); both members must be ADULT
and active; consent is required from the other member unless (a) an admin
assigns the link directly (`assignedByAdminId` recorded, CONFIRMED
immediately; both members are then emailed unless the assigning admin chose
not to notify — the suppression is audited `notifyMember: false`, #1769a),
(b) the target has **no login** and the initiator is the adult currently
recorded as the target's details voucher (`detailsConfirmedByMemberId`) in a
group containing the target ("one login manages the family" — #2284 (S4)
replaced the old family-group-ADMIN gate; that voucher is self-assignable by any
adult login co-member sharing the group, so this one-step path is open to every
adult in the group, not a designated one. A login-holding target always consents
personally, and the no-login target's address is emailed that the link was
recorded), or (c) the link
forms on a `PartnerInviteToken` claim minted with `createPartnerLink` — the
claim itself is the consent, so the claim page discloses the partnership
before the claimer accepts, and both parties' eligibility (including the
inviter's login standing) is re-validated inside the claim transaction.
Confirming a stale request re-validates the initiator too — a link is never
confirmed that a fresh request could not create. Declined, withdrawn, and
dissolved links are
hard-deleted — history lives in the audit log — so the same pair can re-form
later without tripping the pair-unique constraint; either partner may dissolve
a CONFIRMED link unilaterally (the other is emailed); an admin removing a
CONFIRMED link likewise emails both members unless the admin chose not to
notify (suppression audited `notifyMember: false`, #1769a), while a
still-PENDING admin removal emails no one. When a link becomes
CONFIRMED, all other PENDING requests involving either member are pruned in the
same transaction. A member may have at most one outstanding outgoing PENDING
request. The member-facing request API accepts an arbitrary target only by
email (mirroring the family ADULT_INVITE flow); a memberId target must share a
family group with the requester so the endpoint cannot probe foreign member
ids. A by-email request must not disclose the target's confirmed-partner
status (D9, owner decision 2026-07-11): whether or not the target is already
partnered, the reply is the same generic "request sent if eligible" body —
same message, no link id or status — with the suppressed attempt audited
(`MEMBER_PARTNER_LINK_REQUEST_SUPPRESSED`) and no email sent; the target's
confirmed-partner check runs only after every requester-side conflict so no
error ordering re-opens the probe. Unknown-email (404) and
not-adult (422) feedback stays distinguishable, and the family memberId path
keeps its specific conflict errors. A link claim conflict on token claim (either side already has a confirmed
partner, inviter no longer eligible) skips the link without failing the
family-group join, and the skip is audited.

Parent/dependant links (`Member.parentMemberId` and `Member.secondaryParentId`)
are limited to **four generations and two parents**: a member may have at most
two parents recorded, and the longest root-to-leaf chain of parent links may be
at most three links long — great-grandparent → grandparent → parent → child.

The cap is checked **symmetrically** at link time, which is what makes it
independent of the order links were created in. Linking child C under parent P
joins two chains, so the rule is

```text
ancestorGenerations(P) + 1 + descendantGenerations(C) <= 3
```

and that total, not either half, is what must fit. `src/lib/member-family-link-depth.ts`
owns the constants, the two bounded graph walks, the shared 422 message, and the
Prisma `where` builders that express the same cap in SQL as bounded relation
nesting. **Every writer of a parent link enforces it**: the admin link route
(`POST /api/admin/members/[id]/dependents/link`), admin member-create
(`POST /api/admin/members` with `parentMemberId`), the family-group
`CHILD_REQUEST` approval on both its link-existing and create-child branches,
the membership-application/nomination family-member approval on both its
map-existing and create branches, and **member merge**. The last four never saw
the previous rule at all.

Merge is a parent-link writer by consequence rather than by intent, which is how
it went ungated: it never creates a link, but re-pointing the loser's inbound
links onto the master collapses two nodes into one and JOINS their family
chains. Two things the link-time cap forbids become reachable that way — a
merged node spanning six generations, and a cycle when master and loser are
already related by parentage in either direction (`nullSelfRelationCycles` does
not catch the second: it only nulls MASTER columns equal to the loser id, so a
loop closed through a third member survives it). `evaluateMemberMergeGuards`
therefore refuses both, as the `family_link_cycle` and `family_link_depth`
blockers, telling the admin to unlink first. Refusing is deliberate: which link
to drop is a statement about who is responsible for whom, and that belongs to
the admin.

The one writer that validates on the base client and writes in a later
transaction is admin member-create, so under READ COMMITTED a concurrent link
could deepen the parent's chain between its walk and its insert. The window is
milliseconds and the worst outcome is an over-deep chain rather than lost data;
every interactive link writer walks inside its own transaction and has no such
window.

The walks are deliberately robust on data that predates the cap. They are
level-bounded (so a cyclic or over-deep graph terminates rather than hanging),
they report the **longest** path rather than the shortest (a member reachable at
two depths counts at its deeper one, because that is the chain that would grow),
and a walk that hits the bound reports "at least bound+1", which refuses the new
link rather than accepting it on incomplete information.

**Parentage is recorded at ANY age; responsibility is not** (#2282, owner
decision 2026-07-26). A 16 or 17 year old can genuinely be a parent, and the
system previously could not record it: the admin link route refused a non-adult
parent, the candidate search never offered one, and the only workarounds were to
leave the child apparently parentless or to hang them off a grandparent —
both of which misstate who the parent is. The age rule turned out to be in the
wrong place. **The parent link is close to a labelling artefact:** every
substantial power is gated on family-group co-membership plus being an active
adult with a login, and none of those checks reads the parent columns —

| Power | Actually gated by |
|---|---|
| Booking on someone's behalf | `getAllowedGuestMemberIds` / `isActiveLoginAdultMember` (`src/lib/booking-guests.ts`) |
| Answering a consent request for someone | `familyAdultDelegateResolver` (`src/lib/member-guest-delegate.ts`) |
| Editing or confirming another member's details | active + login + ADULT + shared group (`/api/members/family/[memberId]/details`) |
| Being the contact of record for their mail | `validateInheritEmailSource` + `isUsableEmailSource` |
| Being billed | `billingFamilyGroupId` — group-based; no billing path reads a parent link |

Every row of that table lands on the same gate — family-group co-membership plus
an active adult with a login — and **#2284 asked whether that gate is too broad**
(today every adult in a family group has identical powers over every non-login
member in it) and **decided it deliberately** — see *The family group is the
authorisation boundary* below. Nothing in #2282 pre-empted that: this issue moved
no power onto the group gate, it only recorded that the powers were already
there rather than on the parent link.

So the only things recording a young parent grants are the word "Parent" on an
admin card and a mail-routing question, and the second is answered by the
transitive resolver walking **past** them to the nearest adult ancestor. The
lowering of the ADULT tier's minimum age to 16 was considered and **rejected**:
the boundaries are admin-configurable, but moving them would change fees,
subscription requirements and booking rules for every 16–17 year old in the club
to solve a records problem.

What remains on the parent side is `active`, `archivedAt`, and whether the
record is a PERSON at all — whether it is CURRENT and real, never capacity to
take responsibility — shared by both write paths, by the "Add Parent" candidate
search and by the admin UI as `dependentParentStateBlocker` /
`dependentParentEligibleWhere` in `src/lib/dependent-link-eligibility.ts`. An
inactive or archived member, and an organisation or school account, therefore
shows "Add Dependent" **disabled with the reason** ("This member is inactive —
reactivate them to add dependents") on both the create and link paths, rather
than the control vanishing or failing on save.

**Organisations are excluded by ROLE, never by age tier.** Dropping the ADULT
clause dropped the only thing keeping organisation and school accounts off the
parent side, and a school is nobody's parent — but `NOT_APPLICABLE` is the
age-EXEMPT tier (#1440, #2106), carried by age-exempt *people* as well as by
organisations, so filtering on it would bar real members and tell them they are
an organisation. `isOrganisationMember` (the ORG access token, or the legacy
`SCHOOL` role for a non-login account whose token is cleared) is the
classification, on the write routes and in the search's SQL alike. This is a
restoration of what the ADULT clause excluded by accident, not a narrowing of
"any age": every real age tier, INFANT included, may be recorded as a parent.

**The family group is the authorisation boundary, and every login-holding adult
in it is equal** (#2284, owner decisions 2 Aug 2026). When the system asks "may
this person act on that person?", the question it answers is *do they share a
family group, and does the actor hold a login* — never *which* adult is acting,
whether they are the target's parent, or whether the target agreed. The parent
link is a label, not a permission (the #2282 table above). This is now a recorded
decision rather than an accident of implementation: for a club of small,
mutually-trusting families it is the intended model, and the four protections
below are where it is deliberately softened for the members who cannot speak for
themselves — those with **no login of their own**, who since #2255 can sit up to
four generations from the adult acting for them. The investigation's original
"can see every co-member's data including parents' emails" power is **not**
restated here: #2424 (above) has since closed the parent-email exposure, so the
family read is now a whitelist, not an open book.

**The dividing line is `canLogin`, not age, and that is deliberate.** The age-up
job withholds a login from any member whose email is inherited from someone else
(`src/lib/cron-age-up.ts`), so an ADULT can remain a non-login member
indefinitely — and every gate here keys on `canLogin`, so such an adult stays
subject to the same powers a child is, and is exactly who the one-step partner
declaration below can target. Nothing changes *at* 18; the protections below
apply to every non-login member whatever their age.

The four powers over a non-login member, and how #2284 settled each:

- **Requesting cancellation of their membership (S1, owner decision: flag, not a
  second signature).** A non-login member is written already-confirmed on a
  cancellation request because they have no login to confirm with
  (`requiresOwnConfirmation` in `src/lib/membership-cancellation-requests.ts` is
  true only for a login-holder acting on someone else). Rather than add a
  second-adult signature, the admin reviewer is shown an explicit **"included
  without their own or a second adult's confirmation"** flag on any such
  participant (`includedWithoutOwnOrSecondAdultConfirmation` in
  `src/lib/membership-cancellation-admin.ts`), so an auto-stamped confirmation is
  never mistaken for a personally-given one and the judgement moves to the admin.
  Candidate eligibility is read through `isMembershipHolderRecord`, not
  re-derived. The request still executes only on admin approval.
- **Adding them to a booking (S2, owner decision: notify, module-independent).**
  A family-scope add now tells the added member — directly if they hold a login,
  otherwise the group's login-holding adults — reusing
  `familyAdultDelegateResolver.resolveNotificationRecipients`
  (`src/lib/member-guest-delegate.ts`), the same rule MG2 already ships. It is
  the missing half of #2250 self-removal: you can only take yourself off a
  booking you find out about. This is **general family behaviour, sent regardless
  of the `memberGuests` module switch**, registered with the booking
  `EmailBookingContext` so the #2258 per-booking "No emails" switch withholds it,
  and it carries a personal opt-out in `NotificationPreference` (it is an FYI, not
  a consent request).
- **Editing their details (S3, owner decision: read-only provenance).** A
  delegated edit was audited but never shown to the family. A read-only
  **"Details last confirmed by X on date"** line now renders on the member's
  family/onboarding cards from the already-stamped `detailsConfirmedByMemberId` /
  `detailsConfirmedAt` (`src/lib/member-family-service.ts`), added to the
  member-facing payload by the same deliberate whitelist the #2424 rule uses —
  the confirmer's NAME only, and they are already a listed family adult.
- **The one-step partner declaration (S4, owner decision: retire the role
  reliance) — formerly the one role-differentiated power, now aligned with the
  equal-adults boundary.** Declaring a CONFIRMED partner link over a non-login
  adult co-member in one step was the *only* thing that ever read
  `FamilyGroupMember.role` (it required the actor to hold `role: "ADMIN"`), and
  who held ADMIN was an accident of which flow created the group. It is now
  re-anchored onto `Member.detailsConfirmedByMemberId` — the adult recorded as
  having vouched for that member's details — plus a still-shared family group
  (`src/lib/member-partner-link.ts`). **That voucher pointer is self-assignable
  by any adult login co-member sharing the group**: `PUT
  /api/members/family/[memberId]/details` stamps it to whoever confirms the
  member's details, gated only on being an active adult login co-member with a
  complete profile (no admin or group-lead requirement) and overwriting any prior
  voucher. So the one-step power is **not** a lone designated "responsible
  adult" — it is available to every adult login co-member, which is exactly the
  "every login-holding adult in the group is equal" boundary above, and
  deliberately so; no code may treat `detailsConfirmedByMemberId` as naming a
  single, lead-appointed responsible adult. With the role reader gone,
  **`FamilyGroupMember.role` no longer gates authorisation anywhere** — and #2520
  finished the job in two halves: PR #2565 removed every writer (the
  group-creating flows, the join/invite/nomination/partner and Xero-import paths,
  and the demo seed), removed member-merge's vestigial `maxFamilyRole` upgrade,
  narrowed every `FamilyGroupMember` query with an explicit `select`, and marked
  the field `@ignore`; then
  **`20260803030000_contract_drop_family_group_member_role` DROPPED the column and
  removed the field from `prisma/schema.prisma`.** There is now no rank on a
  family-group membership at any level: not in the database, not in the generated
  Prisma Client, and not in the schema. **Membership in a group is the only fact
  the join table records.**

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
  No code may treat family-group membership as carrying a rank: **membership in a
  group is the only fact the join table records**, and every adult login
  co-member of a group is equal (the boundary above). Relatedly, the family-group
  join request no longer materialises a group around a consentless target with any
  role at all (`src/app/api/members/family/request-join/route.ts`).

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

  The stored values were **meaningless rather than frozen** for the whole interval
  between #2284 and the drop: nothing read them, and every row inserted after the
  runtime half took `'MEMBER'` from the database default because the client had
  stopped naming the column. That is why destroying them costs nothing
  behaviourally.

**What one MEMBER may see about another member's parent** (#2424, owner decision
2026-08-01). `GET /api/members/family` and `GET /api/member/onboarding` both
list, for every member of the viewer's family groups, the parents recorded
against them — and a parent link carries no shared-group requirement of its own,
so a listed parent can be somebody the viewer has no family relationship with at
all. The member-facing link is therefore built by WHITELIST, in two layers:

- **Always, however the viewer is related: `id`, `firstName`, `lastName`,
  `parentLinkType`, `inheritEmailFromId` — and nothing else.** That is the
  literal always-list, not a summary of one. Name and link type are what let a
  family see who the club believes their child's parents are;
  `inheritEmailFromId` is what the "(notifications)" marker on the family page
  is matched on, and an id pointing at whoever holds the mailbox is not itself a
  contact detail.
- **Only when the VIEWER shares a family group with that parent: `email`, plus
  the status fields `ageTier`, `active` and `canLogin`.** For a parent in none
  of the viewer's groups all four are ABSENT from the JSON — for the viewer's
  own parents as much as for anyone else's. The address is the point, but the
  status fields go with it because they are facts about a person the viewer has
  no family relationship with, and `ageTier` in particular would say whether a
  named stranger is a child. #2282 made that materially wider by allowing
  parentage at any age, so what this payload could reach stopped being other
  adults' details and started including children's. No member-facing client
  reads any of the three: the family page renders a parent as a name plus the
  notifications marker, and the onboarding wizard does not read parent links at
  all.

The rule is enforced server-side in `buildMemberFacingParentLinks`
(`src/lib/member-parent-links.ts`) and never by a client declining to render a
field: the JSON payload is the exposure, whatever the screen shows. Because the
visible link is assembled field by field rather than by deleting from a spread,
a column added to the query later cannot leak by default — and the tests pin
each branch's key set exactly, so widening either one has to be deliberate. Both
payloads read each parent's own `familyGroupMemberships` to decide — the family
service inside `FAMILY_MEMBER_PROFILE_SELECT`, onboarding through
`MEMBER_ONBOARDING_FAMILY_SELECT`, which exists so the onboarding GATE select
(run on every authenticated page render) does not pay for two joins it never
reads. **Admin surfaces are unchanged** — the admin member detail payload builds
its links from `buildParentLinks`, which still carries the email, because an
administrator's view of a member's contact details is not what this narrows.

Alongside the cap, the admin link route requires: the parent must be active,
non-archived and not an organisation account (**at any age tier**); the target
must not be archived, must not already be linked to that parent, must not
already have two parents, and **must not be an ancestor of the parent**. That
last one is now stated in its own right. Under the old
two-generation rule it was enforced only as a side effect — every ancestor of
the parent necessarily has a dependant, so the "already has dependants" clause
excluded the whole ancestor set — and relaxing the cap removed that cover. The
same explicit cycle check was added to the family-group `CHILD_REQUEST`
approval, which previously had no ancestry guard of its own for exactly that
reason. An **inactive** target is deliberately still linkable — only the parent
side requires `active` — and the dialog badges such a candidate "Inactive"
rather than hiding them.

The admin candidate SEARCH
(`GET /api/admin/members?dependentLinkEligibleFor=…`) and those write-time
guards are one predicate, `src/lib/dependent-link-eligibility.ts`, so a
candidate the search offers is a candidate the write route accepts **on
identity grounds** — subject to the request's own options, which the route
still validates separately (family groups the parent does not belong to, an
invalid inherit-email source, and the privileged-target and last-full-admin
guards when "disable login" is ticked). The mirror-image "Add Parent" search
(`parentLinkEligibleFor`) filters `active: true`, `archivedAt: null` and "not an
organisation account" through the same `dependentParentEligibleWhere` the write
route's predicate mirrors — and, since #2282, **no age clause at all**, matching
what that route now accepts — then applies the cap the other way round: the
member's own
dependants eat into the budget, the candidate parent's ancestors must fit in
what is left, and the member's descendants are excluded outright so the dialog
cannot offer a cycle.

**Ranking is presentation; eligibility is not** (#2425, owner decision 1 Aug
2026). That "no age clause at all" is a statement about who is ELIGIBLE, and it
still holds exactly. What #2282 also did, though, was let a family's children
compete for the picker's eight rows with the adult being searched for: ordered
by `lastName` then `firstName`, a household of children with a shared surname
filled every slot, and the adult was unreachable without extra typing the admin
had no way of knowing was needed. So the parent-candidate search now returns
**ADULTS first, then everyone else**, at the same page size — a re-ORDER of the
same set, not a filter. It is implemented as two complementary queries
(`ageTier: { in: [ADULT, NOT_APPLICABLE] }` and the matching `notIn`) over one
shared `where`, rather than an `orderBy`, because Prisma has no computed sort
key and sorting on `ageTier` itself would depend on the enum's declaration
order. **The line is drawn at MINOR / not minor, not at ADULT / not adult**, and
that is deliberate: `NOT_APPLICABLE` is the age-EXEMPT tier (see above), so a
row carrying it in THIS search is a real person — usually an adult on a FORCED
or N/A-allowing membership type — because organisations are excluded here by
ROLE and never by tier. Ranking them with `not ADULT` would have interleaved
them alphabetically among the household's children and left them crowded off
exactly the page this rule exists to fix. They sort among the adults by name
instead; nothing about the split claims they ARE adults, only that they are not
minors. `Member.ageTier` is NOT NULL, so `in` and `notIn` are exact complements
and the two halves are the same set, and the same count, an unranked query would
return. The split is windowed
correctly for pages beyond the first — this is a general list endpoint, and a
ranking that reshuffled on page 2 would drop and duplicate rows — and the
`total` the response carries is still the count of the WHOLE eligible set, which
is what lets the dialog say the page was cut short ("Keep typing to narrow this
down.", the #2308 member-guest finder's own sentence). Both surfaces DRAW that
sentence under the list and ANNOUNCE it (#2460), each through a live region that
is registered before there is anything to say and has only its content gated,
since a polite region injected already populated is silently dropped by some
screen-reader/browser pairings — the same house rule `PolicyFeedback` and the
view-only banners follow. The booking panel announces it on the end of the result
count its existing status line already reads out, rather than from a second
region of its own, so it is announced ONCE: two polite regions mutating in the
same commit are queued in no guaranteed order and one can be dropped outright.
The dialog, which has no such line, keeps its own `sr-only` region ABOVE the
results — above, because an invisible LAST child of a `space-y-*` stack still
moves the visible content above it, Tailwind hanging the gap off
`:not(:last-child)`. That region goes with the dialog when it closes, so what it
guarantees is "registered empty before the first search answers", which is the
case that matters. On both surfaces the sentence stays reachable twice in browse
mode, once from the region and once as the visible hint under the list: only the
ANNOUNCEMENT is deduplicated, because hiding the on-screen copy from assistive
technology would take the sentence away from the place the list actually stops.
The announced words are the drawn words, verbatim: the sentence must never grow
a count of who was left out, so it does not grow one for a screen reader either.
The ranking is scoped to the `parentLinkEligibleFor` parameter, so every other
caller of `GET /api/admin/members` — the members table, the exports, the other
pickers — issues exactly the query it did before.

Three rules about that predicate are load-bearing. First, the parent columns are
**nullable**, so every "not this parent" clause must be written as
`{ OR: [{ col: null }, { col: { not: id } }] }` — Prisma compiles a bare
`{ not: id }` to `"col" <> $1`, and SQL's `NULL <> 'x'` is UNKNOWN, which
silently hid every parentless member from the search (#2254). Second, the two
graph-shaped facts (is the candidate an ancestor of the parent, and how deep is
the candidate's own chain) cannot be read off a single row and are therefore a
**required argument** to `dependentLinkBlockers`, so a caller that forgets them
fails to compile — the same protection the old required relation probes gave,
which had to go because `take: 1` returns an arbitrary child and depth needs the
deepest. Third, an unsatisfiable depth budget must be expressed as a clause no
row can match, never as an omitted filter: `{ NOT: {} }` is a no-op in Prisma
and would fail open.

Two decisions here were taken by the delivering agent under D9's remit rather
than by the owner, and are **flagged for owner confirmation** (2026-07-27,
#2255): the depth number itself (four generations) and transitive email
inheritance as described below.

Delete eligibility counts **direct** dependants only, and that stays correct at
four generations. A middle generation holding dependants is still blocked, so a
delete can never strand a member whose only recorded parent it was; a
grandparent is blocked while their child is still linked to them, and becomes
deletable once that one link is cleared, at which point the grandchildren are
untouched because they were never linked to the grandparent. Counting
descendants transitively would instead block deleting a great-grandparent who
has no remaining link to anyone.

Family links grant **no billing or fee coverage**. Money-side coverage derives
from `FamilyGroup`/`FamilyGroupMember`, `Member.familyGroupId`,
`Member.billingFamilyGroupId`, `SeasonalMembershipAssignment` and the fee
schedules — never from the parent columns — so a three- or four-generation chain
bills exactly as the same members with no links at all. That isolation is
enforced by a source contract,
`src/lib/__tests__/family-link-billing-isolation.test.ts`, because it is one
`include: { dependents: … }` away from quietly ceasing to hold and the symptom
would be a mis-invoiced family.

**Email inheritance is resolved transitively but STORED FLAT** (#2255, D9 —
flagged for owner confirmation alongside the depth number). When a dependant is
set to inherit a parent's email, resolution walks UP from the chosen parent to
the nearest ancestor who can actually receive mail: an **adult**, not archived,
whose address is not a walk-in placeholder (`@no-email.invalid`, #1935 — those
are silently dropped by `sendEmail`). One hop is no longer enough, because with
four generations the direct parent is routinely a middle generation with no
address of their own, and resolving only one hop would leave that generation's
children with no reachable contact at all.

The walk is **nearest-first**: a closer ancestor always beats a further one, and
where two are equally near, the one reached through **primary**-parent edges
wins. Every member is visited at most once, so it is cycle-safe, and it is
bounded by the same depth cap as the links. The adult gate survives #2282
("parentage may be recorded at any age"): recording that a 16-year-old is a
parent is a fact about the family, whereas being the club's contact of record
for someone else is a responsibility function, and those stay adult-gated — so a
non-adult ancestor is walked past rather than used.

What it stores is the **terminal** source: `Member.inheritEmailFromId` always
points straight at the mailbox, never at a middleman. That is what lets every
reader (`getMemberEmail`, `member-email.ts`, the roster, the age-up cron, Xero
contact sync, the preference resolver in `email/core.ts`) keep its single
`inheritEmailFrom` join and stay correct at any depth. Do not "simplify" this by
storing a pointer at the direct parent — and note that **every writer must go
through the resolver**, not just the ones that felt like link operations: the
nomination approval and admin member-create both stored one-hop pointers until
#2255, and the Xero contact import wrote one with no validation at all.

`validateInheritEmailSource` enforces the guarantees that follow: the source is
an adult, with a real address, who does not itself inherit. The **adult** clause
there — and the matching one in `isUsableEmailSource`, which is what makes the
walk step past an unusable generation — is deliberate and survived #2282: a
16-year-old may be recorded as a parent, but being the club's contact of record
for someone else's notifications is a responsibility function, so their child's
mail routes on up to the nearest adult ancestor (most often the young parent's
own parent), and the link is **refused** if there is no such adult rather than
quietly making the minor the family's contact. The admin member detail page
resolves and displays that adult (`dependentEmailSource`) with the same walk the
writes use, so the routing is on screen before the dependant is added — and both
link dialogs resolve the parent the admin picks in the notification-recipient
list the same way (`GET /api/admin/members/[id]/dependent-email-source`),
because the list names PARENTS while the write stores whoever the walk lands
on. The age-up cron's parent handoff resolves it too, rather than mailing the
raw parent link. Its former "must point to a **primary** adult member" rule
(the source must have no parents) is
retired — it barred exactly the middle-generation source the four-generation
model needs — and the "inherit email from" candidate search was relaxed to match
AND tightened to exclude placeholder addresses, so the picker can neither hide a
source the write route accepts nor offer one it refuses. "Real address" means
neither club-internal `.invalid` domain: a walk-in `@no-email.invalid` (#1935,
silently dropped by `sendEmail`) or a deletion-anonymised `@deleted.invalid`
(which hard-bounces). Both are matched by `isPlaceholderContactEmail`; the second
was added in #2255 because a grandchild could otherwise keep resolving to an
anonymised grandparent forever. If the walk finds nobody, the link is **refused**
rather than quietly stored as "no inheritance": the admin asked for the
dependant's mail to reach a parent, and silently leaving it on the dependant's
own address is how a family stops hearing from the club without anyone noticing.
The family-group create-child branch keeps the explicit opt-out
(`inheritEmailFromId: ""`, "use the child's own email") its sibling branch has,
so that refusal never becomes a dead end.

A stored pointer is a snapshot of a past decision, so the resolver **re-reads the
member it names** before trusting it and keeps walking if that member has since
been archived, anonymised, left with a placeholder address, or **themselves been
linked as an inheriting dependant**. That last one is not optional politeness:
returning a chaining source makes a validating writer 422 with "cannot chain
through another inherited member" — naming a member the admin never chose — and
the unlink route, which has no validator behind it, would store the chained
pointer and break the flat-terminal invariant outright.

**Provenance, not identity, decides what unlinking clears.** Every pointer this
system derives from a parent link carries `inheritParentEmail: true`; a
hand-picked source carries `false`. The unlink route reads that flag rather than
asking whether the stored pointer names the parent being removed — a one-hop
test that was correct only while resolution was one hop, and that (before it was
fixed in #2255) left a member with no parent link and a permanent inheritance
from a great-grandparent, while reporting `clearedEmailInheritance: false`.

**Re-resolution on change is deliberately narrow, and this is the open edge.**
Exactly one automatic event re-points derived pointers: age-up. When a member
ages up, their own inheritance is cleared — they now have an address and a login
of their own — and their dependants' DERIVED pointers are re-resolved through
them, because those pointers only walked past them in the first place for want of
an address. Without that, a parent with both a mailbox and a login would never
receive their own child's notifications.

That sweep is scoped by WHERE the pointer currently points, not merely by who
the dependant's parents are. `inheritParentEmail` records that a pointer is
derived, but it cannot distinguish "derived by default" from "the admin
explicitly chose parent Q" — both store `true`. So a child with two parents whose
pointer names the other parent must be left alone, and the only sound test is
whether the current pointer names somebody the aged-up member's own chain could
have produced (themselves or one of their ancestors, since as a non-login minor
the walk could never have stopped on them). Selecting on the flag alone silently
moves a family's contact of record, which is the very consent question this job
must not answer by itself. **The general case is NOT handled**: if
an ancestor's email address changes, or a middle generation gains an address by
some other route, existing pointers keep naming whoever they named. That is
recorded here as a known limitation and flagged for the owner (2026-07-27, #2255)
because the fix is a consent question — silently moving a family's contact of
record is not obviously better than leaving it where the admin put it.

**Removing a member detaches, and declares.** All FOUR removal paths —
cancellation approval, archive approval, deletion anonymisation, and the
two-admin hard delete — clear links pointing at the member being removed. With four generations that member is often a middle generation, so the
sweep leaves their dependants without a parent link and anyone inheriting their
address without a mailbox. Those dependants are deliberately **not** re-parented
onto the grandparent: who is responsible for a member is a real-world fact, and
promoting it as a side effect of someone else leaving the club would record a
relationship nobody asserted.

All four therefore read who they are about to detach BEFORE nulling the columns
— afterwards there is no record of the links at all — through the one shared
helper, `src/lib/member-family-link-orphans.ts`. Cancellation, archive and hard
delete return `orphanedLinks` (always present, empty arrays when nothing was
linked), the admin page states who was detached, and all four name the same
members in their audit metadata. The hard delete is the one that leaves the
clearing itself to the database (`onDelete: SetNull`), which nulls the columns
but leaves `inheritParentEmail: true` standing beside a NULL pointer — a
combination no writer produces and no reader expects — so it also clears that
flag, guarded on the pointer already being null so it can never touch a live
inheritance. Deletion anonymisation additionally **sweeps the inheritance
pointers aimed at the member**, which it previously did not: it overwrites the
member's address with `@deleted.invalid` and nulled only their own pointer, so
dependants and grandchildren kept resolving club email to an address that hard
bounces on every send. Its parent LINKS are deliberately left in place — the row
survives for history, so the family structure is still true; it is only the
mailbox that must stop being used.

The notice deliberately does **not** claim the affected members now receive club
email at a working address. Several paths (`confirm-email-change`, the
family-group login-holder route, nomination) COPY a source's address into an
inheritor's own `email` column, so "their own address" is frequently a copy of
the removed member's, and it may be a placeholder that receives nothing. The copy
says so and asks the admin to check.

Pending nomination states must have an expiry, reminder, admin refresh,
replacement, rejection, or other documented recovery path so applications do
not remain permanently blocked by stale action links.

Lodge induction sign-off is a single overall Pass per signer. Checklist items
remain the reference material for the induction, but runtime sign-off does not
store per-item Yes/No/N/A results or member self-assessment levels. New-member
inductions created from approved applications should explicitly assign the
application nominators as signers while preserving the application nominator
fallback for historical records. Completing a Hut Leader Induction sets
`Member.hutLeaderEligible`; it does not create or date a `HutLeaderAssignment`,
which remains an admin-controlled roster/coverage record and issues a dedicated
lodge kiosk PIN (its plaintext is shown only once, at issue or reset).
Assignment additionally requires the member to hold the standard
`USER` access role: a member whose only roles are custom definition-backed rows
(`role = null`) cannot be assigned as a hut leader, and the booking-derived
picker only surfaces adult `USER` members with an operational booking
overlapping the assignment range, while the "Any member" tab rosters a
booking-less custodian directly (see CONFIGURATION.md → "Hut Leaders").

The trusted legacy induction baseline (#2361) is a one-off maintenance
exception, not a replacement for ordinary sign-off. Its population is exactly
the active, non-archived, non-cancelled real-member rows whose legacy member
role is `USER` or `ADMIN`; this classification reuses the canonical member
import role set. Login is not required, so a non-login `USER` dependant remains
in scope, while `LODGE`, `NON_MEMBER`, and `SCHOOL` rows do not. Every
configured person age tier participates; Infant, Child, Youth, and Adult are
all included, while an in-scope `N/A` is reported separately and never
changed. The age-tier partition must come from valid stored configuration —
the command must not silently substitute application fallbacks. A completed
induction of **any** kind makes the member historical and therefore skip-only.
A `DRAFT` or `IN_PROGRESS` induction makes the member an apply blocker,
including when another completed row also exists. Voided history alone does
not count as completion.

Apply requires an active, login-enabled Full Admin actor, one valid active
`NEW_MEMBER` template, an exact effective-club-name confirmation, exact parsed
database host and database-name confirmations, one New Zealand date-only
value no later than the current New Zealand date, and stable provenance. It
creates only new `NEW_MEMBER` / `COMPLETED` / `ADMIN_OVERRIDE` rows.
`inductionDate` and `completedAt` are the same supplied date, and every row
stores the actor, template, and provenance. It creates no signers, sign-offs,
email, or `hutLeaderEligible` side effect; existing induction rows are never
updated or deleted. The rows and audit event are one transaction, an open
workflow visible after the direct-`MemberInduction` DML lock aborts the whole
apply, and an identical rerun writes nothing. That table lock does not freeze
the member population or a composed writer before it reaches this table, so
the final dry run and apply require the operator write freeze in
`docs/INDUCTION_BASELINE_RUNBOOK.md`.

A `HutLeaderAssignment` may additionally hold ONE bed (`bedId`), which makes it
a **custodian occupancy** (#2286). The invariants:

- **Optional and inert by default.** `bedId = null` is a role only and has zero
  capacity effect — the pre-#2286 behaviour, and what every
  `hut-leader-auto-assign` cron row is. Only a bed-holding assignment reaches a
  capacity or allocation consumer.
- **Inclusive night semantics.** The hold covers the night of every date from
  `startDate` to `endDate` **inclusive**, never the half-open booking envelope.
  The bed is bookable again for the night after `endDate`. (This is the
  custodian exception the stay-boundary invariant in "Booking Dates And
  Capacity" names deliberately: an assignment's `endDate` is a covered day,
  not a departure morning.)
- **Counted as an occupant, never as a smaller lodge.** The capacity engines add
  the per-night custodian **count** to `occupiedBeds` rather than reducing
  `lodgeCapacity`, so `occupiedBeds + availableBeds === lodgeCapacity` still
  holds on every night. It is a count, never a boolean: two custodians handing
  over on different beds subtract two.
- **No booking, no allocation row, no guest.** A custodian is not a
  `BookingGuest`, so they are structurally absent from the chore roster, the
  booking rows and the display occupancy counts. They may still make an ordinary
  booking of their own anywhere, including at the same lodge, and capacity then
  correctly counts both their held bed and their booked bed.
- **Two assignments may never hold the SAME bed on an overlapping night.** The
  one-day handover overlap assignments already permit is allowed only on
  different beds; the same-bed case is refused at create and update.
- **A whole-lodge hold and a custodian never contend.** The hold reserves the
  *bookable* lodge; the custodian's bed sits outside that pool. Neither refuses
  the other, and the ADR-001 held-night pin is unchanged.
- **Exclusion is enforced in application code, never by a database constraint**
  (owner decision 28 Jul 2026, option (a)). Two things make that safe, and both
  are required:
  1. **Every** `BedAllocation` write path that places a guest on a bed re-reads
     the live holds **on the same client, immediately before the write**, and
     refuses or drops what would land on one: the manual funnel
     `allocateBedNight`, the range assign's `CUSTODIAN_HOLD` classification,
     `runAutoBedAllocation`'s in-transaction re-filter, and the lifecycle
     reconcile's write-time re-filter (`dropRowsOnCustodianHeldBedNights`). A
     read at plan time alone is NOT enough — a reconcile is routinely called
     post-commit, so a hold committed between the plan and the write would
     otherwise be written over.
  2. Every placement transaction this code **opens itself** takes the per-lodge
     advisory lock (`acquireLodgeCapacityLock`) as its first statement, sorted
     when it can span several lodges, so that re-read and the write serialise
     against the hold writer, which takes the same key. A reconcile running
     inside a CALLER's transaction inherits that caller's lock discipline
     instead of adding a key to an ordering it does not control; its write-time
     re-filter still runs on that client.

  `custodian-write-path-contract.test.ts` fails CI when a new write
  path appears undeclared, and `CUSTODIAN_BED_CONFLICT` on the allocation board
  surfaces any row that got through anyway.
- **A held bed cannot be deactivated or deleted**, nor can its room, while the
  hold exists (`onDelete: Restrict` is the FK backstop behind the app guards).
- **Minor privacy.** A minor-age custodian is never individually named on the
  lobby display at any name-display granularity; the slot shows the role word
  alone.

Hard delete must remain limited to records that pass the eligibility checks for
no durable booking, financial, family, Xero, or membership-history blockers.

### Calculated age on identity-sensitive Family Group workflows (#2568)

An administrator linking, approving, creating, editing or removing a Family Group
member sees that member's **calculated age** beside their name. The invariants:

- **One helper.** `src/lib/member-age.ts` is the only place age is derived, and
  `src/lib/__tests__/member-identity-age-surfaces.test.ts` pins the complete list
  of modules that call it or carry its `ageLabel` output. A new screen showing an
  age fails that census first.
- **Nothing is stored.** Age changes on its own every day, so there is no age
  column and no cached value; it is recomputed on every read. `Member.ageTier`
  remains a separate, deliberately stored classification and is never used to
  infer an age.
- **Date-only on the New Zealand calendar.** A date of birth is a calendar day.
  `Date` inputs are read through the club time zone, exactly as the family-group
  screens already RENDER a date of birth, and the default reference date is the
  club's calendar day — never the UTC or browser date, which would move a
  birthday by one day for half of every NZ day. The reference date is injectable
  so tests are deterministic.
- **A 29 February anniversary clamps to the last day of the month**, so a
  leap-day member turns over on 28 February in a non-leap year. A future or
  unparseable date of birth has no age and reads `Age unavailable` — never
  "0 years", which would look like a real infant.
- **Under five shows completed years AND months**; five and over shows completed
  years only.
- **Age is as at today; an age tier is as at the season start.** The two sit side
  by side on these screens and are deliberately computed against different
  reference dates: `formatMemberIdentityAge` defaults to the club's current
  calendar day, while `Member.ageTier` (and a child request's derived
  `requestedAgeTier`) is `computeAgeTierWithSettings(dob, getSeasonStartDate(...))`
  and holds until the next rollover in `cron-age-up.ts`. A member whose birthday
  falls between the season start and today therefore reads, correctly, "5 years"
  beside "Infant (0-4)". Wherever a tier label carrying a numeric range is
  rendered next to an age, the UI states the season-start basis
  (`request-review-card.tsx`) — the pairing must never read as a corrupt record.
  Neither figure is derived from the other: age is never inferred from a tier,
  and a tier is never recomputed from a label.
- **The browser is sent the age, not the birth date.** Every family-group payload
  that needs identity information carries a finished `ageLabel` string and no
  `dateOfBirth`. The one date of birth still rendered is the value the REQUESTER
  declared on a child or adult request — the request's own data, which the admin
  checks a candidate record against, not a stored member record.
- **Membership permission, verified server-side, on every request.**
  `GET /api/admin/family-groups/member-search` and
  `GET /api/admin/family-groups/[id]` both name `membership:view` explicitly
  rather than inferring it from the request path. An administrator whose role
  covers an unrelated area receives no identity information at all.
- **Routine views stay routine.** The `GET /api/admin/family-groups` list — the
  ordinary Family Group overview — carries neither a date of birth nor an age,
  and no member-facing or public surface carries either.

### Member profile merge (E11 #1937)

Two duplicate member records may be merged into one by a **Full Admin only**. The
admin picks the **master** (the record that survives); the other is the **loser**
and is hard-deleted at the end. The merge is **additive and master-wins**:

- **Field merge.** The master's populated scalar fields always win; a blank
  master field is filled from the loser (contact/identity/address groups —
  phone and each address block fill as a whole, never field-by-field, so a merged
  record never mixes one member's street number with another's city).
  `requiresInduction` and `hutLeaderEligible` are OR-ed (and
  `hutLeaderEligibleAt` becomes the earliest); `joinedDate` becomes the earliest.
  **Login and identity are never merged** — `email`, `passwordHash`,
  `emailVerified`, `canLogin`, `role`, `financeAccessLevel`, every 2FA field, and
  `xeroContactId` always stay the master's. (Login-email uniqueness is a partial
  unique index `WHERE canLogin = true`, so two login rows on one email can never
  coexist mid-transaction.)
  **The FIELD PATCH only** is derived from a read of both members taken
  immediately before the write, never from the snapshot the transaction opened
  with (#2243). Everything else in the merge — the guard matrix, the confirmation
  phrase, the preview-token check, and the self-relation cycle nulling — still
  runs on that opening snapshot. Every value in the patch is copied off the
  loser, and two of them are real foreign keys — `photoImageId` (→ `MediaImage`)
  and `familyGroupId` (→ `FamilyGroup`) — so a stale value can name a row that a
  writer outside the `member-lifecycle` lock deleted mid-merge and fail the write
  outright, rolling the entire merge back. Both member rows are row-locked
  (`SELECT … FOR UPDATE`, id-ordered) immediately before that read, so neither
  can move again before the write. If the fresh derivation disagrees with the
  previewed one on any field, the merge **refuses**: a 409
  (`merge_drift_in_transaction`) naming the drifted fields, nothing written, and
  the operator re-runs the preview — the same "what was previewed is exactly what
  is applied" promise the rest of the preview/confirm flows make. The original
  bug is fixed either way, because the stale value is caught from the fresh read
  *before* it reaches Postgres. A row lock does not protect the rows these FKs
  point at, so a concurrent `FamilyGroup` delete can still abort the merge (as a
  deadlock rather than a stale-value error); the master is still unlocked during
  the guards and the self-relation pass, which is why the Member self-relation
  moves exclude the master's own row. The four **family-link** columns
  (`parentMemberId`, `secondaryParentId`, `inheritEmailFromId`,
  `detailsConfirmedByMemberId`) are protected in three places (#2437): step 1
  nulls a master pointer at the duplicate **value-conditionally** (a pointer
  that moved since the opening snapshot refuses right there, instead of being
  overwritten and read back as "unchanged"); the step-3 sweeps are
  **id-bounded** to the rows captured by the in-transaction token
  re-derivation (a link written after that capture is never absorbed onto the
  master unvetted — it stays pointing at the duplicate); and the step-5
  under-lock re-read checks all three arms — either member's own outgoing
  links beyond the merge's own rewrites, and any other row still referencing
  the loser after the moves — refusing with the same 409 on any drift. Two
  invariants follow: a merge never **creates** a self-referencing family link
  (step 1 clears a master→duplicate pointer, the moves exclude the master's
  own row, and every mid-merge divergence refuses — note this does NOT forbid
  a **pre-existing** self-reference: `detailsConfirmedByMemberId` equal to the
  member's own id is the legitimate self-confirmed state gating
  `canBeBookedAsMember` (`member-profile-completeness.ts`), and a merge
  carries it through untouched), and a family link saved while the merge runs
  is never silently lost or silently absorbed — the merge refuses, nothing is
  written, and the operator's re-run previews the up-to-date links, including
  an explicit warning when the master's own link at the duplicate will be
  cleared (owner decision on #2437, 1 Aug 2026: detect and refuse; no new
  advisory-lock participants, no DB CHECK constraint).
- **Relation buckets.** Every Member-referencing relation is classified into
  exactly one bucket by `MEMBER_MERGE_RELATION_SPECS`, enforced complete by a
  DMMF/schema test that fails CI if a new relation is added unclassified:
  - **move** — history re-points loser → master (`updateMany`): bookings, guests,
    credits, refunds, redemptions, committee/hut-leader/lodge-access-created,
    actor and reviewer back-references, and the four Member self-relations
    (parent / secondary parent / email-inheritance / details-confirmed-by), whose
    self-cycles are nulled on the master first.
  - **resolve** — a unique constraint means a per-model resolver dedupes before
    moving: `MemberSubscription`/`SeasonalMembershipAssignment` (per season),
    `MemberAccessRole`, `MemberLodgeAccess`, `CommitteeAssignment`,
    `PromoCodeAssignment`, `PromoRedemptionAllocation` (both uniques),
    `MembershipCancellationRequestParticipant`, `GroupBookingJoin`,
    `NotificationPreference` (1-1), `MemberInductionSignOff` (earliest sign-off
    wins), `MemberInductionAssignedSigner`, `FamilyGroupMember` (keep the
    master's row and re-point the family's billing membership at it; #2520
    removed the old `MAX(ADMIN > MEMBER)` role upgrade and then dropped the
    column it wrote), and `MemberPartnerLink` (canonical
    `memberAId < memberBId` pair, self-pairs and duplicates deleted, and at most
    one CONFIRMED partner kept for the master).
  - **cascade** — the loser's auth identity and ephemeral tokens
    (password-reset / email-verification / email-change tokens, all 2FA rows,
    partner-invite tokens) are never moved; they die with `member.delete(loser)`.
  - **snapshot** — FK-less scalar member-id columns
    (`MemberLifecycleActionRequest.memberId`, `BookingModification.memberId`,
    `MemberApplication` nominator/reviewer ids, `NominationToken`,
    `IssueReport.resolvedById`, `AuditLog` columns, the settings-audit
    `updatedByMemberId` columns, `CalendarEvent`/`CalendarEventSeries.createdById`,
    …) are **left pointing at the loser's id by design** as immutable history;
    the same historic audit rows that reference the loser keep its id and stored
    names on purpose. These carry no `@relation`, so the relation walk above
    cannot see them and they used to be listed by hand and non-exhaustively —
    which is how the two calendar columns escaped both (#2243). They are now
    enumerated mechanically as well: any FK-less `String` column whose name is
    used elsewhere in the schema as a Member FK column must appear in
    `MEMBER_MERGE_SNAPSHOT_SCALAR_COLUMNS`, and `member-merge-dmmf.test.ts` fails
    on the next one that does not. Columns with bespoke names
    (`MemberApplication.nominator1Id`, `RefundRequest.reviewedBy`,
    `IntegrationCredential.updatedByUserId` — a misnomer, it holds a member id —
    and the like) are invisible to that scan and stay hand-documented, so that
    part of the list is explicitly **best-effort, not exhaustive**.
    One column found by the same review is deliberately **moved, not
    snapshotted**: `BookingRequest.convertedMemberId` is the identity pointer to
    the member a booking request converted into, replayed as a live member id by
    the idempotent approval path, so the merge re-points it loser → master
    alongside its FK twin `requestedByMemberId` (#2243).
- **Subscription-collision blocker.** If the loser holds a *meaningful*
  `MemberSubscription` (any invoice/payment/charge-coverage signal) for a season
  the master holds **any** subscription row for — meaningful or not — the merge
  is **blocked**: the keep-master resolver drops the loser's colliding row, so a
  paid/invoiced loser row must never collide, even with a meaningless
  `NOT_INVOICED` master row (dropping it would delete payment history, and a
  charge-coverage-backed row would fail on its `onDelete: Restrict` FK). A
  meaningless loser subscription for a season the master also holds is dropped;
  otherwise it moves.
- **Xero teardown (ENTRANCE_FEE_INVOICE re-point rule).** Inside the transaction
  and with **no Xero API calls**, the loser's contact-identity `XeroObjectLink`
  rows are deactivated and its `xeroContactId` nulled (mirroring the delete path).
  The exception is the loser's active `ENTRANCE_FEE_INVOICE` (joining-fee) link:
  it is **re-pointed** (its `localId` set to the master) so the paid-joining-fee
  evidence survives — otherwise E5's invoice-idempotency check would treat the
  master as never-invoiced and risk a double charge. If the master already holds
  an active `ENTRANCE_FEE_INVOICE` link (the partial unique forbids two), the
  loser's is deactivated instead and the preview says so. The loser's Xero
  **contact** is not touched in Xero — the preview warns the admin to archive or
  merge it there manually (residual risk: no post-merge Xero contact-group or
  invoice re-sync, consistent with the periodic-reconciliation stance).
- **Xero contact participants are lifecycle-fenced.** Member-scoped contact
  UPDATE (including operator retry and bulk name repair) reserves from the
  complete Member row only after taking that member `FOR KEY SHARE`; the
  provider request is built from that locked snapshot, so a surviving master
  sends fields filled by a merge that committed first rather than stale
  pre-merge PII. Inbound webhook reconciliation, bulk contact sync, group
  import, historical canonical-link backfill, and managed contact-group
  completion take the stronger exact Member `FOR UPDATE` before any local
  contact pointer, blank-field PII fill, or FK-less CONTACT link is committed.
  Pointer, link, and operation ledger share that transaction.
  Merge/deletion-first therefore makes the inbound, backfill, or group-sync
  completion refuse; writer-first is followed by the normal teardown, so no
  active CONTACT link remains for a deleted member or merge loser. Every Xero
  provider call remains outside these short transactions.
- **Guards, preview and confirmation.** Full Admin only; master ≠ loser; both
  exist; master active and not archived; loser ≠ the acting admin; the loser may
  not hold any admin access role (and the last-Full-Admin backstop applies); no
  PENDING/REQUESTED lifecycle, deletion, or family-join request on either member.
  The whole merge runs in one transaction under the dual `member-lifecycle`
  advisory lock (see CONCURRENCY_AND_LOCKING.md), re-runs the guards, and
  re-verifies an HMAC preview token (over both ids, both `updatedAt`, and an
  outcome digest) so a drifted preview 409s. The admin must type
  `MERGE <loser full name>` (whitespace-normalised) to confirm, and one critical
  `MEMBER_MERGED` audit records the loser snapshot, field outcome (the values
  actually applied), per-relation counts, collision resolutions, and a bounded
  500-row moved-id sample. The token pins the state at the moment the transaction
  opened, so it catches drift **before** the merge starts but cannot see a change
  that lands during it; that residual window is closed by the second patch
  derivation above, which 409s on any disagreement — so a committed merge never
  carries drift, and there is no drift field in the audit to read.
- **Refused attempts are audited too (#2498).** Every refusal — self-merge,
  missing member, `merge_blocked`, wrong confirmation phrase, `preview_drift`,
  and the `merge_drift_in_transaction` field/family-link arms — throws from
  inside the transaction and rolls it (and the `MEMBER_MERGED` audit) back. A
  single boundary in `executeMemberMerge` then writes one best-effort
  `MEMBER_MERGE_REFUSED` audit (category `admin`, outcome `blocked`) on the base
  client, outside the rolled-back transaction, recording the actor, both member
  ids, the refusal code/status, and a non-PII structural summary of what drifted
  or blocked (field/column names and guard codes only — never member values,
  names or emails). The write is best-effort: a failed audit is logged and
  swallowed, so it can never turn a clean 4xx/409 refusal into a 500, and one
  refusal produces at most one row.

## Integrations

- Webhooks and cron jobs must be idempotent.
- Provider callbacks must verify signatures, state, or expected origin before
  local mutation.
- External provider calls should not be placed inside long database
  transactions unless there is a documented reason.
- Email, Xero, and payment failures that affect business-critical outcomes must
  be visible and retryable.
- Logs, webhook records, Sentry events, and PR comments must not expose secrets,
  OAuth codes/states, action tokens, client secrets, or personal data beyond the
  minimum needed for diagnosis.

### Xero member grouping (E8, #1934)

- A single club-level mode governs member auto-grouping: `NONE`,
  `MEMBERSHIP_TYPE`, or `MEMBERSHIP_TYPE_AND_AGE` (`XeroGroupingSettings`
  singleton). Grouping rules live in one table, `XeroContactGroupRule`
  (`MANAGED` = the group the sync adds; `ACCEPTED` = tolerated, never removed).
- The system NEVER deletes a Xero contact group. It only adds/removes a
  contact's *membership* of groups in the "managed universe" = groupIds
  referenced by ACTIVE rules that are applicable under the current mode.
  Xero groups not referenced by any active rule are never touched.
- `NONE` mode is a total no-op — the per-member sync short-circuits before any
  Xero call, and the cancellation path performs no managed removals.
- A rule targets a **set** of age tiers (`ageTiers`, #2093): the EMPTY set is
  the "all age tiers" wildcard (the migrated null "Any age"); a non-empty set
  matches a member whose tier is IN the set. Sets are stored canonical-sorted and
  a full-tier selection collapses to the empty set, so each shape has exactly one
  canonical form and the DB partial unique index dedupes reordered sets. In
  `MEMBERSHIP_TYPE` mode a non-empty tier set makes the rule inert.
- Resolution is pure and mode-driven (`resolveMemberGrouping`): most-specific
  MANAGED match wins on the ladder `type + tiers` > `type-only` > `tiers-only`;
  among tiered rules **fewer tiers is more specific**, and an all-tiers (`[]`)
  rule is the LEAST specific in the tier dimension (a naive ascending
  tier-count comparator would wrongly invert this). Exact ties break
  deterministically by `sortOrder` then group id. ACCEPTED is the union
  of matching accepted rules plus the matched managed group. The effective
  membership type is resolved by the ONE shared policy helper
  (`resolveMembershipTypePolicyForMember`) at the CURRENT season year — pricing
  resolves per stay-night season, grouping resolves at "now"; the two must not
  be merged.
- Add-suppression: the managed group is added only when the contact is in NONE
  of (matched MANAGED ∪ matched ACCEPTED), so members parked in an accepted
  group get no spurious add. A member matching no rule is left untouched (no
  removals); when such a member sits in managed-universe group(s) they surface
  as an information-only entry in the dry-run snapshot (never iterated by the
  bulk re-sync) for deliberate admin cleanup in Xero.
- The cutover migration deactivates every pre-existing `XeroContactGroupRule`
  row it did not backfill itself, so only tier-only backfill rules are live at
  deploy; dormant legacy rules require a deliberate admin re-enable via the
  grouping UI.
- Mode/rule changes NEVER auto-resync the population. Deactivating or deleting a
  rule shrinks the managed universe, so members already in that group are never
  removed by the system. Members re-group on their next trigger (age-tier
  change, current-season membership-type change, cron age-up) or via the
  explicit admin bulk re-sync.
- The per-member sync keeps Xero calls outside DB transactions, ledgers each
  operation with an idempotency key (the per-add key carries a per-operation
  nonce so a legitimate later re-add is never swallowed by Xero's 24h
  idempotency window), adds before removing, and refreshes the contact cache
  from the post-write contact. A remove-404 is idempotent success recorded as
  already-absent — never counted as a removal; an add-404 is a ledgered
  failure.
- The bulk re-sync is admin-triggered, dry-run-first, cache-pre-filtered to
  mismatched members, chunked and resumable by member-id cursor, and never
  advances the CONTACT delta-sync watermark. Members without a Xero contact are
  reported as skipped, never silently omitted.

## Operations

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
- Production deployment must respect `docs/BLUE_GREEN_MIGRATION_POLICY.md`.
- Public CI and local validation must use test/demo credentials or placeholders.
- Production data, production backups, live provider accounts, and live webhooks
  are not valid exploratory test inputs.
