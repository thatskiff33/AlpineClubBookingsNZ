# Paid From Cash — Blueprint

**Status:** Stage 1 is built: the reader and the exception-approved email.
The inventory is complete on `main` at `da2c858ec`
([inventory](paid-from-cash-inventory.md)). Three review lenses read this
blueprint and the build; §6 records what they found and what was done. This
blueprint belongs to #4069 (programme #4898), coordinated with M11 (#4523)
and M15 (#4527).

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
  group): `organiser_pays`. This proves who pays, not that money arrived, so
  it needs no frozen share — before the settle there is none. This applies
  only without a captured child mirror. A fully refunded settlement can
  already have paid a child; that child still goes through the share proof.
- **Organiser paid** (`paidByOrganiser`, a paid settlement): the share is
  proved by `planGroupChildLines`, the planner the ledger back-post and census
  share. A proved share does not prove the child's rows or refunds, so §2.6's
  row and refund rules apply next: a legacy row, a stored-figure bank receipt,
  or refunds above the share give `unknown`. Only row-to-mirror
  reconciliation is skipped, because the settle writes the child's mirror
  without capture rows. Then the child's own mirror is its cash, through
  §2.3. Covered gives `covered`. A shortfall on a child the organiser paid by
  bank transfer is invoiced to the organiser
  (`organiser-extra-invoice-queue.ts`), so it gives `organiser_pays`; any
  other shortfall gives `unknown`.
- No group, shares that do not add up, a payment the settlement did not
  take, or no settlement where the organiser is not still to pay (a group
  that is not organiser-pays included) give `unknown`.
- The parent's cash is never counted for a child, and a child's share never
  for the parent.

### 2.6 Unknown

- The booking is not a real stay, live or finished (not in
  `DUPLICATE_STAY_BOOKING_STATUSES`, the one home of that rule, or deleted): a
  cancelled booking's money is the cancellation's question.
- A row's `reason` is in `LEGACY_BACKFILL_REASONS`: seeded from columns, not
  from a capture.
- A captured bank-transfer receipt holds the figure the payment was born with,
  not cash read from Xero (`isStoredFigureBankReceipt`: settled before #3979,
  or kept by the settle). Owner decision 3 names older bank receipts.
- The payment took money by its mirror, but its captured rows do not sum to
  `Payment.amountCents` (none at all included), or their refunds do not sum to
  `Payment.refundedAmountCents` (a Xero note written to the column alone).
- A refunded `Payment.status` on a payment that is not a card's, with an
  amount and no captured row. A credit note folded into a never-paid bank
  transfer and cash taken before the ledger leave the same mirror
  (`stripeRefundMirrorShowsCapture`), so it never reads as owing its whole
  worth.
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
  (`INV-PAY-043`, `INV-PAY-150`).
- A superseded capture behind a dead cancel with no refund row is handed to
  nobody: the club holds it, so it counts as cash, as the Xero reading counts
  it (`superseded-intent-ownership.ts`). Skipping it would hide a booking
  paid twice.
- A group share proof does not prove the child's refund history. The group's
  legitimate absence of child capture rows exempts it only from ordinary
  row-to-mirror reconciliation, not from the unknown-evidence rules (§2.5).
- A bank receipt recorded from cash is taken at the cash Xero showed.

## 3. Inventory

[`paid-from-cash-inventory.md`](paid-from-cash-inventory.md) lists every place
in the app that reads a booking's status where "paid" or "settled" could be
meant: 317 rows over 245 files on `main` at `da2c858ec`, one row per
decision, with how the list was built and what it cannot see.

| Class | Rows | A display stage | Own plan | M15 | No move |
| --- | --- | --- | --- | --- | --- |
| Display, notification, report | 50 | 41 | 1 | 3 | 5 |
| Eligibility | 58 | 0 | 36 | 10 | 12 |
| Replay guard or paid assertion | 17 | 0 | 6 | 3 | 8 |
| Unpaid-amount reader sizing a payment instrument | 17 | 0 | 0 | 3 | 14 |
| Financial writer | 26 | 0 | 3 | 12 | 11 |
| Diagnostic or census | 7 | 0 | 3 | 0 | 4 |
| Lifecycle read: the status used as a status | 43 | — | — | — | 43 |
| Another domain's status: subscription, roster, consent, refund task, Xero | 99 | — | — | — | 99 |

"Stage" names the PR that moves a row (§4.1). "Own plan" needs its own plan in
#4069 before code. "M15" moves with #4527's refund, cancel and ask cohort.
"No move" stays, for the reason its row gives: the status is read as a
lifecycle fact, the decision already checks captured cash or an issued
invoice, or the writer commits the status with its money.

What the full inventory changed from the first grouped draft:

- **One more display surface** (stage 18): an officer's view of a member
  totals "spend" from the prices of `PAID` and `COMPLETED` bookings.
- **Who counts as staying** is read from `PAID` and `COMPLETED` alone in 15
  places — lodge guest lists, the roster, check-in reminders, occupancy,
  "staying now" tools, and the check that blocks deleting an account with a
  future stay. A held, unpaid `CONFIRMED` stay is absent from all of them.
  This is one cohort (G1), not a display stage: it changes who is let in and
  who is reminded, so it needs its own plan.
- **`parentSettledWithoutCard`** treats a `CONFIRMED` parent as settled when
  deciding not to card-chase a guest portion (G7).
- **Unpaid-amount readers stay.** `readBookingAmountOwed` (`INV-PAY-119`) and
  its callers size what a pay step asks; an unpaid booking has no cash to
  subtract. Their status gates are display stages 3 and 4; the amount is not
  touched.
- **Censuses stay.** A census that read this reader would check the payment
  mirror against itself.

## 4. Stages

### 4.1 Display stages

Harm first: what a member is told, then what an officer acts on. One surface
per PR. Each reads `readBookingCashCover`, keeps its own copy and pins, and
reverts alone.

1. **Exception-approved email** (PR 1, built): the reader, and the email's
   amount and held-bed sentence from one snapshot. Beds are held exactly when
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
11. Finance forward metrics and the legacy dashboard export.
12. Unpaid finished stays queue and badge.
13. Join page's who-pays line.
14. Whole-lodge unpaid wording.
15. Wizard's pay redirect.
16. Booking history fallback item.
17. Booking status labels ("Paid", "Confirmed (Unpaid)") and the screens that
    print them.
18. Member detail spend summary.

That is 18 display PRs: this one and 17 to come.

### 4.2 Gated cohorts

Eligibility, replay-guard and writer-input rows. Each cohort gets its own
plan in #4069 before code, or moves with M15 (#4527), never both. The
inventory tags every such row with its cohort.

| Cohort | What it decides | Route |
| --- | --- | --- |
| G1 | Who counts as staying: operational-stay lists, "staying now" tools, the account-deletion block | own plan |
| G2 | Card, bank-switch and pay-link eligibility, and the guards that treat a paid status as "already paid" there | own plan |
| G3 | Officer may mark a booking paid, or reverse it | own plan |
| G4 | Guest-name edits on a fully paid booking | own plan |
| G5 | A `PAID` booking is expected to have a Xero invoice: sync eligibility, the missing-invoice list, mismatch and repair findings | own plan |
| G6 | Xero's paid arm: skipped when the booking reads paid, the second-instrument marker, the cash-settlement notice | own plan |
| G7 | Late-notice change fee; the guest portion that is not card-chased | own plan |
| G8 | Ledger back-post inputs | own plan, after `INV-MONEY-037` |
| G9 | The additional ask: owed, payable, resend, withdraw, reduce, remind, and the amount its card door asks | M15 |
| G10 | Zero-dollar auto-pay: an edit repriced to nothing is written `PAID` | M15 |
| G11 | Group settlement, late joiners and organiser-cancel child refunds | M15 |
| G12 | A capture arriving on a booking that reads paid | M15 |
| G13 | Credit give-back, the reprice after guest acceptance, and the review's invoice reduction | M15 |

Any stage that would read the ledger balance waits for the owner's
`INV-MONEY-037` evidence. Stop and revise this blueprint if a stage needs a
financial writer, schema, provider read or historical data changed, if a
parity difference cannot be explained, or if settlement cannot be attributed
without guessing (#4069 §8).

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
  extra superseded ownership applies (otherwise §2.3 explains the expected difference); a mutation probe for each
  input (pending face amount, status-only paid, omitted refund, omitted
  credit, organiser money counted twice); every copy variant rendered, the
  unknown one with no amount and no "paid"; reads proven to go through the
  snapshot's client only; and an import guard keeping the reader off the
  ledger balance and the owed reader.
- **Rollback:** no schema change; each stage reverts alone.

## 6. Review record

Three independent read-only lenses reviewed this blueprint and the Stage 1
build: money and attribution; concurrency and snapshot; tests, wording, docs
and `INV-SSOT`. They ran in rounds; the last read the finished build and the
inventory. No production data or live provider was used.

### 6.1 Findings and what was done

| Lens | Finding | Done |
| --- | --- | --- |
| Money | A superseded capture counted as cover between its capture and its refund row | The reader subtracts cancel-owned money not already in an open card refund (§2.3); real hand-off cases in the PostgreSQL suite |
| Money | A dispute on the organiser's combined capture was not read | Read in the same snapshot; `unknown` while it is open or lost |
| Money | An organiser-paid child with a proved share skipped the row and refund checks, so refunds above its share read `covered` | Row and refund rules now run for every payment (§2.5); pure and PostgreSQL regressions, including a valid child with no rows staying `covered` |
| Money | A refunded status on a payment that is not a card's, with no captured row, read `owes` its whole worth | It reads `unknown` (§2.6); a pure regression seen to fail without the fix |
| Money | The parity test only re-ran Net Collected | It now calls `deriveBookingCashCover` and explains the one expected difference |
| Concurrency | No reader case on a real database | `booking-cash-evidence.realdb.test.ts` runs the real capture, refund, credit and group writers |
| Concurrency | The email's between-read cases left out a refund and a group settlement | Both added; each asserts the amount and the held-bed sentence together |
| Tests, docs | The organiser-pays line reached the sender only through a helper, and the render pin held a placeholder | All five payment lines are pinned as the sender renders them |
| Tests, docs | No invariant for the reader; state-machine and email guides silent | `INV-PAY-159`, and the guides, describe it |
| Tests, docs | The inventory grouped helpers and estimated the false positives | Replaced by the row-per-decision inventory (§3) |
| Concurrency; tests, docs | The held-bed line sent every member to "bank-transfer details and deadline", though an officer-held card booking also holds its beds | One held line that is true for any payment method: "open it from your account to pay or to see the payment details"; a card case pins that it never mentions a bank |
| Money | "A superseded capture is never cover" was stated without its limit: one behind a dead cancel with no refund row counts | Stated in §2.7, the reader's header and `INV-PAY-159`; a PostgreSQL case runs the real hand-off, fails its refund row and reads owed while the cancel runs, covered once it is dead |
| Concurrency | The "no default client" guard read only the reader's imports; two helpers it calls fall back to the module client when handed none | A guard that every awaited call in the reader passes `tx`; seen to fail with the argument dropped |
| Tests, docs | The reader listed its own "live or finished" statuses, a list `booking-status.ts` already holds | It reads `DUPLICATE_STAY_BOOKING_STATUSES` |
| Tests, docs | Two snapshot tests pinned the order of reads, not which reads | They compare the sorted reads |
| Tests, docs | The member guide still said the beds are never held until payment; `INV-EXCEPT-031` did not say the email reports held beds; §2.5 said "no settlement" always gives `unknown`; the inventory's file count read as two † sites against three; two inventory rows were imprecise | Each reworded |

| Independent gate | A fully refunded settlement made a zero-priced child read `organiser_pays` | Captured child mirrors still go through the share proof; pure and real-writer full-refund regressions |
| Independent gate | Sekreton skipped the cash-cover PostgreSQL suite; failed setup could delete untouched settings | Added the suite to its existing database job; teardown distinguishes unread settings from absent rows |

### 6.2 Readings taken where the contract was silent

- **An unpaid organiser child before any frozen share exists.** The approved
  contract says an unsettled organiser-pays child reads `organiser_pays`, and
  that a share the frozen plan cannot prove reads `unknown`. Before the
  organiser pays there is no frozen share to prove. The build separates the
  two questions: who pays is proved by the group alone; `covered` needs the
  share proof and clean evidence. The member is never asked for the
  organiser's money either way.
- **Held beds** read `bookingHoldsCapacity` without a separate
  `wholeLodgeHold` term (§4.1, stage 1).
- **A saved-card charge in progress.** The confirm-pending job can claim a
  booking for a card charge while the approval email is being composed. The
  snapshot then truthfully reads money owed and beds held, and the email says
  so seconds before the charge lands. A lens suggested answering `unknown`
  while a claim is open. Not taken: the reader answers what cash is held, and
  nothing is held yet; the line is true at its moment and sends the member to
  the booking, which shows the charge once it lands. Whether a claimed
  booking's pay doors should refuse a second payment is those doors' question
  (cohort G2, §4.2).
- **A dead cancel.** The reader follows the Xero reading's rule rather than
  adding one: a capture nobody is sending back is money the club holds.

### 6.3 Limits

- The approval harness runs the real approval engine, bank-switch route,
  exclusive-hold route, reader and sender over a simulated transaction. Reads
  against PostgreSQL are proved by the reader's own suite, not by the email
  path end to end. In the harness the dispute and recovery-operation lookups
  return nothing, so those inputs reach the email only through the reader's
  suite.
- The dead-cancel case reaches its state through the real hand-off, then
  marks the cancel row's attempts spent with a fixture write.
- The inventory's pass cannot see a status held under another name (§2 of
  the inventory). Three such sites were found by reading callers; there may
  be others, and each display stage re-reads its own callers before it moves.
