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

- Lodge bookings use New Zealand date-only nights, not arbitrary timestamps,
  unless a feature explicitly requires time-of-day semantics.
- `BookingGuest.stayStart` and `BookingGuest.stayEnd` represent each guest's
  date-only occupancy inside the booking envelope.
- `@db.Date` columns (e.g. `Booking.checkIn`/`checkOut`,
  `BookingGuest.stayStart`/`stayEnd`, `HutLeaderAssignment.endDate`) store an NZ
  calendar date at UTC midnight. Compare them only against date-only values
  (`getTodayDateOnly()` / `normalizeDateOnlyForTimeZone()` from
  `src/lib/date-only.ts`), never a raw `new Date()` or a local-midnight
  (`setHours(0,0,0,0)`) instant: under the `TZ=Pacific/Auckland` server pin the
  latter resolves to `(D-1)T12:00Z` and shifts the boundary by a day for the
  first ~13h of each NZ day (F8/F32, #1888).
- Two check-out boundaries coexist by design (#2029). The completion cron flips
  PAID → COMPLETED only once `checkOut < todayNZ` — the entire NZ check-out day
  stays PAID and self-editable/extendable — whereas the admin "finished stay"
  attention queues (`unpaid-finished-stays.ts`) intentionally use
  `checkOut <= todayNZ`. The difference is deliberate and the two operate over
  DISJOINT status sets: the queues surface still-unsettled stays
  (`PAYMENT_PENDING`, or a settled status carrying an unpaid additional delta) on
  the check-out day itself for payment chasing, while completion is a next-day
  transition of PAID bookings. A booking is therefore never both counted as a
  finished-stay-needing-payment AND still PAID-completable under the same rule.
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
  tier runs `sweepFuturePartnerSharedAllocations`
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
  shared double loses its primary — a board delete (#1743), a board move of the
  primary onto another bed, or a cross-booking cancellation / reconcile prune
  (#1750) — the surviving partner is **auto-promoted** to primary on the vacated
  bed-night atomically with the removal on transactional paths, each with its own audit entry
  (`BED_ALLOCATION_PARTNER_PROMOTED`) because the partner may belong to a
  different booking (sharing eligibility is member-level). Promotion is gated on
  `isSecondOccupant` alone, never the denormalized `bedType` of the removed row or
  the survivor: an AUTO-allocated row on a real DOUBLE carries the SINGLE default,
  so trusting that type would strand the partner it needs to promote. The
  bed-night is
  therefore never left dead-ended behind the orphaned-second-occupant guard in
  `resolveSecondOccupant`, and re-pairing follows the normal sharing rules (in
  particular the promoted primary's booking must hold capacity before a new
  partner may join). The two atomicity shapes differ by path: the board
  delete/move helpers self-wrap their read + write + promote in a transaction,
  while the lifecycle prune captures-before / flips-after on the caller's own
  client. Reconcile is usually already inside a transaction, but a few callers
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
- A linked `Member` may be present on only one live booking per lodge night.
  This person-night guard is separate from bed capacity: it checks draft,
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
  added by #2251 (stacked on #2285 and landing with it); until that lands, a
  hand placement onto a held booking is not refused at the API. The
  exclusive-hold toggle reconciles both directions (set prunes, release
  re-plans), and a school approval granting exclusivity prunes after stamping
  the hold; both record the removed rows in their audit entry so a mistaken
  hold can be undone by hand. Divergence guard:
  `src/lib/__tests__/held-booking-allocation-agreement.test.ts`.
- **A held booking's nights are not modelled as occupied for other bookings'
  planning (ADR-001 amendment, #2285):** the hold blocks new admissions through
  the capacity rule, but neither planner sees the held group's beds as taken or
  its minors as present, so an officer-kept overlapping booking can be
  auto-placed onto those beds and the cross-booking age-mix invariant (#1768)
  cannot account for the held group. Overlaps remain officer-resolved
  (#119/#177); changing this is the open decision #2317.
- **The requested-room lock follows the approved rows, not the hold (#776,
  #2285):** setting an exclusive hold prunes the booking's approved allocations,
  so `isBookingBedAllocationLocked` goes false and the member's requested-room
  editor re-opens; the re-plan after a clear creates unapproved AUTO rows, so it
  stays open until an admin approves again. Intended: with no allocated beds
  there is nothing for the lock to protect.

## Payment And Settlement

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
envelope. A guest stay range outside the current envelope is not rejected —
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

Every priced guest stores a `BookingGuest.rateMembershipTypeId` snapshot — the
type whose rows priced it (the resolved type, never the per-night discount
substitution). Xero line building reads the snapshot to pick the hut-fee item
code. The snapshot is **not** write-once: modify/reprice flows (waitlist offer
reprice, date change, guest add/removal) recompute and overwrite it for
repriced guests alongside `priceCents`; a locked night keeps both its price and
its stale snapshot untouched. A `NULL` snapshot (pre-refactor booking) falls
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
fully-past stay is not self-editable at all. On an in-progress extension the
minimum-stay policy is evaluated over the **whole contiguous stay**, not the
added nights alone (#2124): because the original check-in is kept fixed, the
modify-quote preview runs `validateMinimumStay` across `[checkIn, newCheckOut]`
(the already-valid original plus the added nights), so a member can extend
their check-out one night at a time even across a weekend minimum-stay rule —
the added night alone would fail the minimum, but the whole stay satisfies it.
A genuinely too-short whole stay is still reported. (The create path evaluates
each new booking's own range, so a separate contiguous one-night booking is
still subject to the minimum — deferred as scope B on #2124.) Issue #1668 adds an **admin-only
override** (`adminOverride`, honoured solely when
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
  (`addDaysDateOnly` on UTC-midnight-normalised bounds), so the delta is
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
  (`{ bookingId } | "none"`), so a new send site is a compile error until its
  author states which it is.
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
  it from the row's `bookingId` and fails closed the same way.
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
  summary columns mirror the LATEST ADDITIONAL payment transaction, and the
  predicate mirrors the member-facing owed test (member dashboard / booking
  detail), so admin and member agree on what is owed; `PAYMENT_PENDING` is
  deliberately excluded so the two queue counts can be summed without
  double-counting a booking. Deep link:
  `/admin/bookings?additionalOwed=owed&checkOutTo=<today>` via the bookings
  list's `additionalOwed` filter (AND-composed, so explicit status/date
  filters in the same URL still narrow).

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
  organiser booking's stay has fully ended (`checkOut ≤ NZ today`, the same
  cutoff as the queues — a stay checking out today has fully ended) leaves
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
statuses (PENDING/PAYMENT_PENDING); a paid or confirmed booking is flagged in
place, and approving it clears the review without re-opening the payment
lifecycle. Rejection cancels through the shared cancellation flow, which
refunds captured payments per the policy.

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

Google Analytics must not load unless all three hold: the Analytics module is
enabled, `NEXT_PUBLIC_GA_MEASUREMENT_ID` is configured, and the visitor has
explicitly accepted the consent banner. Declining or dismissing the banner
counts as denied, Google Consent Mode defaults every storage category to
denied until an explicit accept, and the stored per-browser choice
(`analytics-consent.v1`) is honoured on revisit.

## Membership Lifecycle

Membership application, nomination, cancellation, archive, delete, family, and
dependent changes must preserve financial history, booking and guest history,
audit history, required family/dependent history, privacy preferences, and Xero
contact/link history where required.

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
is active and holds an active, published `CommitteeAssignment` — the same
predicate `/api/committee` uses (which is uncapped, so every publicly-rostered
member is exactly the set whose photo is servable); otherwise it is visible
solely to the member or a `membership:view` admin. The committee-public ETag is
an opaque digest, never the raw `MediaImage` id. Uploaded photos have their
EXIF/XMP/comment metadata (camera GPS) stripped before storage. Whether the
public committee roster renders those photos is a separate presentational opt-in
(`PublicContentSettings.committeePhotoDisplay`, default `NONE`) and never widens
the serving rule.
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
(b) the target has **no login** and the initiator is a
family-group ADMIN of a group containing the target ("one login manages the
family" — a login-holding target always consents personally, and the no-login
target's address is emailed that the link was recorded), or (c) the link
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

Alongside the cap, the admin link route requires: the parent must be an active,
non-archived adult; the target must not be archived, must not already be linked
to that parent, must not already have two parents, and **must not be an ancestor
of the parent**. That last one is now stated in its own right. Under the old
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
(`parentLinkEligibleFor`) applies the cap the other way round: the member's own
dependants eat into the budget, the candidate parent's ancestors must fit in
what is left, and the member's descendants are excluded outright so the dialog
cannot offer a cycle.

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
an adult, with a real address, who does not itself inherit. Its former "must
point to a **primary** adult member" rule (the source must have no parents) is
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
overlapping the assignment range (see CONFIGURATION.md → "Hut Leaders" for the
promo-code/book-on-behalf workaround that rosters a booking-less custodian).

Hard delete must remain limited to records that pass the eligibility checks for
no durable booking, financial, family, Xero, or membership-history blockers.

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
    master's row, upgrade its role to `MAX(ADMIN > MEMBER)`, and re-point the
    family's billing membership), and `MemberPartnerLink` (canonical
    `memberAId < memberBId` pair, self-pairs and duplicates deleted, and at most
    one CONFIRMED partner kept for the master).
  - **cascade** — the loser's auth identity and ephemeral tokens
    (password-reset / email-verification / email-change tokens, all 2FA rows,
    partner-invite tokens) are never moved; they die with `member.delete(loser)`.
  - **snapshot** — FK-less scalar member-id columns
    (`MemberLifecycleActionRequest.memberId`, `BookingModification.memberId`,
    `MemberApplication` nominator/reviewer ids, `NominationToken`,
    `IssueReport.resolvedById`, `AuditLog` columns, …) are **left pointing at the
    loser's id by design** as immutable history; the same historic audit rows
    that reference the loser keep its id and stored names on purpose.
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
- **Guards, preview and confirmation.** Full Admin only; master ≠ loser; both
  exist; master active and not archived; loser ≠ the acting admin; the loser may
  not hold any admin access role (and the last-Full-Admin backstop applies); no
  PENDING/REQUESTED lifecycle, deletion, or family-join request on either member.
  The whole merge runs in one transaction under the dual `member-lifecycle`
  advisory lock (see CONCURRENCY_AND_LOCKING.md), re-runs the guards, and
  re-verifies an HMAC preview token (over both ids, both `updatedAt`, and an
  outcome digest) so a drifted preview 409s. The admin must type
  `MERGE <loser full name>` (whitespace-normalised) to confirm, and one critical
  `MEMBER_MERGED` audit records the loser snapshot, field outcome, per-relation
  counts, collision resolutions, and a bounded 500-row moved-id sample.

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

- Production deployment must respect `docs/BLUE_GREEN_MIGRATION_POLICY.md`.
- Public CI and local validation must use test/demo credentials or placeholders.
- Production data, production backups, live provider accounts, and live webhooks
  are not valid exploratory test inputs.
