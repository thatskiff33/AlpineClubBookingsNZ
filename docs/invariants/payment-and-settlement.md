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

## INV-PAY-047

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
  non-refundable), with the same claim-first single-flight,
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

## INV-PAY-019

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

## INV-PAY-020

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

## INV-PAY-021

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

## INV-PAY-022

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

## INV-PAY-023

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

## INV-PAY-024

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

## INV-PAY-025

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
  backfills it, so NULL there is not a claim that the booking has no money —
  since #3194 the completion re-reads the booking's own payment and routes on
  that. Identity is the `occurrenceKey`, minted
  only by `editFinancialReviewOccurrenceKey`
  (`src/lib/edit-financial-review-occurrence.ts`), never a `reason` sentence — so
  a replay of one edit raises one task and no more. Completion carries the admin's confirmed
  POSITIVE integer cents plus a note, written inside the same status-guarded
  claim as the status so it cannot apply twice; a figure differing from one the
  task already held is the audited amendment D2 permits on this kind alone, with
  `raisedAmountCents` preserving what it was raised with. DISMISSED means reviewed
  and this system moved no money, and writes no amount; its REQUIRED note is what
  says whether nothing was owed or the club settled it outside the task. Nothing
  moves at Stripe, in the ledger, in Xero or as account credit until an admin
  confirms.
  - **A SETTLED occurrence does not suppress the next one of the same identity**
    (#3166). A replay collapses into an OPEN task and only an OPEN task; a
    COMPLETED or DISMISSED row at the same key means a person already answered
    that question, so the raise walks past it onto a `#n` recurrence key and
    writes a new OPEN task. The settled row is never reopened, amended or
    re-keyed. The two are distinguishable because a replay cannot see a terminal
    row: the raise runs inside the caller's transaction, so a rolled-back attempt
    leaves nothing to find, and a new edit reaches the raise only after
    `assertNoPendingEditFinancialReview` has confirmed nothing on the booking is
    OPEN. Before this, a parked guest-add — whose identity cannot move, because
    it surrenders no night and writes no row — raised nothing after the first
    settlement: no task, no charge, no banner, repeating per guest. Pinned by
    `edit-financial-review.test.ts` and, against a real server, by
    `edit-financial-review-races.realdb.test.ts`, which asserts both directions.
  - **A stored night price is not proof of a sold price, which is why a human
    prices this.** Two backfill migrations populated
    `BookingGuestNight.priceCents` by dividing a stored guest total by the night
    count (`20260704150000`, #1098; and `20260810010000`, whose header says it
    "deliberately does NOT reprice anything: it reads the stored total and
    divides"), and nothing in the schema tells such a row apart from a
    genuinely-sold one. The evidence captured in `reviewContext` therefore
    records what the database HELD, and claims no more than that. Separating
    derived rows from sold ones is #3031's; for this invariant it is the
    argument, not an exception — a figure whose provenance cannot be established
    is precisely the figure the club must confirm rather than the system
    reconstruct.
  - **An OPEN task may carry an amount, and that state is defined.** The raise
    accepts a figure and writes it to both `amountCents` and `raisedAmountCents`,
    so `priced-but-still-OPEN` is legal and means *the edit could prove a figure
    and a human has not yet confirmed it*. It decides nothing and moves nothing:
    money moves only on a COMPLETED transition, whatever the row already holds.
    The ordinary case is still `amountCents` NULL. (`raisedAmountCents` has no
    caller passing it on `main`; #3031 is the child that will prove figures.)
  - **A completion at zero is refused, and the refusal names the way out.** `0`
    means the club handed nothing back, so COMPLETED at `0` writes a row and a
    `REFUNDED` booking event asserting a refund that did not happen - and
    `booking-narrative.ts` selects a cancelled booking's settlement event by TYPE
    without filtering on amount, so that event is chosen and shadows any genuine
    later one. "Reviewed, nothing is due" is DISMISSED. This is the same magic
    zero the epic exists to remove, arriving through the completion door.

    The owner re-decided this on 31 Aug 2026 (#3195 question 1) and kept it,
    knowingly accepting its cost: an officer who has genuinely concluded the
    answer is nothing must reach for a differently-named action. So **a bare
    refusal is not compliant with this rule** - the sentence must name that
    action, in the words the officer's own screen uses, which is "no adjustment"
    on a financial review and "dismiss" on a legacy hand-back. It is therefore
    refused in ONE layer now rather than two: the admin route's schema no longer
    rejects a zero, because it does not read the task's kind and so cannot know
    which control to name. `zeroCompletionRefusal` is the one home for both
    sentences, and the settle screen reads it too - the button is disabled at
    zero, so without that the officer would press nothing and be told nothing.
  - **A credit-only completion records no refund.** Where the booking genuinely
    has no captured money there is nothing to allocate against,
    `Payment.refundedAmountCents` is untouched, and no `REFUNDED` booking event is
    written - that log is member-facing and must not claim money the system did
    not return. Since #3032 such a completion does ISSUE account credit, and
    records `CREDITED` after the commit, where the money moved. Since #3194 that
    branch is reached by asking the BOOKING at completion rather than by reading
    `ManualRefundTask.paymentId`, which is frozen when the review is raised: a
    review parked before the member paid carried NULL for ever, so a card payment
    made while the review was open could only ever come back as club credit.
  - **A confirmed amount is settled through the settlement path that already
    exists, never a fourth one** (#3032). The booking's payment decides which: a
    canonical Stripe refund for a card capture, made AFTER the commit; the local
    ledger allocation for an internet-banking hand-back; or
    `createBookingModificationCredit` where nothing was captured, whose
    exactly-once key is the `BookingModification` id. **Which one is a question
    about the booking, asked at completion** (#3194): a task carrying no payment
    id re-reads the booking's own payment through `editReviewSettlementPayment` —
    the single derivation the raise sites use too, through its id-only sibling
    `editReviewSettlementPaymentId` — so a member's refund does not depend on
    whether they happened to pay before or after an unrelated edit was parked.
    A task that DOES carry a payment id is still routed by that id, because the
    stored id reaches routes the live row no longer would (a reversed manual
    settlement, a booking that has left the settled statuses) where the amount is
    capped and an over-cap is REFUSED with the task left OPEN; re-deriving
    unconditionally would turn each of those refusals into account credit. The
    re-read writes nothing, so a replayed capture or webhook cannot produce a
    second backfill or a second refund. A matching Xero modification
    credit note is queued on the same anchor through
    `queueXeroBookingEditSettlement`, the choke point the three booking-edit
    services already use - a completion that moved money and dispatched no Xero
    delta would leave an issued invoice and the ledger permanently disagreeing.
    The route is chosen and every refusal raised BEFORE the status claim, so a
    refused completion leaves the task OPEN and nothing half-applied; the Stripe
    route writes no allocation of its own, because `refundPaymentTransactions`
    writes it and doing both would consume the refundable headroom twice. The
    completion holds no advisory lock - see `docs/CONCURRENCY_AND_LOCKING.md` for
    why that is deliberate - so the status claim is the whole single-flight
    guarantee.
  - **A completion states WHICH WAY the money goes, and the row records it**
    (#3170, owner decision 30 Aug 2026). Every kind older than
    `EDIT_FINANCIAL_REVIEW` can only hand money back, so "refund task" carried the
    direction and no column was needed. #3170 is the first child that parks an
    edit which can move the price UP, so an officer pricing one may correctly
    conclude the CLUB is owed. `ManualRefundTaskDirection` is therefore written
    into `settlementDirection` inside the same status-guarded claim as the amount,
    and the amount stays a POSITIVE magnitude on both directions - the sign of a
    money value is never overloaded to mean a direction. An
    `EDIT_FINANCIAL_REVIEW` completion that states no direction is refused before
    the claim; silence on a legacy kind still means `REFUND_TO_MEMBER`, which is
    all it can mean there, and `CHARGE_TO_MEMBER` on one is refused outright. A
    dismissal records no direction, because nothing moved.
  - **The charging direction is the additional-payment path, not a new
    mechanism** (#3170). A `CHARGE_TO_MEMBER` completion re-enters
    `createModificationAdditionalPaymentIntent` - the same function every ordinary
    booking-edit price increase goes through - so the instrument, the PENDING
    `ADDITIONAL` `PaymentTransaction`, the chase reminders, the member's pay link
    and the Xero supplementary invoice's wait-for-payment are the existing ones.
    NOTHING IS TAKEN FROM THE CARD BY THE COMPLETION: it raises the request and
    the member pays it. The club has exactly two instruments - a captured card
    payment, or an issued Xero invoice to add a supplementary line to - and a
    booking with neither is REFUSED before the claim, with the task left OPEN,
    rather than recorded as collected. The Xero leg is the same choke point with a
    POSITIVE `priceDiffCents`, which is the only place the direction becomes a
    sign.
  - **ONE BOOKING EDIT RAISES ONE CHARGE REQUEST, for the total of its shares**
    (#3170, owner decision 30 Aug 2026). One edit raises one review task per guest
    strand whose history could not be read, so two is ordinary, and an officer may
    settle both as money owed to the club. Two separate requests LOSE MONEY:
    minting an additional PaymentIntent queues every OTHER outstanding
    `ADDITIONAL` transaction on that payment for cancellation, and
    `reconcilePaymentAggregates` carries a single `additionalAmountCents` rather
    than a sum, so $200 then $30 collected $30 of $230 with both tasks COMPLETED
    and both audited as settled. So:
    - **The REQUEST is anchored to the `BookingModification`** - one intent, one
      `ADDITIONAL` row, one figure on the member's pay link - and BOTH the Stripe
      idempotency key and the recovery operation are scoped to it. A later share
      RAISES that intent's amount rather than minting a second, so nothing is ever
      superseded between two shares of one edit. (The REFUND keys stay TASK-scoped,
      and that is not an inconsistency: a refund is money already sent, so two
      refunds of one edit are two movements that must never converge.)
    - **The SHARE stays anchored to the task** - its `amountCents`, its
      `settlementDirection` and its audit entry - so the combined figure remains
      explainable back to the decisions that produced it.
    - **The total is DERIVED from the settled shares, never incremented.** That is
      the concurrency argument: each task contributes exactly once, from the row
      its own status-fenced claim wrote, so two officers closing two tasks at once
      cannot double-count. Whichever completion commits LAST reads after both
      commits and therefore derives the true total; a settled share is terminal, so
      the total only ever grows and a smaller figure is always the older answer.
      **Neither leg may LOWER what is recorded**, which is what makes the outcome
      independent of the order two concurrent settlements land in. On the Stripe
      leg that is a compare-and-set on the request, and it is why that leg needs no
      advisory lock. The accounting leg needs one, and has one, for the reason
      below.
    - **A share may not be added to a request the member has already paid, or to
      one whose supplementary invoice has already been issued.** Both are REFUSED
      before the claim with the task left OPEN. Minting a remainder request instead
      would be a second outstanding request against one edit - the arrangement that
      lost the money - and the internet-banking route reaches the second case
      routinely, because its supplementary invoice is raised unpaid and issues as
      soon as the outbox runs.
    - **The Xero leg bills the TOTAL, on ONE invoice per edit, and that is
      enforced rather than assumed.** A share arriving while this edit's
      supplementary invoice operation is still PENDING or WAITING_PAYMENT RAISES
      that operation's amount rather than queueing a second invoice.
      `enqueueXeroSupplementaryInvoiceOperation` decides link-check ->
      queued-check -> write inside ONE transaction holding
      `pg_advisory_xact_lock(hashtext("xero-supplementary-invoice"),
      hashtext(<anchor>))`, and looks for an outstanding invoice by ANCHOR rather
      than by the amount-derived correlation key. Both halves are needed: the
      active `SUPPLEMENTARY_INVOICE` link only exists once the FIRST invoice has
      been created, so before that it fences nothing, and while the queued lookup
      keyed on an amount, $200 and $30 were two different keys - two operations,
      two Xero invoices, $430 billed for a $230 edit. That shape was introduced by
      the combining (each share used to queue its own amount and the concurrent
      case summed correctly) and is closed by it.
    - **A restate that WRITES is a restate that goes out.** The outbox worker used
      to read an operation's payload from its SCAN and claim the row only when its
      loop reached it, one Xero round trip per row later. In that window the row is
      still PENDING, so a restate matched, wrote, and honestly reported that it had
      restated - while the send used the scanned figure and the caller returned
      early believing the combined total was billed. On the internet-banking route,
      where the supplementary invoice IS the ask, that invoiced $200 of a $230 edit
      and left the $30 existing nowhere. `processQueuedXeroOutboxOperations` now
      re-reads `requestPayload` after its claim commits; RUNNING is outside the
      restatable set, so a restate either lands and is sent or matches nothing and
      reports zero, with no third outcome.
    - **What the accounting leg does NOT guarantee, stated rather than implied.** A
      restate can still arrive too late to land AT ALL. Once the worker has claimed
      the operation it is RUNNING, and once the invoice has been sent the anchor
      carries an active `SUPPLEMENTARY_INVOICE` link; a share settled after either
      point meets an ask that has left the building. The enqueue then refuses to
      queue a second invoice behind the first - correct, because two invoices for
      one edit is the failure this all exists to remove - so the invoice bills the
      earlier figure and the club collects the difference by hand. That is a
      recoverable shortfall rather than lost money only because it is RECORDED:
      `enqueueXeroSupplementaryInvoiceOperation` returns `outcome: "short"` and the
      settlement writes `booking.editFinancialReview.chargeShareUncollected` with
      leg `xero-invoice`. Closing the window itself would mean voiding and
      reissuing an invoice already with the member, which is a different decision
      from this one. Since #3187 the booking-vs-Xero repair tool finds that
      shortfall STRUCTURALLY as well as through the audit row: it reads the
      expected supplementary-invoice total from the settled review shares rather
      than from the `BookingModification` row (which a parked edit leaves at
      zero), so a missing invoice is queued for the settled total and one that
      went out short is reported as `XERO_AMOUNT_MISMATCH` for a person to
      correct.
    - **A durable retry closes the debt only when the ask EXISTS afterwards.** The
      recovery replay re-derives the total through the same sync the inline
      completion uses, and that sync reports which of four things happened
      (`nothing-owed`, `raised`, `already-paid`, `not-raised`) rather than a null
      intent id that meant three of them at once. On `not-raised` the replay leaves
      its operation open, so the existing back-off, retry and admin-alert machinery
      carries the debt. The mint it calls SWALLOWS a provider failure by design -
      the ordinary edit path has to return the member's saved change - and the row
      it re-enqueues is the row being replayed, whose upsert deliberately does not
      reset `status`; so a replay that closed unconditionally marked the operation
      SUCCEEDED having minted nothing.
    - **A recovered ask raises the accounting invoice the inline attempt
      deferred** (#3181). The inline settlement SKIPS the supplementary invoice
      while an additional Stripe payment is required and no intent exists yet -
      correctly, because there is nothing to invoice against - and defers to the
      intent's recovery replay. The replay only ATTACHED a recovered intent to an
      operation already WAITING_PAYMENT, and on exactly the edits that skipped
      there is no such operation, so the deferred invoice was never raised at all:
      the member had a collectable request and the club's accounts had no record
      of the charge. The replay now completes the deferral by re-entering the same
      settlement dispatcher with the intent set, on BOTH of its forks - an ordinary
      edit bills the `BookingModification`'s signed components, a review charge
      bills the combined total the sync re-derived. It queues no second invoice
      because it asks no second question: the anchor-scoped, advisory-locked
      decision above is the only one, which also makes the replay safe to run
      twice. A failure to queue is recorded and NOT retried, because by that point
      the replay has written this edit's `ADDITIONAL` transaction and the
      processor's own "a later edit superseded this one" check would read that row
      as a supersession - so a retry would complete having done nothing. The
      booking-vs-Xero repair pass classifies the resulting divergence and offers
      `QUEUE_SUPPLEMENTARY_INVOICE` built from the same two components. That
      argument binds EVERY `await` after that write, not only the enqueue call
      (#3181 fix round): the settlement module's dynamic import sits inside the
      catch, because a module that fails to load throws like a call that fails,
      and the read of the edit's signed components happens BEFORE the mint, where
      a transient database failure is still a real retry rather than a replay that
      supersedes itself.
    - **The replay bills the EDIT's answer to "was there an invoice to
      supplement", never the answer that is true when the cron arrives** (#3181
      fix round). These differ, and the difference double-bills. A booking whose
      primary Xero invoice had not been minted when the edit committed has nothing
      to supplement, so the edit correctly queues nothing - and the primary
      invoice, minted later by its own outbox operation from the booking's CURRENT
      state, then bills the edit itself. A replay re-reading `payment.xeroInvoiceId`
      hours later finds it set and raises a supplementary invoice for money the
      primary invoice already carries: on a $500 booking with a $50 guest add, $600
      of Xero income and a $50 receivable nobody owes, and only because the mint
      failed. So the edit-time value is frozen on the recovery row
      (`PaymentRecoveryOperation.hadIssuedXeroInvoice`) and read back; NULL means
      "not recorded" and raises nothing, because a missing invoice is surfaced by
      the repair pass as a critical one-click finding and a duplicate one is
      surfaced by nobody.
    - **A replay raises no invoice against an ask that was already paid** (#3181
      fix round). Its webhook has fired and cannot fire again, so a supplementary
      invoice queued WAITING_PAYMENT on that intent is never released and is
      cancelled by the 14-day reaper with no invoice raised. While it sits there it
      makes the operator's signal WORSE: the repair pass reads the anchor as
      `BLOCKED_BY_XERO_OPERATION` - warning, not auto-appliable, no action, reported
      as waiting for a payment that has already happened - instead of the critical,
      one-click `MISSING_SUPPLEMENTARY_INVOICE`.
    - **The review fork's failure to raise leaves its own durable record** (#3181
      fix round), rather than relying on the repair pass the ordinary fork relies
      on. A parked edit's `BookingModification` carries only the readable strands'
      money, so an edit whose only money-affecting strand was the parked one has
      `priceDiffCents + changeFeeCents == 0` and the pass's `netAmountCents > 0`
      gate never looks at it. It writes `booking.editFinancialReview.
      chargeShareUncollected` on the `xero-invoice` leg with cause
      `ask-not-raised` - distinct from `ask-closed`, which is an invoice that
      exists and bills too little, and from `ask-owed-unknown`, which is a
      recovery row predating `hadIssuedXeroInvoice` and therefore a case where
      the club cannot tell whether an invoice was owed at all. The three carry
      DIFFERENT officer instructions and that is why they are three: telling an
      officer to raise an invoice by hand when the booking's primary invoice may
      already bill the charge is how the same money gets asked for twice, so
      `ask-owed-unknown` names the booking-vs-Xero repair pass as the instrument
      and says not to raise one on the strength of the note.
    - **Every path that settles a share without producing a request leaves a
      durable trace.** A `logger.warn` is not one: nobody goes looking through a
      log stream for money the club is owed. The mint refusing before its own `try`
      writes the recovery row, and BOTH already-closed races - the card request
      already paid, and the Xero invoice already gone - write an audit row
      (`booking.editFinancialReview.chargeShareUncollected`, category `payment`,
      with a `leg` of `payment-request` or `xero-invoice` in its metadata and its
      prose)
      naming the shortfall, so an officer can find what has to be collected by
      hand.
  - **The card route is capped before it claims, and keyed to the TASK.** The cap
    is measured off the booking's captured `PaymentTransaction` rows, not off
    `Payment.source` - that column DEFAULTS to `STRIPE`, so routing on it alone
    sends a hand-settled booking with nothing captured down the card path. Both
    the cap and the frozen per-transaction allocation are answered before the
    claim, because `refundPaymentTransactions` refuses after the commit, where a
    refusal leaves a permanently COMPLETED task with nothing moved. The Stripe
    idempotency key prefix and the recovery operation are keyed to the TASK rather
    than to the `BookingModification`: owner decision D-3032-1 settles a review
    against the ORIGINAL edit's modification row, and one edit can raise TWO
    review tasks, so a modification-scoped key would let two same-amount refunds
    share one Stripe key (the second answered with the first refund, taken as
    success) and let two tasks upsert one recovery row, whose update branch
    overwrites `amountCents` and `stripeKeyPrefix`.
  - **The refund debt is persisted inside the completion transaction, before any
    provider call** - booking-cancel's #1349 arrangement, on the same
    infrastructure. Because this path holds no advisory lock, its claim commits
    before Stripe is called; without a durable row a crash in that window would
    leave a COMPLETED task, an untouched `refundedAmountCents` and no trace at all
    that money was owed, since this route writes no allocation of its own. The
    cron replays the frozen slices under the stored task-scoped prefix, so Stripe
    answers a repeat with the original refund and the ledger dedupes on refund id.
  - **`applyLocalRefundAllocation` compare-and-sets** on the `refundedAmountCents`
    it read (#3032). It writes an ABSOLUTE value computed in JavaScript, so two
    writers on one `PaymentTransaction` silently lose an update and OVERSTATE the
    refundable headroom. That was unreachable before this child - every caller
    either held `lock(1)` or ran only on a cancelled booking - and a review
    completion is neither: it allocates against a LIVE booking with no lock, while
    a consent-authority removal is exempt from the fence and does move money. The
    guard refuses loudly instead, and the completion turns that into a 409 with
    its transaction rolled back and its task still OPEN.
  - **The settlement anchor is the ORIGINAL edit's `BookingModification`** (owner
    decision D-3032-1), carried on `reviewContext.bookingModificationId` and
    deliberately NOT part of the occurrence identity: it points at a row rather
    than describing which edit happened, so including it would re-identify every
    replay. `MemberCredit.sourceBookingModificationId` is unique, so an anchor
    that already carries a credit is refused with a typed 409 rather than reaching
    an untyped throw inside the credit writer. ANY pre-existing credit is refused,
    including one whose amount matches: a matching amount is indistinguishable
    from a coincidence, and treating it as a replay would close the task having
    moved nothing. (A genuine replay cannot reach that code: the credit write is
    in the same transaction as the claim, so a second completion is refused by the
    status check first.) The refusal tells the operator to settle the amount
    another way and dismiss with a note - which is an honest terminal state under
    the DISMISSED definition above, because the note carries what happened and
    nothing in the row claims this system moved money.
  - **While a review is OPEN, a second money-affecting edit to that booking is
    refused** (#3032, `assertNoPendingEditFinancialReview`), because pricing one
    would mean starting from the amount under review. **All FOUR money-affecting
    doors are fenced**: the batch edit, the date edit, the single-guest removal,
    and `POST /api/bookings/[id]/guests`, which reprices inline in the route
    rather than through a service and was therefore missed on the first pass —
    it revalues an unreadable strand at today's rate and writes the new
    `finalPriceCents` back, so a later completion credits the member against a
    total the same money had already been taken out of. Each is called inside the
    transaction, after the locks and the post-lock re-read, below authorisation
    and before any write, and each surfaces the 409 with its `code` above its
    handler's generic `ApiError` branch. Identity-only edits, credit elections,
    the price-preserving admin date shift and consent-authority removals (owner
    decision D-14) are not fenced.
  - **Three database constraints, because prose is not enforcement** (migration
    `20260903010000`). An `EDIT_FINANCIAL_REVIEW` row must carry its
    `occurrenceKey` (`ManualRefundTask_edit_review_occurrence_key_present`) -
    PostgreSQL exempts NULL from a unique index, so a row without one would
    silently opt out of the duplicate fence. Every OTHER kind must carry an
    amount (`ManualRefundTask_non_edit_review_amount_present`) - those amounts
    came from cancellation or capture policy and an operator does not get to
    reprice them, which the stale-screen guard can only enforce on a row that has
    an amount to compare against. And a non-null `raisedAmountCents` requires a
    non-null `amountCents` (`ManualRefundTask_raised_amount_requires_amount`) -
    "raised with a figure that has since become unknown" is not a state. The
    schema's other claim about that column, that it is never amended, is a
    property of an UPDATE rather than of a row and is NOT enforced by the
    database; it holds because the column has one writer and every completion
    audits the previous and raised figures.
  - **An OPEN review can block reversal of a manual settlement**, and that is
    accepted as correct (owner decision D-3032-2). It falls out of `INV-PAY-045`
    rather than being new behaviour - but raising this kind changes which
    payments satisfy that condition, so it is stated here rather than shipped
    quietly. MEASURED SCOPE, which is narrower than the decision assumed: that
    guard reads `{ paymentId, status: OPEN }`, so it is scoped to the PAYMENT and
    not to the booking. A review raised against a captured payment blocks a
    reversal of that payment's manual settlement; the ordinary credit-only review
    (`paymentId` NULL) blocks nothing.
  - **What #3030 enforces versus what #3032 wires, and where the raise is called
    from.** #3030 ships the state, the single occurrence-key mint, the raise, the
    DB constraints and the audited completion. #3032 adds the settlement routing,
    the anchor, the Xero leg, the pending-review fence — and ONE production raise
    caller: `removeBookingGuestInTransaction`, where an unpriceable single-guest
    removal now commits structurally and parks its money (`INV-MOD-028`). The
    in-progress batch edit does NOT yet raise; it still refuses, for the structural
    reason stated in `INV-MOD-028`. So a live club can now hold rows of this kind,
    and they arrive from exactly one door.
  - **One task per parked STRAND, and the DEPARTING strand is always one of
    them.** The occurrence key is minted per strand, so per strand is what
    "exactly one" can mean idempotently: a replay of the same edit re-derives the
    same keys and creates nothing. A remaining strand is recorded when its own
    rows cannot be read; it carries no surrendered nights, and its honest
    resolution is often DISMISSED with a note, which is a defined state above and
    claims no payment. **The strand actually leaving is recorded on every parked
    removal, whether or not its own rows read cleanly** (#3032) — because nothing
    settles on a parked removal and the delete destroys the guest's night rows,
    so a departing strand that was skipped for being exact left its refund as a
    figure no longer present anywhere in the database, behind a task about
    somebody else that correctly read as "nothing to adjust". Where that strand's
    rows ARE exact its cause is `COUNTERPART_STRAND_UNREADABLE`, its stored
    evidence carries the real per-night prices, and no `amountCents` is written:
    the money that goes back also depends on the cancellation tier and the promo
    recalculation a parked removal skips, so the gross stored figure is evidence
    for the admin rather than a settlement the system may assert. **The rule:
    a parked edit never destroys a number the system could have known.**
