# Domain Invariants

These are non-negotiable business and technical rules for AlpineClubBookingsNZ.
Future reviews and issues should cite this file when proposing changes.

## Money

- Store and calculate money as integer cents.
- Do not introduce floating point money arithmetic.
- Refunds, credits, discounts, Stripe amounts, Xero invoice amounts, and
  membership fees must reconcile back to cent-based ledger records.
- Admin adjustments need audit, approval, and a visible business reason.

## Booking Dates And Capacity

- Lodge bookings use New Zealand date-only nights, not arbitrary timestamps,
  unless a feature explicitly requires time-of-day semantics.
- `BookingGuest.stayStart` and `BookingGuest.stayEnd` represent each guest's
  date-only occupancy inside the booking envelope.
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
- Each lodge's capacity resolves through `getLodgeCapacityStatus`: active
  configured beds when the Bed Allocation module is on, else the per-lodge
  `LodgeSettings.capacity` override, else the club-config bed total for the
  default lodge only. An additional lodge with neither configured beds nor a
  capacity override resolves to capacity 0 (`unconfigured_lodge`), so a
  freshly created lodge is unbookable rather than overbookable until it is set
  up.
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
- Bed-allocation eligibility (`BED_ALLOCATABLE_BOOKING_STATUSES`) is a status-
  only superset of capacity-holding; the `capacity-holding ⊆ bed-allocatable`
  invariant still holds because rule (b) only extends holding to PENDING, which
  is already bed-allocatable (locked by
  `booking-status-bed-allocation-ownership.test.ts`, #813).
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
- The person-night guard is app-level enforcement by design (#1039 item 3): a
  database unique index cannot express it because liveness is booking-status
  dependent and spans `BookingGuest` to `Booking`, which a Postgres partial
  unique index cannot reference. It is race-free because every transaction that
  **creates or re-dates** a member-linked `BookingGuest`/`BookingGuestNight`
  footprint takes the global booking advisory lock (`pg_advisory_xact_lock(1)`)
  before running the guard (`assertNoBookingMemberNightConflicts`); that
  lock-before-guard ordering is frozen for every such writer by
  `review-findings-contracts.test.ts`. (`CONCURRENCY_AND_LOCKING.md` maps this
  lock alongside the per-lodge capacity and per-member credit locks and the
  ordering discipline each follows.) Writes that do not change the member-night
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
  (#1164 / D7). Because `restoreCreditFromBooking` has no internal replay guard,
  restore runs ONLY inside each branch's claim/lock, whose atomic status flip is
  the exactly-once guarantee — so the never-captured and `PENDING` branches are
  now status-guarded claim-first under the booking advisory lock too. A CANCELLED
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
  (the switch path derives the applied amount from the `BOOKING_APPLIED` ledger,
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
  (invariant `amountCents + creditAppliedCents = finalPriceCents`). Every
  capture/reconciliation guard accepts EITHER the effective price OR the full
  `finalPriceCents` (legacy in-flight intents minted before the fix) and rejects any
  other amount (create-payment-intent reuse, `stripe-webhook-service`,
  `payment-reconciliation`, and the synchronous `confirm-payment` guard) — full
  price is always a legitimate settlement, and new bookings only ever mint effective
  intents, so the leniency cannot re-open the double-charge. Because a card invoice
  is raised-and-paid near-instantly at capture (`queueXeroInvoiceForPaidBooking` →
  `createXeroInvoiceForBooking`), the #1620 fire-after-invoice outbox op is NOT used
  on card; instead `createXeroInvoiceForBooking` records the EFFECTIVE Stripe payment
  and then SYNCHRONOUSLY re-drives the same allocation engine (gated to a card cash
  capture with `creditAppliedCents > 0`) so the invoice settles to PAID via
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

Every modification path also applies the same lifecycle transitions: a
PAYMENT_PENDING booking whose price drops to zero auto-pays with a zero-dollar
payment (superseding and cancelling any outstanding primary PaymentIntents so a
stale checkout tab cannot capture the pre-change amount), any *other* price
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
branches — fresh-create and held-reuse (excluding the held booking's own
guests) — under the global booking advisory lock, before anything flips to a
capacity-holding status (#1352). A hold reserves only the originally held
guest count, so an admin child-count override at approval can never confirm
more beds than actually remain on any night; the admin sees the same
capacityExceeded outcome as the fresh path.

A booking converted from (or held for) a public/school booking request keeps
its officer-negotiated price, flat-split across guest rows; the quote's
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
existing one) or passes `canLogin` only as a read/token filter
(`normalizeAssignableAccessRoleTokens`, list/where clauses), and so cannot
strand an existing admin. The one remaining path that can clear `canLogin` on an existing
admin and is NOT guarded is indirect — the age-down cron, where editing a date
of birth to a minor tier can indirectly clear `canLogin` (informational).
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
allowed age tiers cover every affected member's current age tier
(`NOT_APPLICABLE`/organisation members are exempt because they are excluded from
all age-tier policy); it reassigns every source assignment to the target and
deletes the source in one transaction, writing both a `MEMBERSHIP_TYPE_MERGED`
and a `MEMBERSHIP_TYPE_DELETED` audit record. Because reassigning an
assignment's membership type never changes its `(memberId, seasonYear)`, the
merge cannot violate the per-season uniqueness constraint. Merges (like every
other seasonal assignment change) do not synchronously resync Xero contact
groups; reassigned members reconcile through the existing periodic/mismatch Xero
tooling, and the admin is warned before confirming when the source and target
Xero rules differ.
Organisation-type members (the `ORG` access role or the legacy `SCHOOL` role)
always carry the `NOT_APPLICABLE` age tier, and no other member may hold it —
the server forces it on every org create/update, rejects it for people, and
restores a DOB-derived tier when a member is reclassified away from
Organisation. `NOT_APPLICABLE` never has an `AgeTierSetting` row: it has no
age range, is displayed as "N/A", and is excluded from every age-based
automation — the season age-up cron, age-tier Xero contact-group sync (orgs
are never added to a managed age group; a leftover membership is surfaced as
a mismatch instead), and age-based subscription requirements. Organisations
are also exempt from membership entrance fees: both Xero entrance-fee
invoice paths (direct and outbox) skip N/A members before any amount —
including an explicit override — is considered. Booking guests
are always people: `NOT_APPLICABLE` is not a bookable tier, and organisation
accounts cannot be linked as booking guests.
Committee assignment controls public committee/contact presentation
only. Do not add committee positions to access roles or `Member.role`.
`CommitteeRole` master records and `CommitteeAssignment` member links can be
active/inactive independently of access role and seasonal membership type, and
newly linked assignments are hidden until explicitly published by an admin.
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

## Operations

- Production deployment must respect `docs/BLUE_GREEN_MIGRATION_POLICY.md`.
- Public CI and local validation must use test/demo credentials or placeholders.
- Production data, production backups, live provider accounts, and live webhooks
  are not valid exploratory test inputs.
