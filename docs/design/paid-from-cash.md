# Paid From Cash — Blueprint

**Status:** Blocked at the approved Step 2 stop gate after three source reviews
of `4b473559bab60fa052c85ec8f5133c121cf414b2` on 19 November 2026. The inherited
Stage 1 implementation bypasses required evidence checks for organiser-paid
children; §6 records the failure and recommended correction. The earlier
superseded-capture and organiser-dispute fixes are now present, but their
presence is not execution evidence. The inventory remains incomplete. This
blueprint belongs to #4069 (programme #4898), coordinated with M11 (#4523)
and M15 (#4527). The intended first PR contains the blueprint and Stage 1 only.

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

The reader uses Net Collected's cash half for the booking's one payment,
`getNetCollectedCashParts(payment).heldCashCents`, and additionally accounts for
live superseded-cancel ownership before the refund row exists. The current
implementation reads that ownership through `readSupersededCaptureOwnership`
and sizes it through `supersededCaptureHeldBack`. It subtracts only the portion
not already attributed to open card-refund slices by
`cardRefundSlicesByOperation` / `unsentSliceCents`. Preserve these canonical
helpers and count each obligation once. The deduction order is:

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
This is notification evidence only. It must not size a payment instrument,
change settlement eligibility, or collect a historical residual (`INV-PAY-047`).

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

- A superseded capture never covers the booking between its capture commit
  and creation of its refund row. The live cancel owns that money for return
  (`INV-PAY-043`, `INV-PAY-150`). Current code reads this ownership; the
  real-writer barrier test still requires recorded execution evidence.
- A group share proof does not prove the child's refund history. The group's
  legitimate absence of child capture rows exempts it only from ordinary
  row-to-mirror reconciliation, not from the unknown-evidence rules. The
  current implementation violates this boundary; see §6.1.
- A bank receipt recorded from cash is taken at the cash Xero showed.

## 3. Inventory

Every place in the app that decides "paid" or "settled" from a booking's
status, sorted by what kind of decision it is and when it moves.

The inherited inventory was based on `main` at `d44721e3b` and the lexical
counts in #4069 §5 (255 occurrences in 128 files). It is **not yet the required
complete semantic inventory**: grouped rows and false-positive counts still
need expansion. The 19 November review checked the inherited branch at
`658f94c13fdcd7642dd28ea3c38f73963d695a9e`, whose local `main` is
`da2c858ec`. Verified additions below do not certify unexamined sites. "Stage" names the PR that moves it
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
  invokes `deriveBookingCashCover` and agrees with Net Collected only when no
  extra superseded ownership applies (otherwise §6.6 is the expected difference); a mutation probe for each
  input (pending face amount, status-only paid, omitted refund, omitted
  credit, organiser money counted twice); every copy variant rendered, the
  unknown one with no amount and no "paid"; reads proven to go through the
  snapshot's client only; and an import guard keeping the reader off the
  ledger balance and the owed reader.
- **Rollback:** no schema change; each stage reverts alone.

## 6. Stop-gate review and remaining work

The branch is not ready to ship. Three independent read-only lenses reviewed
`4b473559bab60fa052c85ec8f5133c121cf414b2` on 19 November 2026:
money/attribution; concurrency/snapshot; and tests/UX/docs/`INV-SSOT`. Each
checked current source rather than adopting the inherited reports. No tests
were run by those reviewers. No production data or live provider was used.

### 6.1 Current blocker: group children skip unknown-evidence checks

A proved group share can still have unprovable refund history. In
`deriveBookingCashCover`, the organiser-child branch returns
`deriveGroupChildCover(snapshot)` before `paymentEvidenceProblem` runs.
`planGroupChildLines` proves that child shares reconcile with the settlement;
it does not validate every child's refund total or transaction provenance.

A concrete counterexample follows the existing pure test's two-child fixture:

| Input | Value |
| --- | --- |
| Booking | live `PAID` child, organiser-settled, non-null parent, price 0 |
| Child payment | Stripe, `SUCCEEDED`, captured share 4,500 cents, refunded 6,000 cents |
| Group settlement | Stripe, `SUCCEEDED`, 9,000 cents |
| Siblings | two captured shares of 4,500 cents, including this child |
| Credit, disputes, open obligations | none |

The share planner accepts the 9,000-cent sum. Net Collected clamps the child's
remaining cash to zero. Worth is zero, so `owedNetOfHeldCash` is zero and the
reader returns `covered`. The approved contract and `INV-PAY-159` require
`unknown` for unproven refunds. This is an invalid-history input the reader
must reject, not a claim that a current writer creates it. No historical data
repair is authorised or needed to reject it.

The same early return skips `LEGACY_BACKFILL_REASONS` checks on any transaction
rows that a child does have. A reconciled share does not make a backfilled row
cash evidence. Existing ordinary-booking unknown tests do not exercise these
inputs through the group branch.

**Recommended correction:** separate provenance and refund-validity checks
from ordinary transaction-to-payment reconciliation. Apply provenance checks
to any rows present, and reject refunds exceeding the proved child share,
before returning group cover. Keep the intentional exemption for a legitimate
organiser-paid child with no capture rows: the real group settlement writes
its mirror without them. Reuse `LEGACY_BACKFILL_REASONS`, `captureRefundState`
and `planGroupChildLines`; do not introduce a second money reader or infer
parent cash. If the evidence cannot prove a share or refund, answer `unknown`.

The correction belongs in `src/lib/booking-cash-evidence.ts`, with pure cases
in `src/lib/__tests__/booking-cash-evidence.test.ts` and composed group-writer
coverage in `src/lib/__tests__/booking-cash-evidence.realdb.test.ts`. Include:
a valid no-row child remains covered; a legacy row is unknown; a refund above
its share is unknown even at zero price; and a valid attributed child refund
remains covered at the reduced price. Invalid-history fixture inputs must be
labelled as such, not presented as real-writer outputs.

This is the approved Step 2 invariant-conflict stop condition. The review
identified a reader correction, not a writer, schema, provider or history
change. Record and review the corrected contract before resuming product
work. This documentation does not approve the inherited implementation.

### 6.2 Earlier findings: current disposition

The earlier review found real gaps, but several claims in the inherited
blueprint no longer described the checked head. Source inspection establishes
the following; it does not certify that the tests pass.

| Earlier finding | Current source | Remaining evidence |
| --- | --- | --- |
| Superseded capture counted before refund enqueue | `supersededCancelOwnedCents` reads cancel ownership and subtracts only the part not already attributed to open card refunds | Run the real hand-off barrier and overlap cases |
| Organiser capture dispute omitted | `readBookingCashCover` reads `disputedCaptureCents` for the combined settlement intent in the same transaction | Run the group settlement/dispute regression |
| Realdb suite absent | `booking-cash-evidence.realdb.test.ts` exists with real-writer cases and capture/refund/credit/group snapshot scenarios | Record CI execution, with no skipped cases |
| Parity test only rechecks Net Collected | Pure parity case now calls `deriveBookingCashCover` | Run the named file and required mutations |
| Cash-cover invariant absent | `INV-PAY-159` exists and is indexed; `INV-PAY-119` distinguishes the unchanged pay-step reader | Correct the group evidence violation in §6.1 |
| State-machine and email docs absent | State machine, email and booking-request docs now describe the cash reader | Recheck them against the final corrected contract |
| Tracked narrow tsconfig | `tsconfig.narrow.tmp.json` is absent | No further removal needed |

Neither money nor concurrency review found another confirmed defect in the
current per-transaction superseded-cancel overlap calculation. That conclusion
is bounded source-review evidence, not a substitute for the required tests.

### 6.3 Snapshot and capacity evidence

Booking fields, capacity inputs, cash, applied credit, disputes, organiser
shares and superseded ownership all flow through the same transaction client
inside `withReadOnlySnapshot`. The email sends after that snapshot closes.
No transaction-client escape survived the concurrency review.

The realdb suite checks cash-cover answers across actual capture, refund,
credit and group writes. The approval harness runs the real approval engine,
bank-switch route, exclusive-hold route, reader and sender over a simulated
transaction. It asserts the paired amount and held-bed copy, but it does not
execute the complete email path against PostgreSQL. Preserve that distinction
when reporting validation; source presence alone proves neither suite passed.

The inherited capacity implementation intentionally uses
`bookingHoldsCapacity` without a standalone `|| wholeLodgeHold`: the
exclusive-hold route requires capacity already held, while the flag can remain
after an admin capacity hold is released. The stale-flag regression exists in
`booking-exception-approved-interleaving.test.ts`. This differs from the
approved literal expression and must be included in final plan reconciliation.

### 6.4 Remaining deliverables

Step 1 is incomplete. Expand §3 to one row per semantic decision and false
positive on the reviewed base, replacing grouped helpers and the approximate
130-site description. Until that inventory is complete, §4's 17 stages are a
provisional count: one first PR and 16 later display-surface PRs, plus separately
planned gated work or M15 cohorts. Do not claim an exact programme PR count.

After the stop gate is resolved, Stage 1 still needs:

- The §6.1 reader correction and its pure and realdb regressions, followed by
  money review of the correction.
- Actual sender/template evidence for all five payment-note variants. The
  organiser-pays case currently calls only the note helper, and the render
  fixture pins a placeholder payment note. Exercise organiser-pays through the
  sender and pin actual variants in the email render fixtures.
- Execution of the five mutation probes, each seen to fail and then restored:
  pending face amount as cash; status-only paid; omitted refund; omitted
  credit; organiser money counted twice.
- Named test-file validation and a narrowed typecheck under the pinned
  runtime; CI owns realdb and full gates. This review did not run product tests.
- A final self-review and PR body recording each lens finding, its disposition,
  validation run and not run, and the remaining stated limits. The existing
  changelog fragment is part of the inherited implementation, not proof of
  completion.

Later programme work remains every surface in §4 after Stage 1, plus the
eligibility, replay and writer cohorts in §3. They require their own plans or
M15, never both. No ledger reader cut-over precedes the owner's
`INV-MONEY-037` whole-history proof.

### 6.5 Handoff and tool limits

This run changes the blueprint only and stops under approved Step 2. It does
not rewrite the inherited branch history or remove its product changes. The
branch therefore still contains incomplete Stage 1 code and must stay out of
release until the blocker and required evidence are resolved.

The repository's issue-thread reader could not retrieve #4069 because GitHub
CLI is unauthenticated. No credentials were sought. The approved plan supplied
in this session is the task authority; source review is not represented as a
fresh reading of the issue thread or its saved harness comment.

`revise_plan` and `attach_file` are unavailable in this tool session. This
section records the stop and plan deviation durably, but is neither a posted
issue comment nor an attachment. The lane must still deliver
`blueprint-issue-comment.md` with the completed blueprint and final stage list,
and post it before readiness. The requested #4523 coordination text is:

> M11 (#4523) extends `readBookingCashCover` in
> `src/lib/booking-cash-evidence.ts`; it never adds a second paid/balance reader.
