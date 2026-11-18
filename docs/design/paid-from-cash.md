# Paid From Cash — Blueprint

**Status:** Blocked at the approved blueprint stop gate, reviewed 18 November
2026. The inherited branch contains an incomplete Stage 1 implementation; it
is not ready to ship. The review found that the proposed treatment of a
superseded capture contradicts the approved refund rule. See §6 for evidence,
the recommended correction and the work still required. This blueprint belongs
to programme #4069 (part of #4898), coordinated with ledger M11 (#4523) and
M15 (#4527). The intended first PR contains the blueprint and Stage 1 only.

**Audience:** developer, agent. Index: [`docs/README.md`](../README.md) ·
[member money ledger design §9](member-money-ledger.md#9-bug-scenario-acceptance-matrix).

## 1. The problem

A booking's status describes where it is in its lifecycle: whether it holds
beds, whether an invoice is due, what the member may do next. Many readers use
it as a stand-in for "the money is in". It is not one. `CONFIRMED` means the
beds are held; since #2263 and the bed-holding bank switch it can owe a whole
bank transfer. `PAID` with a `PARTIALLY_REFUNDED` payment can be fully covered
at a lower price. A status cannot say either.

Owner decisions on #4069:

- **15 Oct 2026:** decide "paid" from the cash actually received, in every
  case; a blueprint and review come before any build.
- **16 Oct 2026:** (1) a full rebuild of every paid or settled decision, as
  its own programme, keeping display decisions apart from financial writers;
  (2) refunds owed but not yet paid count as gone; (3) where history cannot
  prove the amount, say so neutrally — no amount, no "paid".
- The `INV-MONEY-037` whole-history proof stays an owner operation before any
  ledger reader moves.

## 2. The one reader

One function answers "is this booking covered by money the club actually
holds?", and every moved decision asks it.

`src/lib/booking-cash-evidence.ts` is that one home. M11 (#4523) extends it,
switching its inputs to journal projections once the `INV-MONEY-037` gate
opens; it never adds a second paid or balance reader.

- `deriveBookingCashCover(snapshot)` — pure. All amounts integer cents.
- `readBookingCashCover(tx, bookingId)` — loads that snapshot through the
  caller's transaction client, and only through it (no default client). A
  caller wanting one coherent answer runs it, and any other fact it needs,
  inside one `withReadOnlySnapshot`.

It writes nothing, takes no lock, calls no provider, and imports neither
`booking-ledger-balance.ts` nor `readBookingAmountOwed`.

### 2.1 Answers

| Answer | Meaning | A surface may |
| --- | --- | --- |
| `covered` | Cash still held plus applied credit reaches the booking's worth | say nothing is owed |
| `owes { cents }` | Worth less held cash less applied credit, above zero | quote that amount |
| `organiser_pays` | A group child whose organiser pays, or owes the rest | say the organiser pays; never ask the member |
| `unknown { reason }` | The records cannot prove the figure | use neutral wording only |

`unknown` never becomes paid, unpaid, zero due or a personal demand.

### 2.2 Owed side

`bookingAmountOwedCents`: worth (`bookingWorthCents` — `finalPriceCents` plus
the change fee recorded on the payment) less applied credit, read once
(`deriveBookingAppliedCreditCents`). The same figure `INV-PAY-119` reads;
`readBookingAmountOwed` itself is not called and not changed.

### 2.3 Paid side

Held cash is Net Collected's cash half for the booking's one payment,
`getNetCollectedCashParts(payment).heldCashCents`, not a second derivation of
it. In its order, each step capped at what the one before left:

1. what the payment took (`netCollectedPaymentTookMoney`) less its recorded
   refunds — card refunds, credit to account and completed hand-backs alike;
2. less open hand-backs (`openTaskOwedCents`), never a group organiser's
   (`isGroupOrganiserHandBackTask`, `INV-PAY-124`);
3. less card refunds started and not yet paid, failed or owed — a
   superseded capture's refund among them (`openCardRefundOwedCents`);
4. less late captures awaiting the treasurer.

That rule reads the payment mirror. This reader adds the evidence that makes
the mirror cash: the payment's captured `PaymentTransaction` rows
(`grossCapturedCents`) must equal `Payment.amountCents`, and their refunds its
`refundedAmountCents`, or the answer is `unknown` (§2.6). A `PENDING` or
`PROCESSING` face amount is never captured, so it never counts.

`owes = bookingAmountOwedCents − held`; at or below zero is `covered`.

### 2.4 Counted once

An obligation counts while open and drops out in the same snapshot its paid
form lands:

- A hand-back counts only while its task is `OPEN`. Completing it moves
  `refundedAmountCents` in the same commit, so the completed task is seen only
  there.
- A card refund operation is netted against the refunds already recorded for
  it (`openCardRefundOwedCents`). A recorded refund Stripe refused
  (`isRefusedRefundStatus`) is not netted, so it stays owed.
- A refund Stripe fails later is taken off the row's refunds and owed again
  by its own row, once.

### 2.5 Group children

Only a booking with `organiserSettled` and a parent takes this path; a child
switched to paying for itself is an ordinary booking.

- **Organiser has not paid** (`organiserPaysForNewJoiner` on the child's
  group): `organiser_pays`.
- **Organiser paid** (`paidByOrganiser`, a paid settlement): the share is
  proved by `planGroupChildLines`, the planner the ledger back-post and census
  share. Then the child's own mirror is its cash (the settle writes no rows
  for it), through §2.3. Covered gives `covered`. A shortfall on a child the
  organiser paid by bank transfer is invoiced to the organiser
  (`organiser-extra-invoice-queue.ts`), so it gives `organiser_pays`; any
  other shortfall gives `unknown`.
- Shares that do not add up, a payment the settlement did not take, or no
  settlement give `unknown`.
- The parent's cash is never counted for a child, and a child's share never
  for the parent.

### 2.6 Unknown

- The booking is not live (not in `ACTIVE_BOOKING_STATUSES` or `COMPLETED`,
  or deleted): a cancelled booking's money is the cancellation's question.
- A row's `reason` is in `LEGACY_BACKFILL_REASONS`: seeded from columns, not
  from a capture.
- A captured bank-transfer receipt holds the figure the payment was born with,
  not cash read from Xero (`isStoredFigureBankReceipt`: settled before #3979,
  or kept by the settle). Owner decision 3 names older bank receipts.
- The payment took money by its mirror, but its captured rows do not sum to
  `Payment.amountCents` (none at all included), or their refunds do not sum to
  `Payment.refundedAmountCents` (a Xero note written to the column alone).
- A row's refunds exceed its capture, or a `REFUNDED` row records less than it
  took (`captureRefundState`).
- An open or lost dispute holds any of its captures
  (`paymentDisputedCaptureCents`, `INV-PAY-154`).
- An organiser child whose share cannot be proved (§2.5).

A `$0` `SUCCEEDED` payment (a credit-covered or zero-priced booking) took no
money and needs no rows; it reads `covered` through §2.2.

### 2.7 Limits

- **Rejected by the stop-gate review:** counting a superseded capture between
  its capture commit and creation of its refund row. The live cancel already
  owns that money for return (`INV-PAY-043`, `INV-PAY-150`). The reader must
  account for that ownership, even if the process stops in the gap. Reusing
  Net Collected alone is insufficient; §6 describes the required correction.
- A bank receipt recorded from cash is taken at the cash Xero showed.

## 3. Inventory

Every place in the app that decides "paid" or "settled" from a booking's
status, sorted by what kind of decision it is and when it moves.

A semantic sweep of production code on `main` (d44721e3b), from the lexical
counts in #4069 §5 (255 occurrences in 128 files). Each row is one decision
site, or one function's group of lines. "Stage" names the PR that moves it
(§4); "own plan" needs its own plan in #4069 before code; "M15" moves with
#4527's refund, cancel and ask cohort; "no move" is a lifecycle decision that
reads the status correctly.

### 3.1 Display, notification, report

| Site | Decides | Stage |
| --- | --- | --- |
| `booking-exception-approval.ts` `notifyApproved` | approval email's amount owed | 1 |
| `booking-narrative.ts` (`PAID`/`COMPLETED` → paid narrative) | booking page and public pay link "money arrived" | 2 |
| `bookings/[id]/_lib/booking-detail-payment.ts`, `booking-payment-cards.tsx` (`isBookingOwnAmountOwed`) | whether the pay card and breakdown show | 3 |
| `member-dashboard.ts`, `dashboard/page.tsx` (`PAYMENT_OWED_BOOKING_STATUSES`) | dashboard Payment Owed card | 4 |
| `booking-fresh-email-copy.ts` (`paymentDue`) | confirmation email's due or processed line | 5 |
| `payment-status-display.ts` `getPaymentDisplayStatus` | "Paid" label on the booking and payments pages | 6 |
| `organiser-group-booking-card.tsx` (`settledAlready`, `unsettledJoiners`) | organiser's paid and outstanding figures | 7 |
| `pre-arrival-reminder-email.ts` | reminder's outstanding extra | 8 |
| `additional-payment-chase.ts` `isAdditionalPaymentOwed` display callers (panel, reports) | "extra still owed" | 9 |
| `duplicate-capture-kept-alert-drain.ts` | alert text "closed" by status | 10 |
| `finance-booking-metrics.ts` (`FINANCE_FORWARD_COMMITTED_BOOKING_STATUSES`) | committed and at-risk revenue | 11 |
| `unpaid-finished-stays.ts` (status `where`) | officer collection queue and badge | 12 |
| `group-late-joiner.ts` (join page's who-pays line) | joiner told who pays | 13 |
| `bookings/[id]/_lib/booking-detail-messages.ts` | whole-lodge unpaid wording | 14 |
| `book/_hooks/use-booking-wizard.ts` (`isPaymentOwedBookingStatus`) | wizard sends member to pay | 15 |
| `booking-history.ts` "Payment recorded" fallback | history item | 16 |
| `admin-reports.ts`, `admin/reports/route.ts`, `report-charts.tsx` | status breakdown counts | no move: a lifecycle census, labelled as such |
| `status-colors.ts` `bookingStatusLabel` | "Paid" and "Confirmed (Unpaid)" labels say paid or unpaid from status | 17 |
| `booking-status-banners.tsx` `stayConfirmed` | stay confirmed banner | no move: lifecycle |

### 3.2 Eligibility

| Site | Decides | Stage |
| --- | --- | --- |
| `late-notice-change-fee.ts` `lateNoticeChangeFeeApplies` | a fee applies | own plan (writer input) |
| `booking-modify-credit-give-back.ts` `isPaid` | give credit back or lower what is owed | M15 |
| `booking-guest-acceptance-reprice.ts` `priceSettled`; `booking-guest-acceptance-return-route.ts` | a raise is skipped; refund route | M15 |
| `booking-modify-validation.ts` `isBookingFullyPaidForGuestNameEdits` | name edits allowed | own plan |
| `manual-booking-payment-state.ts`, `payment-reconciliation.ts` (mark-paid and reverse) | officer may mark paid or reverse | own plan |
| `admin/xero/force-sync/route.ts`, `admin/bookings/search/route.ts` | only paid bookings sync | own plan |
| `booking-detail-payment.ts` `isSwitchableToInternetBanking`, `switch-to-internet-banking/route.ts` | bank switch allowed | own plan |
| `payment-link.ts`, `payment-link-intent.ts`, `payment-link-reissue.ts` | link payable | own plan |
| `create-payment-intent/route.ts` (payable statuses) | card intent allowed | own plan |
| `organiser-child-refund.ts`, `group-cancel.ts`, `group-settlement.ts` guards | child refund and settle | M15 |
| `booking-modify-settlement*.ts`, `booking-payment-state.ts` helpers that AND status with captured cash | — | no move: already cash-gated |
| `(authenticated)/layout.tsx`, `dashboard/page.tsx` "staying now" (`PAID` only) | who sees door codes in-stay | own plan |
| `booking-cancel-eligibility.ts`, `booking-edit-policy.ts` | cancel and edit lifecycle | no move: lifecycle |

### 3.3 Replay guard or paid assertion

| Site | Decides | Stage |
| --- | --- | --- |
| `xero-inbound/invoice-paid-effects.ts` (`alreadyPaid`, cleared-invoice alert) | skip the paid arm | own plan |
| `xero-inbound/settlement-conflicts.ts` | second-instrument marker | own plan |
| `stripe-webhook-service.ts` (`capturedOnSettledBooking`) | skip the owed-amount check | M15 |
| `payment-reconciliation.ts` (paid-like replay) | treat a capture as a replay | M15 |
| `confirm-payment/route.ts` | skip to the invoice queue | own plan |
| `payment-link-context.ts` (burn a used link) | mark the link used | own plan |
| `duplicate-capture-guard.ts` (`isPaidLikeBookingStatus`) | a second capture is a duplicate | own plan |
| `cron-confirm-pending.ts`, `charge-saved-method/route.ts`, `confirm-pending-guests/route.ts` fences | claim held or settled | no move: status-guarded claims |
| `internet-banking-payment-cron.ts` | hold still owed | no move: reads the payment row |

### 3.4 Unpaid-amount readers that size a payment instrument

`readBookingAmountOwed` (`INV-PAY-119`) and its callers are unchanged by this
programme: they size what the pay step asks, and an unpaid booking has no cash
to subtract. Their status gates are the display stages above (3 and 4); the
amount they quote is not. `create-payment-intent` and `payment-link-intent`
payable lists are eligibility (§3.2). The additional ask (`bookingOutstandingCents`)
stays with M15.

### 3.5 Financial writers

| Site | Decides | Stage |
| --- | --- | --- |
| `booking-modify-settlement.ts`, `booking-date-modification-service.ts` zero-dollar auto-pay | write `PAID` and a $0 payment | M15 |
| `booking-ledger-back-post.ts` `mustConfirm` | post confirmation lines | after `INV-MONEY-037`, own plan |
| `xero-booking-repair-classify.ts`, `booking-provider-mismatches.ts` | a primary invoice is expected | own plan |
| `group-settlement.ts` child flips | settle children | M15 |
| Status writers (`booking-create.ts`, `force-confirm`, `confirm-draft`, …) | write `PAID` with a payment | no move: writers of status, not readers |

### 3.6 Diagnostics and censuses

`booking-ledger-projection-census*.ts` and `finance-evidence.ts` read status
as the lifecycle the ledger must agree with. They stay: a census that read this
reader would be checking the mirror against itself. No move.

### 3.7 Not decisions about booking money

About 130 sites: subscription and membership `PAID`; roster, duty and
induction `CONFIRMED`/`COMPLETED`; guest consent, partner links and
nominations `CONFIRMED`; manual-refund and late-capture task `COMPLETED`; Xero
invoice and note `PAID`/`AUTHORISED`; webhook leases; capacity and stay
lifecycle lists; and the captured-transaction predicates that already compute
cash.

## 4. Stages

Harm first: what a member is told, then what an officer acts on.

1. **Exception-approved email** (this PR): the reader, and the email's amount
   and held-bed sentence from one snapshot. Beds are held exactly when
   `bookingHoldsCapacity` says so, read with all its inputs (status, the
   converted request, the admin capacity hold); a whole-lodge hold can be set only on a
   booking that already holds (the exclusive-hold route refuses otherwise), so
   `wholeLodgeHold` adds nothing, and a flag left behind when an admin
   capacity hold is released must not make the sentence claim beds are held.
   If the snapshot cannot be read, the email still goes, with the neutral
   line.
2. Booking narrative (booking page, public pay link).
3. Booking page pay card and breakdown gate.
4. Dashboard Payment Owed card.
5. Confirmation email's due line.
6. Payment status label.
7. Organiser group card.
8. Pre-arrival reminder.
9. Additional-owed display callers.
10. Duplicate-capture alert text.
11. Finance forward metrics.
12. Unpaid finished stays queue and badge.
13. Join page's who-pays line.
14. Whole-lodge unpaid wording.
15. Wizard's pay redirect.
16. Booking history fallback item.
17. Booking status labels.

Then the gated rows of §3.2, §3.3 and §3.5, each with its own plan in #4069
before code or as an M15 cohort, never both. Any stage that would read the
ledger balance waits for the owner's `INV-MONEY-037` evidence.

Each display stage reads `readBookingCashCover`, keeps its own copy and pins,
and reverts alone.

## 5. Contracts every stage keeps

- **Counterparts, validated not changed:** capture and reconciliation, the
  manual bank settle, additional and superseded captures, modification refunds
  and credit disposition, credit application and restore, organiser settlement
  and child refunds, hand-back and paid-another-way closes.
- **Concurrency:** the reader runs inside the caller's read-only
  `RepeatableRead` snapshot (`withReadOnlySnapshot`), so every fact it reads
  is from one moment. Most writers commit money and status together (the bank
  switch, card and manual settles, the Xero receipt, group settlement, credit
  application, hand-back completion). Three commit in order instead, and every
  moment between is coherent: a saved-card charge records the capture, then
  flips the booking to `PAID` (a snapshot between reads `CONFIRMED` and
  `covered`); a superseded capture's hand-off flips the charge, writes its
  refund row, then closes; a card refund is recorded, then its operation
  closes (netted to zero meanwhile). A stage that pairs status with cash must
  accept `CONFIRMED` with `covered`. No new lock; a notification sends after
  the snapshot closes.
- **Refund obligations:** §2.3 and §2.4.
- **Unknown history:** §2.6; neutral wording only.
- **Validation:** composed real-writer cases on PostgreSQL; the real routes
  where a race is claimed; boundaries (held exactly equal to worth, a refund
  equal to its capture, credit-only, a pending capture); a parity check that
  held cash is Net Collected's for the same payment; a mutation probe for each
  input (pending face amount, status-only paid, omitted refund, omitted
  credit, organiser money counted twice); every copy variant rendered, the
  unknown one with no amount and no "paid"; reads proven to go through the
  snapshot's client only; and an import guard keeping the reader off the
  ledger balance and the owed reader.
- **Rollback:** no schema change; each stage reverts alone.

## 6. Stop-gate review and remaining work

Three independent read-only reviews examined commit
`55ab4af60cb8341c5fb6d9bd0e23d67cacc87861` on 18 November 2026:
money/attribution; concurrency/snapshot; and tests/UX/docs/`INV-SSOT`.
They reviewed the inherited blueprint and implementation, not a completed
release. No production data or live provider was used. These findings have
not been fixed in product code. The approved Step 2 requires stopping when a
lens finds an invariant conflict; this revision records that stop rather than
accepting the former §2.7 exception.

### 6.1 Blocking conflict: superseded cash is not booking cover

A live booking worth 50,000 cents can have only a superseded capture of 50,000
cents. `handoffSucceededSupersededIntentToRefund` in
`src/lib/payment-recovery.ts` commits `markSupersededTransactionSucceeded`
and the payment aggregate before it calls
`enqueueSupersededPaymentRefundRecovery`. In between, the cancel operation
remains in flight. A process failure can leave this interval open.

`paymentEvidenceProblem` accepts the matching capture and payment aggregate.
`owedNetOfHeldCash` then reads `getNetCollectedCashParts`, whose
`netCollectedCardRefundSelect` selects only `CARD_REFUND_OPERATION_WHERE`.
That excludes `CANCEL_PAYMENT_INTENT`. With no refund row yet, the inherited
reader returns `covered` and the approval email omits the amount owed.
RepeatableRead cannot repair this: the database snapshot itself contains the
capture and its live cancel, but the reader ignores the cancel.

This conflicts with the approved rule that superseded captures awaiting refund
never cover a booking. `INV-PAY-043` states that money owned by the superseded
machinery is never settlement; `INV-PAY-150` describes the ownership during
this exact hand-off. Its existing
`readSupersededCaptureOwnership` / `supersededCaptureHeldBack` helpers provide
read-only evidence. No writer, schema, provider or history change has been
shown necessary.

**Recommended correction:** include that ownership in the same snapshot and
count the union of committed refund obligations once per capture. Do not
subtract the full superseded hold-back on top of Net Collected: both already
include refund operations and failed-later refund obligations. Prove the
additional, previously uncounted obligation; where attribution cannot be
proved, return `unknown`, never `covered`. The revised contract needs examples
for live cancel alone, cancel plus refund row, completed refund, and failed-later
refund. The same 25,000-cent obligation must come off exactly once in each
applicable state. Preserve the existing helpers as the sole ownership rules
(`INV-SSOT-001`). Review this correction before resuming Stage 1.

### 6.2 Money lens: organiser dispute evidence is missing

`group-settlement.ts` writes paid children's payment shares without the
organiser's combined PaymentIntent or child transaction rows. `matchCapture`
in `stripe-dispute.ts` associates a dispute on the combined intent with the
organiser booking. `readBookingCashCover` checks disputes using only the child
payment, although it also loads the settlement's PaymentIntent. A disputed
combined capture can therefore leave every child's answer `covered`.

Recommended correction: read `disputedCaptureCents` for the settlement intent
through the same snapshot and answer `unknown("disputed")` for a holding
dispute. Do not guess each child's disputed share. Add a real group-settlement
and dispute-writer regression. This is a defect in the proposed reader, not a
request to change the existing settlement writer.

### 6.3 Concurrency lens: correct client flow, incomplete proof

The inspected booking, credit, payment, dispute and group reads use the
transaction client; email delivery is after the snapshot closes. Those are
useful structural checks, not PostgreSQL evidence.

`booking-exception-approved-interleaving.test.ts` constructs its own snapshot
with `structuredClone`; its capture and credit changes use in-memory
assignments. It does not establish actual database isolation or real-writer
composition. The promised `booking-cash-evidence.realdb.test.ts` does not
exist at the reviewed commit. Capture, refund, credit application and group
settlement must each be exercised between actual reads, using the real writers.
The superseded hand-off also needs a barrier after its capture commit and
before its refund enqueue, proving the amount remains owed throughout.

### 6.4 Tests, UX, docs and single-source lens

The remaining work is concrete and stays within the approved Stage 1 scope:

- Expand §3 to one row per semantic decision and false positive. Grouped
  descriptions such as “about 130 sites” and wildcard helper rows are not the
  required complete inventory. The 17 stages in §4 currently propose 16
  subsequent display PRs; that count remains provisional until the inventory
  is complete. Gated stages still need their own plans or M15, never both.
- Add all approved real-writer cases in
  `booking-cash-evidence.realdb.test.ts`, including organiser share attribution,
  paid then reduced and refunded, pending additions, legacy evidence, and
  refund obligation/recorded-refund de-duplication. Fix the existing test
  headers that presently imply this file exists.
- Replace the cash parity test that only rechecks Net Collected with a test
  that actually invokes `deriveBookingCashCover`. Exercise all five email
  variants through the sender and render contract, not only the note helper.
- Run and restore the five required mutation probes: pending face amount as
  cash; status-only paid; omitted refund; omitted credit; organiser money
  counted twice. No execution evidence was available in this review.
- Define and index the intended cash-cover invariant. The inherited code
  cites a proposed PAY-157 entry that is not yet defined. Update `INV-PAY-119`
  to describe the approval reader move while preserving the owed reader's
  pay-step contract; it still names the old approval-email caller today.
- Complete the planned state-machine, email and booking-request documentation,
  template contract and render pin, changelog, and PR body with findings and
  verified fixes. Review the held-bed predicate deviation against the approved
  `bookingHoldsCapacity(...) || wholeLodgeHold` contract before accepting it.
- Remove the inherited tracked `tsconfig.narrow.tmp.json` throwaway once its
  validation role is finished. Run only the sandbox-permitted narrow checks;
  realdb and full gates belong to CI.

### 6.5 Handoff and plan status

This run changes documentation only and stops under approved Step 2. The
inherited implementation remains on the branch, with the defects above; it
must not be treated as merge-ready. No first-commit history was rewritten.
The whole issue remains incomplete: Step 1's exhaustive inventory and final
review, Steps 3–4's completed implementation and validation, and the later
surface/gated PRs are still required. The intended scope remains one first PR
for blueprint plus Stage 1, then the separate stages in §4.

The task's `revise_plan` and `attach_file` tools were unavailable in this run.
This section records the stop and deviation durably instead; it is not an
owner approval or a posted issue comment. Before readiness, the lane still
needs to post the reviewed blueprint and final stage list to #4069 and deliver
the requested attachment. The coordination note for #4523 remains:

> M11 (#4523) extends `readBookingCashCover` in
> `src/lib/booking-cash-evidence.ts`; it never adds a second paid/balance reader.
