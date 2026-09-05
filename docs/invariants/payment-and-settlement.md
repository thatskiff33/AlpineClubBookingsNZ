# Payment And Settlement

Audience: Developer, Agent.

Prefix defined in this file: **`INV-PAY`** — how money is taken, cleared,
credited and refunded: settlement paths, account credit, Stripe and Xero
reconciliation, and group settlement.

Read this file when you are changing anything that takes, clears, credits or
refunds money.

Index: [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) — every `INV-*` ID
with a one-line description of what it covers. ID scheme and allocation rules:
[`SCHEME.md`](SCHEME.md).

Every heading below whose whole text is an `INV-*` ID defines that invariant. IDs
are permanent: never renumbered, never reused. **The text under each ID is a
verbatim move from the source document and must not be reworded in place** —
only the ID heading lines, and the editorial **Related:** lines directly beneath
some of them (#2707), were added. A `Related:` line is navigation, never part of
the rule: it names sibling IDs so a change to one prompts checking the others.

## INV-PAY-001

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

## INV-PAY-038

- It is a SIBLING ENTRY POINT into the one settlement body in
  `payment-reconciliation.ts`, not a second settlement path: it executes the
  same lock ordering, the same post-lock re-read, the same
  `checkCapacityForGuestRanges` with its #1771 persisted-override carve-out,
  the same status-fenced PAID claim, the same bed reconciliation and the same
  durable `MEMBER_PAID` / `NON_MEMBER_CONFIRMED` event. It composes a THIRD
  lock tier (global → per-lodge → MEMBER-CREDIT) and derives the settlement
  amount itself: no client-supplied amount is ever accepted, and the mirror
  `amountCents + creditAppliedCents = finalPriceCents` is asserted explicitly.

## INV-PAY-039

- It NEVER calls Xero and NEVER creates or voids an invoice. Marking paid is
  refused (409) when the payment carries a Xero invoice id, a refund credit
  note, a Xero id on any of its transactions, an active `PRIMARY_INVOICE`
  object link, a completed CREATE-INVOICE outbox operation, **or one still in
  flight**, and when the booking participates in a group settlement
  (`organiserSettled`). Every condition that can be expressed as a WHERE is
  re-asserted inside the fenced `payment.updateMany`, so an invoice minted
  between read and write yields count 0 → 409, never a double-apply.

## INV-PAY-040

- A capacity failure REFUSES and records nothing (owner decision, 28 Jul).
  The Stripe path's cancel-and-refund is not mirrored: no in-system money fact
  exists yet, so refusal leaves zero debt, and the invariant holds identically
  because the same check runs at the same point under the same locks.

## INV-PAY-041

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

## INV-PAY-042

- RECIPROCAL fence: an inbound Xero PAID landing on a manually settled booking
  raises a counter in the inbound result, an error log, a durable admin-only
  `BookingEvent` (once per payment+invoice) and a cooldown-throttled admin
  alert — never a quiet `alreadyPaid`. It fires across PAID, CANCELLED (or the
  inbound path would mint member credit for cash an OPEN hand-back task
  already owes back) and COMPLETED, and it runs BEFORE the settle loop's
  transaction update so a Xero invoice id is never stamped onto the manual
  settlement's rows.

## INV-PAY-043

- Duplicate-capture visibility: the #1992 distinctness predicate matches ANY
  settled PRIMARY transaction, not only a Stripe one, so a stray capture on a
  cash-settled (or Xero-inbound-settled) booking is auto-refunded instead of
  silently kept.

## INV-PAY-044

- CANCELLATION yields a durable `ManualRefundTask`, created atomically with the
  CANCELLED claim — never a Stripe refund plan, never a Xero credit note, never
  minted member credit, and never a "your refund is on its way to your card"
  email. The refund allocation is written only when the task is COMPLETED, so
  the ledger never claims money was returned before it was; the refund-appeal
  queue refuses to approve a manual-provenance payment. The policy math uses
  the bank-transfer/credit tier (owner decision, 28 Jul), so preview and
  execution agree.

## INV-PAY-045

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

## INV-PAY-046

- An OUTSTANDING upward-modification delta on the booking is never silently
  absorbed or silently left behind (#2397). `additionalAmountCents` /
  `additionalPaymentStatus` used to be written only by the CARD flow, so a price
  increase settled in cash still read as owing everywhere, including the
  automatic chase (#2350). The mark-paid dialog therefore ASKS (owner decision,
  31 Jul 2026) whenever the booking carries one, showing the amount before the
  change, the extra, and the total being recorded; the answer is a REQUIRED,
  defaultless part of the settle's contract, re-checked under the locks: an
  extra without an answer, an answer without an extra, and a figure that moved
  since the dialog rendered are each a 409 — the same law as
  `expectedAmountCents`.
  Said covered, the extra is settled through the columns every consumer reads
  (`additionalPaymentStatus = "SUCCEEDED"`, re-asserted in the fenced write) AND
  as a durable INTERNET_BANKING ADDITIONAL `PaymentTransaction` with reason
  `manual_mark_paid_additional`, because `reconcilePaymentAggregates` re-derives
  those columns from the latest ADDITIONAL transaction. **No money is created:** an upward modification raises `Booking.finalPriceCents` by the same delta it records as the extra, and this settle collects `finalPriceCents - credit` in one go, so the cash is SPLIT (the ADDITIONAL
  row carries the delta, the PRIMARY row the rest), so `Payment.amountCents` is
  the money the club took. An extra LARGER than the whole amount owing is
  refused on BOTH answers.
  Said NOT covered, the extra stays outstanding **and is subtracted from the
  settled figure** (owner decision, 31 Jul 2026): the settlement records
  `finalPriceCents - credit - outstandingAdditionalCents`. The PRIMARY figure is
  identical under both answers; the answer only decides whether an ADDITIONAL
  row sits beside it. A "not covered" answer whose extra IS the whole amount
  owing is refused: a $0 settlement must never flip a booking to PAID. What each
  answer does to the addition's Stripe intent, and what the admin and the member
  are each told, is `INV-PAY-052`.

## INV-PAY-052

- **A "not covered" settle leaves a WAY TO COLLECT the extra** (#2397). The
  settlement's blanket Stripe-intent cancellation SPARES exactly one intent — the
  payment's current `additionalPaymentIntentId`, only on "not covered" — because
  it is the member's only self-service door to the extra
  (`/api/bookings/[id]/additional-payment-secret`).
  Capturing it is ledger-correct: `reconcilePaymentAggregates` sums the captured
  rows, so `Payment.amountCents` becomes cash + addition = `finalPriceCents`.
  Superseded addition intents are still cancelled, and "covered" cancels the
  addition's intent too, because there a live intent would be a door to a SECOND
  payment. The admin's receipt and the member's confirmation both state which
  situation applies, and **the member's confirmation must agree with the admin's
  receipt**: a "not covered" settle sends the ordinary booking-confirmed message
  with the balance stated — Booking Total / Paid / Still Owing — and says whether
  the balance can be paid from the booking page or the club will be in touch.
- **A payment that has already taken money is refused at READ time**, not only
  at the fenced write. The settle-from statuses are PENDING / PROCESSING /
  FAILED; SUCCEEDED and the refunded variants are refused with a message that
  says so, and the admin booking page's advisory state applies the same rule so
  the action is not offered at all. The three payment-level refusals are checked
  in the SAME ORDER on both surfaces — refund history, then already-captured,
  then Xero evidence. Refund history leads because it is the most specific truth (a fully REFUNDED payment is a captured one too, and only the refund message names the remedy); Xero trails because the cheap in-memory refusals should settle it without the extra lookups `assertNoXeroInvoiceEvidence` costs inside the locked transaction.
- **Reachability, stated plainly.** With the read-time refusal in place, no
  production path is known that presents the coverage question on a settle that
  can COMPLETE other than the reverse-then-re-settle loop and legacy pre-ledger
  rows: Every writer of `additionalAmountCents` requires the payment to be captured at the moment the delta is recorded (`applyPaymentAdjustments` arm (a) needs `hasCapturedPayment`; arm (b) needs an issued Xero invoice, which this settle refuses outright and which nothing ever clears), and a captured payment is not a legal settle-from. Re-check this if the settle-from status set or the delta writers
  change.

## INV-PAY-047

- **The ledger mirror, generalised (#2397).**
  `amountCents + creditAppliedCents = finalPriceCents` is only the special case
  where nothing is left owing. What holds in every case is
  `amountCents + creditAppliedCents + (uncollected addition) = finalPriceCents`:
  every cent of the price is collected, paid with credit, or still owed.
  This is NOT enforced by a runtime assertion inside the settle, and cannot be:
  the settled figure is *defined* as `finalPriceCents - credit - uncollected`,
  so any in-transaction check reduces to `finalPrice === finalPrice`. What
  enforces it is (1) CONSTRUCTION — the PRIMARY and ADDITIONAL rows are a split
  of one figure, which is what `Payment.amountCents` is set to; (2) THE FENCE —
  the fenced `payment.updateMany` re-asserts the outstanding delta (on BOTH
  answers), the settle-from status, the zero refund history and the absence of
  Xero evidence as WHERE clauses, so a concurrent writer yields count 0 → 409;
  and (3) AFTER THE FACT, NARROWLY — `auditIbAppliedCreditStrands` recomputes
  `amountCents + creditAppliedCents - finalPriceCents` over committed data and
  reports the uncollected addition beside it.
  **(3) is not a safety net for this settle.** It enumerates a payment only when
  the booking still carries UN-ALLOCATED applied credit
  (`deriveIbAppliedCreditStrandFinding` returns null on
  `ledgerAppliedCents <= 0`), scans INTERNET_BANKING payments only, and is an
  operator-run script (`scripts/audit-ib-hold-clearing.ts`), not a scheduled job
  or an alert. Within that population a NEGATIVE `mirrorInvariantDeltaCents`
  equal-and-opposite to the payment's uncollected addition is not drift.
  Either answer is recorded on the mark-paid audit row BOTH ways — with the
  settled figure written, the amount owing, and what was deliberately left
  uncollected. A covered extra also writes
  `booking-payment.manual-payment.additional-settled`, and the REVERSAL gives
  back exactly what its settle took: the reversed amount is the figure that was
  written, and a covered extra goes back to owing (ADDITIONAL row → FAILED,
  column restored by a guarded claim matching exactly what the settle wrote).

## INV-PAY-048

- A stored, unconsumed credit election (#2265) on the booking is never
  silently stranded or ignored (door 3 of the #2319 invariant below): the
  settle clears it with the shared guarded claim, records the cleared cents
  on the mark-paid audit row, and reports it post-commit through
  `reportUnappliedCreditElection` (source `manual-mark-paid`) — the member's
  booking history says their credit was not used and is still available, and
  an operator is alerted to decide whether to refund the difference. The
  reversal does not resurrect a cleared election, so reversal-then-re-mark
  clears and reports exactly once.

## INV-PAY-049

- Both directions are audited with the acting admin and the previous status;
  marking paid also records the #2260 email decision BOTH ways.

## INV-PAY-050

- A Xero Stripe refund credit note (and its Stripe-bank refund payment)
  documents PROVIDER-BACKED CASH only, never account credit. The amount those
  documents may cover is `resolveStripeCashRefundEvidence`
  (`src/lib/stripe-cash-refund-evidence.ts`): the payment's `PaymentRefund`
  cents excluding only `failed` and `canceled` rows when any ledger rows exist,
  else the pre-ledger fallback of `refundedAmountCents` minus its
  account-credit disposition —
  never the raw `refundedAmountCents` mirror, which deliberately tracks both
  dispositions (#1031) and stays authoritative for settlement and
  conservation maths. Bound at every surface that can mint or size a refund
  note: health detection (`getRefundsMissingXeroCreditNotes`), the daily
  self-heal enqueue amount, the STRIPE enqueue cap, the execution-time delta
  recompute in `createXeroCreditNote` (which also completes a queued
  fictitious operation without billing Xero), and the #2901 link-repair
  coverage target. An account-credit cancellation therefore keeps exactly its
  `ACCOUNT_CREDIT_NOTE` and never grows a refund note (#2902).
- The exclusion list is deliberately the SAME as the `refundedAmountCents`
  mirror's (`EXCLUDED_LEDGER_REFUND_STATUSES`), so a refund Stripe has accepted
  but not yet settled keeps counting as cash exactly as it did before #2902
  (owner decision, 21 Aug 2026). Counting only `succeeded` would fix the
  account-credit defect while introducing the opposite reporting error — a
  still-settling refund resolving to zero cash, so the note UNDER-states what
  went back until somebody re-runs the report. The accepted cost is the one
  non-fail-safe limit in this module: a refund that is accepted and later
  `failed` counts as cash between those two events, bounded by the
  `refundedAmountCents` clamp and corrected by the next run.

## INV-PAY-002

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

## INV-PAY-003

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

## INV-PAY-004

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

## INV-PAY-005

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

## INV-PAY-006

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

## INV-PAY-007

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

## INV-PAY-008

- **A $0 waitlist confirm always ends in a state the member or a worker can
  move** (#2623). `POST /api/bookings/[id]/waitlist-confirm` is two-phase:
  phase one commits `WAITLIST_OFFERED -> PAYMENT_PENDING` and, in doing so,
  **consumes the offer** (`waitlistOfferedAt`, `waitlistOfferExpiresAt` and
  `waitlistPosition` are all nulled). A $0 booking sitting in `PAYMENT_PENDING`
  therefore holds no capacity, has no payment path and has no offer to replay,
  so every way phase two (the `PAYMENT_PENDING -> PAID` claim) can fail must
  either return the booking to `WAITLISTED` for the ordinary offer worker or say
  plainly that it could not. There are exactly four end states, and each one is a
  distinct coded response carrying `offerRevoked: true`
  (`src/lib/waitlist-confirm-recovery-contract.ts`):
  - capacity was lost under the locks — restored to `WAITLISTED` inside the same
    transaction, `WAITLIST_OFFER_RELEASED_CAPACITY` (409);
  - the booking moved under another writer — nothing written,
    `WAITLIST_CONFIRM_STATUS_MOVED` (409) with `bookingStatusUnconfirmed`, never
    a "capacity is gone" claim it cannot support;
  - phase two threw and the compensating release succeeded — the participant
    fence's frozen 409 (or `WAITLIST_CONFIRM_RELEASED_UNAVAILABLE`, 503 for
    contention) with `waitlistPlaceRestored: true`;
  - the compensating release itself failed — `WAITLIST_CONFIRM_AWAITING_OPERATOR`
    (503 for contention, else 500) with `awaitingOperatorRecovery: true`, plus a
    `critical` audit row (`waitlist.confirm_offer_release_failed`) so the
    operator-only state is searchable rather than silent.
  `WaitlistOfferCard` keys on `offerRevoked` — **not** on the error code, because
  a *phase-one* refusal shares `HOSTING_COVERAGE_PARTICIPANT_RETRY` with a
  phase-two one while leaving the offer intact — and withdraws the CTA in favour
  of "Reload booking status" whenever the flag is present. Money stays in integer
  cents throughout: the $0 `SUCCEEDED` Payment row is written only after the
  `PAID` claim succeeds, because a lost claim `return`s (and therefore commits),
  and `Payment.bookingId` is unique, so a row written before the claim would read
  as paid and block the booking's real payment row forever.

## INV-PAY-009

- No SETTLED booking carries a stored credit election (#2265, #2319). Once the
  money has been taken for the amount the intent or the invoice was raised at,
  "applying" the election would debit the member's balance for cash they have
  already handed over. So every settlement CLEARS the column, with the same
  guarded claim on the exact amount read (`clearStaleCreditElection`) that the
  consumers use, so a consumer racing the settle is never clobbered:
  - `markBookingPaymentSucceeded` — the single door the Stripe webhook, the
    session confirm, the public payment link, the saved-card charge and the
    auto-confirm cron all funnel through — clears on its `PAID` claim.
  - The Internet Banking inbound reconcile clears on its `PAID` flip, and on the
    late-capacity-failure `CANCELLED` flip in the same writer.
  - The repriced-to-$0 auto-pay arms of both modification services clear, as
    `confirm-draft`'s $0 confirm and group settlement already did.
  - The manual mark-paid settlement (#2262) clears on its `PAID` claim: the
    admin collected the full amount owing OUTSIDE the app, so the member's credit
    was NOT spent. The cleared cents are recorded on the mark-paid audit row
    (`clearedCreditElectionCents`). The reversal RESTORES exactly what
    that settle cleared, writing it to `Booking.creditElectionCents` under a
    guard matching `null`. Restoration is required:
    nothing outside booking-create can set that column, so a reversal that left
    it null would strand a member holding credit they had elected. Both figures
    are recorded on the mark-unpaid audit row (`restoredCreditElectionCents`,
    `settleClearedCreditElectionCents`).
  Clearing is the answer ONLY once the money is taken. While a booking is still
  payable the election remains honourable and must be consumed or left alone —
  never discarded to make a charge simpler. A reprice that leaves a booking
  payable keeps its election, and the public payment link REFUSES a booking that
  carries one (below) rather than clearing it.

## INV-PAY-010

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

## INV-PAY-011

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

## INV-PAY-012

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

## INV-PAY-013

- Stripe and Internet Banking/Xero settlement paths must remain distinct.

## INV-PAY-014

- Stripe paths own PaymentIntents, SetupIntents, Stripe refunds, Stripe
  webhooks, and durable PaymentRecoveryOperation rows.

## INV-PAY-015

- Internet Banking bookings issue Xero-backed invoices and reconcile settlement
  through Xero invoice/payment state.

## INV-PAY-016

- Internet Banking defaults are non-holding and no-cutoff. If bed holding is
  enabled, the hold expiry is snapshotted on the Payment and must be released
  idempotently by cron if unpaid.

## INV-PAY-017

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

## INV-PAY-018

- Cancelling a booking never rewrites captured-payment truth (#1473). "Captured"
  is decided on LEDGER evidence — a payment transaction row in a captured status
  (SUCCEEDED / (PARTIALLY_)REFUNDED), or, for STRIPE rows with no ledger rows,
  the refund mirror — never on the aggregate mirror alone, which the inbound
  reconcile folds invoice-applied modification credit notes into on
  never-captured IB payments. A never-captured payment flips to FAILED at cancel
  and its open invoice gets the finalPrice+changeFee invoice-clearing credit note
  (the #1015 outstanding-balance rule). A genuinely captured PARTIALLY_REFUNDED
  payment takes the PAID cancellation path (#1491, owner decision): the member
  receives the cancellation-policy tier of the REMAINING captured value
  (`refundableBase = min(amountCents − refundedAmountCents, finalPrice +
  changeFee) − changeFee`; change fees stay non-refundable), with the same
  claim-first single-flight, frozen card-refund plan, and credit-path ledger
  writes as a SUCCEEDED cancel. Paid-path eligibility is LEDGER-ONLY
  (`paymentEligibleForPaidCancelPath`, shared with the cancel-preview route so
  preview and cancel can never disagree); mirror-only legacy rows stay in the
  preserve branch. Two paid-path rules keep money truth intact: a captured
  INTERNET_BANKING payment's refund method is coerced to "credit" before the tier
  is computed, and any folded (mirror-only) refund is materialized into the
  capture ledger inside the claim transaction before new refunds execute. A
  captured payment that stays out of the paid path (fully REFUNDED, or a
  flattened legacy mirror) keeps its status and refund history, its captured
  Stripe intent is not sent a cancel, and no clearing note is enqueued. The
  repair pass's late-capture finding fires only when a cancelled booking retains
  captured value with NO recorded cancellation-refund decision (no CANCELLED
  policy snapshot, no cancellation credit, no LIVE booking-cancel refund recovery
  operation) and is never auto-applied: an operator executes it with
  `--apply --apply-action <key>` (#1491). Rows flattened by the old defect are
  not backfilled.

## INV-PAY-019

- Applied account credit is conserved across cancellation (#1547): EVERY
  `cancelBooking` branch — and the Internet-Banking hold-expiry release
  (`internet-banking-payment-cron.ts`), the one automatic cancel outside
  `cancelBooking` — reverses the negative `BOOKING_APPLIED` ledger rows. The
  never-captured / no-refund branches and the `PENDING` / no-payment branches
  restore at **100%**; the paid path restores the applied slice at the
  cancellation tier (#1164 / D7). Restore idempotency is STRUCTURAL, not
  lock-dependent (#1636): the restore row carries a nullable-unique
  `restoredFromBookingId`, so at most one restore row per booking can exist
  regardless of caller lock granularity — a duplicate insert is a
  `skipDuplicates` no-op. This is a restore-specific key, NOT a unique over
  `(sourceBookingId, type=CANCELLATION_REFUND)`, because three legitimate paths
  (`restoreCreditFromBooking`, `createCancellationCredit`'s held-as-credit
  refund, and the Xero inbound late-cash credit) all write that shape for one
  booking. Each branch's atomic status flip remains the primary single-flight — the never-captured and `PENDING` branches are status-guarded claim-first under the booking advisory lock too — but the unique key removes the cross-path lock-granularity dependence, so moving a credit-restoring path off the shared `lock(1)` (e.g. a per-lodge release lock) can no longer double a restore.
  A CANCELLED booking may legitimately hold consumed credit with NO restore row
  only when its payment captured money (0%-tier paid cancels write no restore
  row; held-as-credit refunds keep the applied rows) or settled without cash
  (the fully-credit-covered $0 SUCCEEDED payment takes the paid path). The daily
  credit-reconciliation cron alerts (alert-only, no auto-heal) on any CANCELLED
  booking still holding orphaned applied credit, and
  `scripts/backfill-orphaned-applied-credits.ts` heals pre-fix orphans. The
  cancelled-booking delete guard mirrors this: fully-reversed applied credit
  (net-zero, only `BOOKING_APPLIED`/`CANCELLATION_REFUND` rows, no Xero
  credit-note id) no longer blocks deletion, and the coincident
  `payment.creditAppliedCents` mirror is waived with it, while any
  `ADMIN_ADJUSTMENT`/`BOOKING_MODIFICATION_REFUND` row, net-non-zero ledger,
  Xero-linked note, or independently captured/refunded payment still blocks
  (owner decision 2026-07-07, FINAL).

## INV-PAY-020

- A booking confirmation must RECONCILE against the member's own statement when
  account credit paid part of the stay (#2328). Every confirmation carries the
  applied-credit pair beneath the total — `Account credit applied: -$120.00` then
  `Paid by <method>: $180.00` — so `total − credit = settled` is checkable on the
  page. The method is named only where money really changed hands: a stay fully
  covered by credit reads `Nothing more to pay: $0.00`, because the $0
  settlement's Payment row has no source and any method word would be a claim
  the records cannot support; the LINE still renders. "Total Paid" deliberately
  remains the FULL price (the same convention the #2397 rows follow). The figure
  is READ, never re-derived: `loadBookingAppliedCredit` sums the booking's
  `BOOKING_APPLIED` ledger rows — the same `deriveBookingAppliedCreditCents`
  authority the effective-price guards and the #1887 clamp use — and takes the
  settlement wording from the booking's own Payment row, so a bank transfer or a
  manually-recorded cash settlement is never described as a card charge.
  `sendBookingConfirmedEmail` performs the read itself rather than each of its
  send sites threading the figure in, so no site can omit it. Empty-case
  contract: no credit means no rows at all (byte-for-byte unchanged), and a send
  that reports money as NOT yet taken (`paymentDue`) renders no pair. The
  hand-built HTML and the admin-editable `{{creditNote}}` token are built from
  ONE shared row builder (`appliedCreditSummaryRows`), so the two paths cannot
  tell different stories. Money is integer cents throughout.

## INV-PAY-021

- An UNPAID confirmation defers to the INVOICE, and promises nothing about it
  (#2444). The `paymentDue` branch states the booking's own price as `Total Due`
  and asks for an internet-banking transfer, but the document the member pays
  against is the club's invoice, which an admin can adjust by hand. The
  paragraph therefore closes with a CONDITIONAL sentence — "If the invoice asks
  for a different amount — for example because the club has put account credit
  you hold towards it — please transfer the amount the invoice shows". It names
  NO second figure and makes NO Xero read: a transactional confirmation must not
  carry a provider round-trip in its send path. This is the shape sent whenever
  no applicable credit can be stated, and #2483 leaves it unchanged to the byte.
  **The sentence must not promise that credit WILL be applied.** The one send
  site (member whole-lodge approval) mints a brand-new booking and writes no
  `MemberCredit` row, so its `enqueueXeroAppliedCreditAllocationOperation` call
  always short-circuits and the Xero invoice stays at the full price;
  reinstating a netting claim requires making the allocation real first. The
  sentence is composed by `bookingPaymentDueNote` and rendered from that ONE
  composer by both the hand-built HTML and the `{{paymentDueNote}}` token
  (carried inside `{{paymentOutcome}}`); it rides on an EXISTING token, so an
  override a club saved before #2444 keeps rendering it. Every other money
  outcome is byte-for-byte unchanged.

## INV-PAY-022

- An UNPAID confirmation that DOES carry applied credit states the netting, from
  the club's OWN ledger (#2483; owner decision 2 Aug 2026). Where the booking
  carries `BOOKING_APPLIED` rows the Xero invoice is reduced by exactly that
  credit (allocate-existing, below), so the full price would make the member
  OVERPAY. The `paymentDue` branch renders the reconciling trio — `Booking
  Total`, `Account credit applied`, `Total Due` — from `unpaidMoneySummaryRows`,
  the shared builder both renderers use, and `bookingPaymentDueNote` names the
  netted figure and states the arithmetic in words. `{{totalDue}}` carries the
  NETTED figure; no token was added.
  **The figure is LOCAL by decision, not a guess at Xero.**
  `deriveBookingAppliedCreditCents` is the club's OWN amount-owing law — the same
  figure `prepareManualSettlement` derives an effective price from, the same one
  the card-capture amount guard accepts, and the same `desiredAppliedCents` the
  deallocation engine converges an invoice to.
  **It never asks for a figure the ledger contradicts.**
  `resolveUnpaidCreditNetting` has four outcomes. No credit (or a non-positive
  price) renders the #2444 paragraph unchanged. Credit smaller than the price
  states the trio and asks for the difference. Credit EQUAL to the price states
  `Total Due: $0.00` and asks for nothing (the documented steady state of the
  #1887 reprice clamp). Only credit LARGER than the price refuses, stating no
  figure: `{{totalDue}}` is EMPTY so no saved override can print one, no payment
  reference is quoted, the member is asked to wait, and the sender logs it. A
  failed ledger read fails open to the #2444 paragraph. How that figure relates
  to the allocation gate, which way the closing instruction leans, and the
  admin's whole-lodge invoice email are `INV-PAY-053`.

## INV-PAY-053

- **The netted figure is NOT the predicate the allocation gate reads** (#2483
  review, 2 Aug 2026). `enqueueXeroAppliedCreditAllocationOperation` aggregates
  only the `xeroCreditNoteId: null` UNALLOCATED subset, so the two agree only
  while a stamped row really means the credit is off the LIVE invoice. A hand
  edit in Xero, a FAILED or unprocessed allocation op, and a stamp that outlived
  a re-raised invoice all break that and are #2501's to surface: its checker must
  compare Σ STAMPED `BOOKING_APPLIED` against the live invoice's own allocations,
  not merely club credits against Xero credits.
- **The closing instruction inverts in ONE direction.** #2444 tells the member to
  transfer what the invoice shows; once the email has netted, the netted figure
  stands against an invoice asking for MORE (the invoice may not have been
  reduced yet) but NOT against one asking for LESS, the shape a hand edit in Xero
  produces. Pay the smaller of the two; route the disagreement to the club either
  way.
- **One number, every message on the send site.** With the Xero module OFF there
  is no invoice object and no allocation op, so
  `sendAdminWholeLodgeManualInvoiceEmail` takes the same ledger read and quotes
  the same figure (`wholeLodgeManualInvoiceAmountCents`). The PENDING receivable
  the conversion writes is the booking's price, which equals that figure only
  while the path applies no credit — the premise the #2328 module guard pins; a
  path that ever applies credit here must write the receivable at the effective
  price too, as `booking-create` already does.

## INV-PAY-023

- Applied credit reduces the Internet-Banking invoice by ALLOCATING the member's
  EXISTING floating credit notes (#1620, "allocate-existing"; owner decision
  2026-07-08). A member's credit is already represented in Xero as floating
  ACCRECCREDIT notes back-linked to the positive `MemberCredit` row's
  `xeroCreditNoteId`. When credit is applied to an IB booking (create-time or
  switch-to-IB), the raise-path engine (`xero-applied-credit-allocation.ts`, an
  outbox op enqueued after the invoice op) allocates those notes against the new
  invoice oldest-first, up to the applied amount; only the noteless remainder
 is covered by a freshly minted note. Per-note
  remaining balances live in `MemberCreditNoteAllocation`. The `payment` mirror holds
  `amountCents + creditAppliedCents = finalPriceCents` (net of
  `refundedAmountCents` once a #1765 repay generation exists; the switch path
  derives the applied amount from the `BOOKING_APPLIED` ledger). The engine
  STAMPS the booking's `BOOKING_APPLIED` rows with a representative allocated
  note id LAST — only once the full applied amount is covered — so the #1597
  clearing term is exact. Stated limit, the partial-window residual: a
  concurrent CANCEL treats the credit as unallocated and Xero rejects the excess
  LOUDLY; a concurrent HOLD-EXPIRY settles its clearing note by bank payment and
  silently over-credits Xero by the already-allocated slice — a bookkeeping-only divergence (member LOCAL money is conserved either way by the 100% restore) that an operator reconciles in Xero. The op's idempotent retry (the `@@unique(memberCreditId,
  appliedToBookingId)` join key + per-row completion links) finishes the
  allocations then stamps; its re-plan reads each lot's remaining balance
  EXCLUDING this booking's own already-committed allocation rows. A
  FAILED allocation op has no auto FAILED→PENDING reaper; recovery runs through
  the Xero outbox retry stack (`xero-operation-retry.ts`). Cancellation is
  UNCHANGED and still conserves: the 100% restore + `finalPrice − allocated`
  clearing note void the invoice while returning the credit LOCALLY; after a cancel of an allocated-credit booking the restored credit is local-only (its funding note was consumed by the cancelled invoice); the local ledger is the source of truth and Xero catches up when the credit is next used, via the noteless mint-fresh branch. ACCOUNTING-POLICY flag (open): the minted remainder note
  posts to the shared `hutFeeRefunds` mapping; a distinct write-off account is
  an owner call.

## INV-PAY-024

- Applied credit reduces the CARD (Stripe) charge the same way (#1641, owner
  decision 2026-07-08, extending the #1620 engine). The Stripe PaymentIntent is
  minted at the EFFECTIVE amount (`finalPriceCents − Σ BOOKING_APPLIED`, via
  `deriveBookingAppliedCreditCents`; a fully credit-covered booking is confirmed
  at $0 by the create-time zero-dollar path, so the intent route guards
  `effective > 0`). The `Payment` mirror carries `amountCents = effective`,
  `creditAppliedCents = applied`; once a repay generation exists (#1765) the
  mirror aggregates gross captures and the invariant is NET-based:
  `(amountCents − refundedAmountCents) + creditAppliedCents = finalPriceCents`
  at repay settlement. Every capture/reconciliation guard accepts EITHER the
  effective price OR the full `finalPriceCents` (legacy in-flight intents) and
  rejects any other amount (create-payment-intent reuse,
  `stripe-webhook-service`, `payment-reconciliation`, `confirm-payment`) — full
  price is always a legitimate settlement, and new bookings only mint effective
  intents. Because a card invoice is raised-and-paid at capture
  (`queueXeroInvoiceForPaidBooking` → `createXeroInvoiceForBooking`), the #1620
  fire-after-invoice outbox op is NOT used on card; `createXeroInvoiceForBooking`
  records the NET captured Stripe cash — gross captures − refunds, capped at the
  invoice's amount due (#1765: settlement evidence is captured-status + positive
  net cash, never `status === "SUCCEEDED"` alone, which misreads a repay-settled PARTIALLY_REFUNDED aggregate; every skip logs a populated reason) — and then SYNCHRONOUSLY
  re-drives the same allocation engine (gated the same way, plus
  `creditAppliedCents > 0`) so the invoice settles to PAID via effective cash +
  credit-note allocation. The allocation throws on failure (the invoice op fails
  and the retry short-circuits on the persisted `xeroInvoiceId`, re-driving the
  idempotent engine without re-creating the invoice). A LEGACY full-price card
  capture (`creditAppliedCents = 0`) is settled in full by cash and does NOT
  allocate; its historical double-pay is repaired by an operator-reviewed LOCAL
  credit restore, enumerated read-only by `auditCardAppliedCreditDoublePays`.

## INV-PAY-025

- A payment landing on an already-CANCELLED booking's stale open invoice must
  never settle silently (#1357). Minting therefore requires positive CASH evidence on the invoice
  (`amountPaid`, falling back to actual payment records), a payment that never
  settled (PENDING/FAILED), and no credit already minted by this pipeline (matched by its own credit descriptions — never by amount, which collides with unrelated cancellation-flow rows). Both
  credit-minting arms (already-cancelled and late-capacity-failure) size the mint
  by the invoice's QUANTIFIED cash (#1459), clamped per payment to the payment's
  own amount — `amountPaid` plus overpayment/prepayment allocations, falling back
  to the invoice's non-DELETED payment records only when `amountPaid` is unusable
  — never by the payment's face amount alone.
  Partially quantifiable evidence floors the mint at the verified cash and the
  alert says the figures are unverified; only evidence that quantifies NOTHING
  falls back to the full payment amount. The mint is also capped PER INVOICE
  (#1505): each arm caps at the invoice's quantified cash MINUS the cash already
  minted for the OTHER Internet Banking payments matched to the same invoice, so
  two never-settled payments on one invoice can never in aggregate mint more
  than the invoice's cash. The remaining-cash figure is read INSIDE each payment's reconcile
  transaction, under the shared advisory lock and excluding the payment's own
  booking, so the cap is idempotent under retry (a replayed payment finds its own credit via the per-booking dedup and mints nothing); an apportioned or fully-exhausted mint raises the same loud admin alert the partial-mint path uses, never a silent overmint. When it mints, the
  inbound reconcile creates the member credit and enqueues the offsetting
  account-credit note — both sized at the minted amount — and retires the
  now-obsolete still-PENDING invoice-clearing refund note, all in ONE
  transaction, then alerts once. Cash arriving AFTER a mint
  never credits automatically; when a later event's fully-verified cash exceeds
  the minted credit the reconcile alerts with the delta, and cash-classified
  evidence that quantifies to zero on a never-settled payment alerts as a payload
  anomaly rather than settling without a credit. A PAID invoice event never
  overwrites a (PARTIALLY_)REFUNDED payment or transaction status back to
  SUCCEEDED.

## INV-PAY-026

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

## INV-PAY-027

**Related: `INV-PAY-030`**, which puts the same obligation on EXTERNAL provider
side effects — email and Xero as much as money. The two are facets, not
duplicates (#2707, owner decision 9 Aug 2026): this one is about our own money
operations, and neither covers the other's ground. Change one, check the other.

- Payment, refund, and credit operations must be idempotent across retries,
  webhook replays, cron reruns, and partial failure recovery.

## INV-PAY-028

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

## INV-PAY-029

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

## INV-PAY-030

**Related: `INV-PAY-027`**, which puts the same obligation on OUR OWN payment,
refund and credit operations. The two are facets, not duplicates (#2707, owner
decision 9 Aug 2026): this one is wider than money and reaches every provider
call, so reading it as the money rule twice over drops that coverage. Change
one, check the other.

- External provider side effects require clear retry and idempotency behavior.

## INV-PAY-031

- An organiser-pays group settlement applies only when the payment matches the
  sum of the settleable children **at apply time**, re-verified under the lock
  — a child booking edited while the combined intent/invoice was open must not
  auto-settle at the stale total. Mismatches go to operator review: Stripe
  captures are auto-refunded with an admin alert; paid Internet Banking
  invoices stay PENDING with an admin alert.

## INV-PAY-032

- Committing organiser-pays group children to CONFIRMED before payment has an
  expiry path: the `group-settlement-reaper` cron releases the beds when the
  settlement stays unpaid past its window (never past check-in), voids the
  open intent, and notifies the organiser and joiners — idempotently, and a
  payment that lands first always wins under the shared lock.

## INV-PAY-033

- The reverted children have a terminal path too (#1094): joiners cannot pay
  an organiser-settled booking themselves, so if the FAILED settlement sits
  unretried through a second full reap window the same cron cancels the
  PAYMENT_PENDING children, exactly once, with a joiner notification. A
  settlement retry (which flips the row back to PENDING and resets its clock)
  always keeps the children alive — both are re-checked on the fresh row
  under the shared lock.

## INV-PAY-034

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

## INV-PAY-035

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

## INV-PAY-036

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

## INV-PAY-037

- A failed settlement refund must stay durably owed (#1351): the frozen plan
  is never nulled, a payment-recovery operation persisted before the inline
  Stripe call retries the refund under the same
  `group_cancel_refund_<settlementId>` key, and no interleaving of the inline
  run, the recovery replay, and the reaper resume may apply a per-child
  refund mirror twice — the replay only ever writes a mirror to an
  already-CANCELLED plan child whose `refundedAmountCents` is still zero,
  via a conditional update. Alerts fire on retry exhaustion only.

## INV-PAY-051

- **An unpriceable booking edit holds the money as an explicit typed review, and
  one occurrence is one task** (#3030, epic #2797, owner decisions D1-D3). When a
  valid structural edit's exact adjustment cannot be read from the booking's own
  stored sold-price evidence, the stay change completes and the money becomes an
  OPEN `ManualRefundTask` of kind `EDIT_FINANCIAL_REVIEW`. `amountCents` NULL
  means the amount is genuinely unknown and `0` may never be used to mean it;
  `paymentId` records the booking's captured money AT RAISE TIME and nothing
  backfills it — since #3194 the completion re-reads the booking's own payment
  and routes on that. Identity is the `occurrenceKey`, minted only by
  `editFinancialReviewOccurrenceKey`
  (`src/lib/edit-financial-review-occurrence.ts`), never a `reason` sentence, so
  a replay of one edit raises one task and no more. Completion carries the
  admin's confirmed POSITIVE integer cents plus a note, written inside the same
  status-guarded claim as the status so it cannot apply twice; a figure differing
  from one the task already held is the audited amendment D2 permits on this
  kind alone, with `raisedAmountCents` preserving what it was raised with.
  DISMISSED means reviewed and this system moved no money, and writes no amount;
  its REQUIRED note says whether nothing was owed or the club settled it outside
  the task. Nothing moves at Stripe, in the ledger, in Xero or as account credit
  until an admin confirms. The rest of the state machine: strands
  `INV-PAY-061`; occurrence lifecycle `INV-PAY-054` and `INV-PAY-062`;
  settlement routing `INV-PAY-055` and `INV-PAY-063`; the charging direction
  `INV-PAY-056`, `INV-PAY-064`, `INV-PAY-057`, `INV-PAY-065`, `INV-PAY-058` and
  `INV-PAY-066`; the refund legs and the anchor `INV-PAY-059`; the fence and
  the constraints `INV-PAY-060`.

## INV-PAY-061

- **One task per parked STRAND, and the DEPARTING strand is always one of them**
  (#3032). The occurrence key is minted per strand, so a replay of the same edit
  re-derives the same keys and creates nothing. A remaining strand is recorded
  when its own rows cannot be read; it carries no surrendered nights and its
  honest resolution is often DISMISSED with a note. The strand actually leaving
  is recorded on every parked removal, whether or not its own rows read cleanly,
  because the delete destroys the guest's night rows: where that strand's rows
  ARE exact its cause is `COUNTERPART_STRAND_UNREADABLE`, its stored evidence
  carries the real per-night prices, and no `amountCents` is written, because
  the money that goes back also depends on the cancellation tier and the promo
  recalculation a parked removal skips. **A parked edit never destroys a number
  the system could have known.**

## INV-PAY-054

- **A SETTLED occurrence does not suppress the next one of the same identity**
  (#3166). A replay collapses into an OPEN task and only an OPEN task; a
  COMPLETED or DISMISSED row at the same key means a person already answered
  that question, so the raise walks past it onto a `#n` recurrence key and writes
  a new OPEN task. The settled row is never reopened, amended or re-keyed. A
  replay cannot see a terminal row: the raise runs inside the caller's
  transaction, and a new edit reaches the raise only after
  `assertNoPendingEditFinancialReview` has confirmed nothing on the booking is
  OPEN. Pinned by `edit-financial-review.test.ts` and
  `edit-financial-review-races.realdb.test.ts`.
- **A stored night price is not proof of a sold price, which is why a human
  prices this.** Two backfill migrations (`20260704150000`, #1098;
  `20260810010000`) populated `BookingGuestNight.priceCents` by dividing a stored
  guest total by the night count, and nothing in the schema tells such a row
  apart from a genuinely-sold one. The evidence captured in `reviewContext`
  records what the database HELD and claims no more. Separating derived rows from
  sold ones is #3031's.
- **An OPEN task may carry an amount.** The raise may write a figure to both
  `amountCents` and `raisedAmountCents`; `priced-but-still-OPEN` means *the edit
  could prove a figure and a human has not yet confirmed it*. Money moves only on
  a COMPLETED transition, whatever the row already holds.

## INV-PAY-062

- **A completion at zero is refused, and the refusal names the way out.** `0`
  means the club handed nothing back, so COMPLETED at `0` would assert a refund
  that did not happen, and `booking-narrative.ts` selects a cancelled booking's
  settlement event by TYPE without filtering on amount. "Reviewed, nothing is
  due" is DISMISSED. The owner re-decided this on 31 Aug 2026 (#3195 question 1)
  and kept it; **a bare refusal is not compliant** — the sentence must name the
  action in the officer's own screen's words ("no adjustment" on a financial
  review, "dismiss" on a legacy hand-back). `zeroCompletionRefusal` is the one
  home for both sentences; the admin route's schema no longer rejects a zero
  because it cannot know which control to name, and the settle screen reads the
  same refusal.
- **A credit-only completion records no refund.** Where the booking has no
  captured money, `Payment.refundedAmountCents` is untouched and no `REFUNDED`
  booking event is written — that log is member-facing. Since #3032 such a
  completion does ISSUE account credit and records `CREDITED` after the commit;
  since #3194 that branch is reached by asking the BOOKING at completion rather
  than reading the frozen `ManualRefundTask.paymentId`.

## INV-PAY-055

- **A confirmed amount is settled through the settlement path that already
  exists, never a fourth one** (#3032). The booking's payment decides which: a
  canonical Stripe refund for a card capture, made AFTER the commit; the local
  ledger allocation for an internet-banking hand-back; or
  `createBookingModificationCredit` where nothing was captured, whose
  exactly-once key is the `BookingModification` id. **Which one is a question
  about the booking, asked at completion** (#3194): a task carrying no payment id
  re-reads the booking's own payment through `editReviewSettlementPayment`, the
  single derivation the raise sites use too (`editReviewSettlementPaymentId`). A
  task that DOES carry a payment id is still routed by that id, because the
  stored id reaches routes the live row no longer would (a reversed manual
  settlement, a booking that has left the settled statuses) where the amount is
  capped and an over-cap is REFUSED with the task left OPEN. The re-read writes
  nothing, so a replayed capture or webhook cannot produce a second refund. A
  matching Xero modification credit note is queued on the same anchor through
  `queueXeroBookingEditSettlement`, the choke point the three booking-edit
  services use. The route is chosen and every refusal raised BEFORE the status
  claim, so a refused completion leaves the task OPEN; the Stripe route writes
  no allocation of its own, because `refundPaymentTransactions` writes it. The
  completion holds no advisory lock (`docs/CONCURRENCY_AND_LOCKING.md`), so the
  status claim is the whole single-flight guarantee.

## INV-PAY-063

- **A completion states WHICH WAY the money goes, and the row records it**
  (#3170, owner decision 30 Aug 2026). `ManualRefundTaskDirection` is written
  into `settlementDirection` inside the same status-guarded claim as the amount,
  and the amount stays a POSITIVE magnitude on both directions — the sign of a
  money value is never overloaded to mean a direction. An `EDIT_FINANCIAL_REVIEW`
  completion that states no direction is refused before the claim; silence on a
  legacy kind means `REFUND_TO_MEMBER`, and `CHARGE_TO_MEMBER` on one is refused
  outright. A dismissal records no direction.
- **The charging direction is the additional-payment path, not a new mechanism**
  (#3170). A `CHARGE_TO_MEMBER` completion re-enters
  `createModificationAdditionalPaymentIntent` — the same function every ordinary
  booking-edit price increase goes through — so the instrument, the PENDING
  `ADDITIONAL` `PaymentTransaction`, the chase reminders, the member's pay link
  and the Xero supplementary invoice's wait-for-payment are the existing ones.
  NOTHING IS TAKEN FROM THE CARD BY THE COMPLETION: it raises the request and the
  member pays it. A booking with neither a captured card payment nor an issued
  Xero invoice is REFUSED before the claim, with the task left OPEN. The Xero leg
  is the same choke point with a POSITIVE `priceDiffCents`, the only place the
  direction becomes a sign.

## INV-PAY-056

- **ONE BOOKING EDIT RAISES ONE CHARGE REQUEST, for the total of its shares**
  (#3170, owner decision 30 Aug 2026). One edit raises one review task per guest
  strand whose history could not be read, and an officer may settle both as
  money owed to the club; two separate requests LOSE MONEY, because minting an
  additional PaymentIntent queues every OTHER outstanding `ADDITIONAL`
  transaction for cancellation and `reconcilePaymentAggregates` carries a single
  `additionalAmountCents`. So:
  - **The REQUEST is anchored to the `BookingModification`** — one intent, one
    `ADDITIONAL` row, one figure on the member's pay link — and BOTH the Stripe
    idempotency key and the recovery operation are scoped to it. A later share
    RAISES that intent's amount rather than minting a second. (The REFUND keys
    stay TASK-scoped: two refunds of one edit are two movements that must never
    converge.)
  - **The SHARE stays anchored to the task** — its `amountCents`,
    `settlementDirection` and audit entry — so the combined figure remains
    explainable.
  - **The total is DERIVED from the settled shares, never incremented.** Each
    task contributes exactly once, from the row its own status-fenced claim
    wrote; whichever completion commits LAST derives the true total, and
    **neither leg may LOWER what is recorded**. On the Stripe leg that is a
    compare-and-set on the request, which is why it needs no advisory lock.
  - **A share may not be added to a request the member has already paid, or to
    one whose supplementary invoice has already been issued.** Both are REFUSED
    before the claim with the task left OPEN. The Xero leg is `INV-PAY-064`.

## INV-PAY-064

- **The Xero leg bills the TOTAL, on ONE invoice per edit, enforced rather than
  assumed** (#3170). A share arriving while this edit's supplementary invoice
  operation is still PENDING or WAITING_PAYMENT RAISES that operation's amount
  rather than queueing a second invoice. `enqueueXeroSupplementaryInvoiceOperation`
  decides link-check → queued-check → write inside ONE transaction holding
  `pg_advisory_xact_lock(hashtext("xero-supplementary-invoice"),
  hashtext(<anchor>))`, and looks for an outstanding invoice by ANCHOR rather
  than by the amount-derived correlation key — the active `SUPPLEMENTARY_INVOICE`
  link exists only once the FIRST invoice has been created, so before that it
  fences nothing.
- **A restate that WRITES is a restate that goes out.**
  `processQueuedXeroOutboxOperations` re-reads `requestPayload` after its claim
  commits; RUNNING is outside the restatable set, so a restate either lands and
  is sent or matches nothing and reports zero, with no third outcome.
- **What the accounting leg does NOT guarantee, stated rather than implied.** A
  restate can arrive too late to land AT ALL — once the worker has claimed the
  operation it is RUNNING, and once the invoice has been sent the anchor carries
  an active `SUPPLEMENTARY_INVOICE` link. The enqueue then refuses a second
  invoice behind the first and RECORDS the shortfall:
  `outcome: "short-sent"` when the invoice exists, `"short-in-flight"` when the
  worker has merely claimed the row. What happens next is `INV-PAY-057`.

## INV-PAY-057

- **A recorded shortfall is BILLED, ON A SECOND SEPARATE INVOICE — not collected
  by hand** (#3193, owner decision 31 Aug 2026). **No invoice already in a
  member's hands is altered or voided.** This NARROWS "one booking edit, one ask"
  (`INV-PAY-056`) without overturning it: while the change's invoice is still in
  the queue a later share RAISES it and the member is asked once; only once the
  invoice has been SENT does the difference become its own ask. The cost — two
  requests for one change in that narrow window — was accepted knowingly.
- **ONLY A SENT INVOICE BUYS A SECOND ASK.** `short-sent` is durable evidence: an
  active `SUPPLEMENTARY_INVOICE` link means an invoice exists and what it bills
  can never change. `short-in-flight` is NOT evidence: a claimed row can return
  to PENDING un-attempted (by exactly one route, a process-global Xero cooldown
  refusal), the NEXT settlement then raises that row to the COMBINED total, and
  the change-anchored restate cannot see a second ask anchored elsewhere. So
  `short-in-flight` raises nothing and takes the recorded-shortfall path.
- **It bills the SHARE, never the total.** `short-sent` is reached only after a
  restate found nothing restatable and nothing already covering, so the settled
  share is provably absent from the invoice that went out. Every share is billed
  exactly once, and no figure is ever read back off a sent invoice.
- **It is anchored and idempotent like the first, through the SAME locked
  decision.** `enqueueXeroSecondSupplementaryInvoiceOperation` is a NAMED path
  over `enqueueXeroSupplementaryInvoiceOperation`, anchored to the
  `ManualRefundTask` whose share it bills: one invoice per share, safe to run
  twice, and invisible to every read that decides whether the booking change
  already has an invoice going out. It attaches to no PaymentIntent and is
  queued PENDING rather than WAITING_PAYMENT. Both endings are recorded:
  `INV-PAY-065`.

## INV-PAY-065

- **Both endings of a shortfall are recorded, with opposite instructions**
  (#3193). A raised second ask writes
  `booking.editFinancialReview.chargeShareReinvoiced` (`payment`, `info`,
  `success`), because a member about to receive two invoices for one change will
  ask why. `booking.editFinancialReview.chargeShareUncollected` fires only when
  the second invoice was NOT raised, and its prose says why: `failed` means raise
  one by hand for the difference only; `withheld` means the change's own invoice
  had not gone out yet, so check this booking against Xero before billing
  anything; `unavailable` means the difference cannot be worked out
  automatically, so do NOT raise one and run the booking-vs-Xero repair instead
  (the recovery replay is the one caller there — it holds the edit's combined
  total and no single share); `nothing-to-bill` means no positive difference.
- **The booking-vs-Xero repair tool reads the expected supplementary-invoice
  total from the settled review shares** rather than from the
  `BookingModification` row, which a parked edit leaves at zero (#3187) — so a
  missing invoice is queued for the settled total and one that went out short is
  reported as `XERO_AMOUNT_MISMATCH` for a person to correct. Since #3193 it is
  the instrument for the `withheld` case that #3193 deliberately does NOT bill:
  a share withheld while the change's invoice was in flight.

## INV-PAY-058

- **A durable retry closes the debt only when the ask EXISTS afterwards.** The
  recovery replay re-derives the total through the same sync the inline
  completion uses, which reports which of four things happened (`nothing-owed`,
  `raised`, `already-paid`, `not-raised`); on `not-raised` the replay leaves its
  operation open so the existing back-off, retry and admin-alert machinery
  carries the debt, because the mint SWALLOWS a provider failure by design and
  the re-enqueued row's upsert does not reset `status`.
- **A recovered ask raises the accounting invoice the inline attempt deferred**
  (#3181). The inline settlement SKIPS the supplementary invoice while an
  additional Stripe payment is required and no intent exists yet; the replay
  completes the deferral by re-entering the same settlement dispatcher with the
  intent set, on BOTH forks (an ordinary edit bills the `BookingModification`'s
  signed components, a review charge bills the combined total). It queues no
  second invoice because the anchor-scoped, advisory-locked decision is the only
  one. A failure to queue is recorded and NOT retried, because the replay has
  already written this edit's `ADDITIONAL` transaction and a retry would read
  that row as a supersession; that binds EVERY `await` after the write, and the
  read of the signed components happens BEFORE the mint. The booking-vs-Xero
  repair pass offers `QUEUE_SUPPLEMENTARY_INVOICE` built from the same two
  components.
- **The replay bills the EDIT's answer to "was there an invoice to supplement",
  never the answer that is true when the cron arrives** (#3181). A primary
  invoice minted after the edit already bills the edit itself, so the edit-time
  value is frozen on the recovery row
  (`PaymentRecoveryOperation.hadIssuedXeroInvoice`) and read back; NULL means
  "not recorded" and raises nothing, because a missing invoice is surfaced by the
  repair pass and a duplicate one by nobody. The repair pass's own answer, and
  the records a replay leaves, are `INV-PAY-066`.

## INV-PAY-066

- **The booking-vs-Xero repair pass asks the same question from the operation
  history** (#3199), for historical bookings with no `hadIssuedXeroInvoice`: the
  primary invoice counts as raised before an edit only when a SUCCEEDED or
  PARTIAL `INVOICE`/`CREATE` operation carrying that invoice's `xeroObjectId`
  has an EARLIEST `completedAt` strictly before `BookingModification.createdAt`;
  anything else is `unknown`, and reports at `manual_review` with no action rather than billing; `--apply` skips it and nothing is dropped silently. The check engages on an edit whose modification row nets positive OR that added a guest, never on the expected ask (`resolvePrimaryInvoiceEditTiming` in
  `xero-booking-repair-analysis.ts`, pinned by `xero-booking-repair.test.ts`).
- **A replay raises no invoice against an ask that was already paid** (#3181):
  its webhook cannot fire again, so a WAITING_PAYMENT invoice would never be
  released and would read as `BLOCKED_BY_XERO_OPERATION` instead of the critical
  one-click `MISSING_SUPPLEMENTARY_INVOICE`.
- **The review fork's failure to raise leaves its own durable record** (#3181):
  `booking.editFinancialReview.chargeShareUncollected` on the `xero-invoice` leg
  with cause `ask-not-raised`, distinct from `ask-closed` (an invoice exists and
  bills too little) and `ask-owed-unknown` (a recovery row predating
  `hadIssuedXeroInvoice`, which names the repair pass and says not to raise one
  by hand, because the primary invoice may already bill the charge).
- **Every path that settles a share without producing a request leaves a durable
  trace** — an audit row with a `leg` of `payment-request` or `xero-invoice`,
  never only a `logger.warn`. Since #3193 the `xero-invoice` leg reaches that row
  only when the second invoice could not be raised; when it was raised the trace
  is `chargeShareReinvoiced`, so "no row" never has to be read as "probably fine".

## INV-PAY-059

- **The card route is capped before it claims, and keyed to the TASK.** The cap
  is measured off the booking's captured `PaymentTransaction` rows, not off
  `Payment.source`. Both the cap and the frozen
  per-transaction allocation are answered before the claim, because
  `refundPaymentTransactions` refuses after the commit, where a refusal would
  leave a permanently COMPLETED task with nothing moved. The Stripe idempotency
  key prefix and the recovery operation are keyed to the TASK rather than the
  `BookingModification`: one edit can raise TWO review tasks, so a
  modification-scoped key would let two same-amount refunds share one Stripe key
  and let two tasks upsert one recovery row.
- **The refund debt is persisted inside the completion transaction, before any
  provider call**. This path holds no
  advisory lock, so its claim commits before Stripe is called; the cron replays
  the frozen slices under the stored task-scoped prefix, Stripe answers a repeat
  with the original refund, and the ledger dedupes on refund id.
- **`applyLocalRefundAllocation` compare-and-sets** on the `refundedAmountCents`
  it read (#3032): it writes an ABSOLUTE value, so two writers on one
  `PaymentTransaction` would silently OVERSTATE the refundable headroom, and a
  review completion allocates against a LIVE booking with no lock. The guard
  refuses loudly; the completion turns that into a 409 with its transaction
  rolled back and its task still OPEN.
- **The settlement anchor is the ORIGINAL edit's `BookingModification`** (owner
  decision D-3032-1), carried on `reviewContext.bookingModificationId` and
  deliberately NOT part of the occurrence identity. `MemberCredit.sourceBookingModificationId`
  is unique, so an anchor that already carries a credit is refused with a typed
  409 — ANY pre-existing credit, including one whose amount matches, because a
  matching amount is indistinguishable from a coincidence. The refusal tells the
  operator to settle the amount another way and dismiss with a note, an honest
  terminal state under the DISMISSED definition.

## INV-PAY-060

- **While a review is OPEN, a second money-affecting edit to that booking is
  refused** (#3032, `assertNoPendingEditFinancialReview`), because pricing one
  would mean starting from the amount under review. **All FOUR money-affecting
  doors are fenced**: the batch edit, the date edit, the single-guest removal,
  and `POST /api/bookings/[id]/guests`, which reprices inline in the route. Each is called inside the transaction, after the locks and the post-lock re-read, below authorisation and before any write, and each surfaces the 409 with its `code` above its handler's generic `ApiError` branch. Identity-only edits, credit elections, the price-preserving admin date
  shift and consent-authority removals (owner decision D-14) are not fenced.
- **Three database constraints, because prose is not enforcement** (migration
  `20260903010000`). An `EDIT_FINANCIAL_REVIEW` row must carry its
  `occurrenceKey` (`ManualRefundTask_edit_review_occurrence_key_present`) —
  PostgreSQL exempts NULL from a unique index. Every OTHER kind must carry an
  amount (`ManualRefundTask_non_edit_review_amount_present`). A non-null
  `raisedAmountCents` requires a non-null `amountCents`
  (`ManualRefundTask_raised_amount_requires_amount`). That `raisedAmountCents` is
  never amended is a property of an UPDATE and is NOT enforced by the database;
  it holds because the column has one writer and every completion audits the
  previous and raised figures.
- **An OPEN review can block reversal of a manual settlement**, accepted as
  correct (owner decision D-3032-2). It falls out of `INV-PAY-045`. MEASURED
  SCOPE: that guard reads `{ paymentId, status: OPEN }`, so it is scoped to the
  PAYMENT, not the booking — a review raised against a captured payment blocks a
  reversal of that payment's manual settlement; the ordinary credit-only review
  (`paymentId` NULL) blocks nothing.
- **What #3030 enforces versus what #3032 wires.** #3030 ships the state, the
  single occurrence-key mint, the raise, the DB constraints and the audited
  completion. #3032 adds the settlement routing, the anchor, the Xero leg, the
  pending-review fence — and ONE production raise caller:
  `removeBookingGuestInTransaction`, where an unpriceable single-guest removal
  commits structurally and parks its money (`INV-MOD-028`). The in-progress
  batch edit does NOT yet raise; it still refuses, for the structural reason
  stated in `INV-MOD-028`.
