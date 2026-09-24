# The Booking Ledger — Design

**Status:** Design, not implementation (#3532, stage 4 of programme #3527).
Nothing in this document changes runtime behaviour. Its outputs are the model,
the posting rules, the projection guard, the cut-over order, the invariant gap
analysis in §9, and the child issues in §10, each of which ships on its own.

**Audience:** developer / agent. An operator reads §1 and §2 and stops.

---

## 1. The problem in one paragraph

A booking's money lives in mutable columns that mirror one another —
`Booking.finalPriceCents`, `Payment.amountCents`, `creditAppliedCents`,
`refundedAmountCents`, `additionalAmountCents`, `changeFeeCents` — held
consistent by `INV-PAY-047`'s identity (*collected + credited + owed = price*)
and by the fences, locks and censuses that a large part of the invariant
catalogue exists to describe. Every money event updates the mirror; the Xero
documents are built from the columns, the member email from them again, the
booking history narrates them a third time. The bugs of the last two years
(#2397, #2902, #3170, #3193, #3220, #3340) are all one shape: two projections of
the same money disagreeing. Programme #3527's stages 0–3 closed the doors that
let a person type a number; this stage designs the structure that makes the
disagreement unrepresentable.

## 2. The answer in one paragraph

One append-only table, `BookingLedgerLine`. Every money fact about a booking is
a posted line: what kind of fact, its sign, its quantity and unit price, which
guest strand and which nights, what event anchored it, how it settled, when it
was posted, and which earlier line it reverses. Charge lines (a guest-night at
a rate tier, a change fee, a promotion) and settlement lines (a card capture,
a bank receipt, credit applied, a card refund, a bank refund, credit issued)
share the table. **Balance is derived, never stored.** An edit is a reversal
plus a re-post, never a delta. The Xero documents, the member's statement, the
booking history and the finance reports are renderings of slices of the same
rows (`INV-SSOT`). Today's `Payment` columns become a projection of the ledger,
guarded by a census that they agree, and are retired once the reads have moved.

## 3. What already has the ledger's shape

The design builds on, and must not replace, what #3272 and #3530 landed:

| Existing row | Ledger reading | Kept as |
| --- | --- | --- |
| `BookingGuestNight` (`priceCents`, `priceSource`; `INV-MONEY-028`, `INV-MOD-028`) | the charge line for one guest-night, with provenance | the source of `GUEST_NIGHT` lines at confirmation; a night row stays the *authority for what was sold*, the ledger line is its posting |
| `BookingModification.priceLines` (`ModificationLine`, `INV-MOD-058`) | signed guest-night runs and a promo delta per edit — a reversal-and-re-post already, folded into runs | the exact payload of `EDIT_*` postings; the ledger adds an anchor and a `postedAt`, nothing else |
| `PaymentTransaction` (`PRIMARY` / `ADDITIONAL`, `carriedAskCents`) | a settlement line per capture, or an *ask* (an obligation, not money) | captures post `SETTLEMENT` lines; an ask is **not** a line (§5.3) |
| `PaymentRefund` | a negative settlement line, card method | posts `SETTLEMENT` lines with `method = CARD`, sign −1 |
| `MemberCredit` (`CANCELLATION_REFUND`, `BOOKING_MODIFICATION_REFUND`, `ADMIN_ADJUSTMENT`, `BOOKING_APPLIED`) | credit issued (−, `ACCOUNT_CREDIT`) or applied (+, `ACCOUNT_CREDIT`) | stays the member's credit ledger (`INV-PAY-019`: account credit lives solely in `MemberCredit`); the booking ledger posts the booking-side leg and links the credit row |
| `ManualRefundTask` `EDIT_FINANCIAL_REVIEW` shares (`INV-MOD-055`, `INV-PAY-061`) | a person's settlement decision on a parked edit | posts one `ADJUSTMENT` line per completed share, anchored on the task |
| `INV-MONEY-030` / `INV-MONEY-031` (stored readers record their source; verdicts are derived) | the reader discipline the ledger generalises | the projection guard is this verdict extended to settlement |

The one-line test for every later child: **if the row already exists, the
ledger posts from it; it never re-derives it.** A ledger line is a posting of a
fact recorded elsewhere until the cut-over makes the line the fact (§7).

## 4. The model

```prisma
model BookingLedgerLine {
  id                String                @id @default(cuid())
  bookingId         String
  /// CHARGE lines price the stay; SETTLEMENT lines move money; ADJUSTMENT
  /// lines are a person's named decision (INV-MONEY-007). Nothing else exists.
  side              LedgerSide
  kind              LedgerLineKind
  sign              Int                   // +1 or -1, checked
  quantity          Int                   // guest-nights, or 1
  unitCents         Int                   // >= 0
  amountCents       Int                   // == sign * unitCents * quantity, checked
  /// CHARGE only: which strand and which nights. NULL on settlement lines.
  bookingGuestId    String?
  nightStart        DateTime?             @db.Date
  nightEndExclusive DateTime?             @db.Date
  rateMembershipTypeId String?
  ageTier           AgeTier?
  /// CHARGE only: the guests this line is for, as named when it was posted
  /// (owner decision D-3532-3, 23 Sep 2026) — the same self-contained shape
  /// `ModificationLine.guestNames` already uses, so a document rendered from a
  /// line reads the same years later whatever happened to the guest row since.
  guestNames        String[]
  /// What posted it. Exactly one anchor per line (checked): the booking's own
  /// confirmation, a modification, a review task, a payment transaction, a
  /// refund, a member-credit row, or a cancellation.
  anchorKind        LedgerAnchorKind
  anchorId          String
  /// SETTLEMENT only: how the money moved (INV-PAY-101's decision, recorded).
  settlementMethod  SettlementMethod?
  /// A reversal names the line it reverses; a reversed line is never edited.
  reversesLineId    String?               @unique
  postedAt          DateTime              @default(now())
  postedByMemberId  String?               // a person's decision; NULL for the system
  /// Narration only, never read for money (INV-MOD-058's discipline).
  narration         String
  /// Idempotency key, deterministic from the event (#3595, INV-MONEY-033),
  /// built only in `booking-ledger-posting-keys.ts`. Unique; the write door
  /// inserts with ON CONFLICT DO NOTHING, so the same event posted twice is a
  /// no-op rather than a duplicate or an abort.
  postingKey        String?               @unique
  lodgeId           String

  booking   Booking          @relation(...)
  reverses  BookingLedgerLine? @relation("Reversal", fields: [reversesLineId], references: [id])
  reversedBy BookingLedgerLine? @relation("Reversal")

  @@index([bookingId, postedAt])
  @@index([anchorKind, anchorId])
}

enum LedgerSide        { CHARGE SETTLEMENT ADJUSTMENT }
enum LedgerLineKind    {
  GUEST_NIGHT        // CHARGE: one guest, one night, one rate tier
  CHANGE_FEE         // CHARGE
  PROMOTION          // CHARGE: negative amount, the promo adjustment
  GROUP_DISCOUNT     // CHARGE: negative amount
  CARD_CAPTURE       // SETTLEMENT +
  BANK_RECEIPT       // SETTLEMENT +   (Internet Banking, Xero-reconciled)
  CREDIT_APPLIED     // SETTLEMENT +   (account credit consumed)
  CASH_RECORDED      // SETTLEMENT +   (manual mark-paid, INV-PAY-001)
  CARD_REFUND        // SETTLEMENT -
  BANK_REFUND        // SETTLEMENT -   (hand-back completed, #3529 credit note)
  CREDIT_ISSUED      // SETTLEMENT -   (account credit minted to the member)
  AGREED_ADJUSTMENT  // ADJUSTMENT ±   ("Adjustment agreed with member: <note>")
}
enum LedgerAnchorKind  { CONFIRMATION MODIFICATION REVIEW_TASK PAYMENT_TRANSACTION PAYMENT_REFUND MEMBER_CREDIT CANCELLATION }
enum SettlementMethod  { CARD INTERNET_BANKING ACCOUNT_CREDIT CASH }
```

Three database checks carry the rules that must never depend on a writer
remembering them: `sign IN (1, -1)`; `amountCents = sign * unitCents * quantity`;
`(side = 'CHARGE') = (bookingGuestId IS NOT NULL OR kind IN ('CHANGE_FEE',
'PROMOTION', 'GROUP_DISCOUNT'))`. `reversesLineId` is unique, so a line is
reversed at most once. There is **no `UPDATE` and no `DELETE`** on this table
from application code; the census in §6 scans for either (the
`stored-night-price-repair-census` pattern) and the Prisma extension the
writers share exposes only `create` and `createMany`.

### 4.1 Derived quantities, and the one place they are derived

```
charged(b)   = Σ amountCents over side = CHARGE     for booking b   (net of reversals)
settled(b)   = Σ amountCents over side = SETTLEMENT for booking b
adjusted(b)  = Σ amountCents over side = ADJUSTMENT for booking b
owed(b)      = charged(b) + adjusted(b) - settled(b)
```

`owed(b) > 0` is "the member owes"; `< 0` is "the club owes the member"; `0`
is settled. One pure module, `src/lib/booking-ledger-balance.ts`, is the only
home of those four sums and of the slices §8 renders from. It takes rows and
returns figures; it reads nothing.

### 4.1a Idempotency: every posting is keyed, and confirmation is fenced

Added after C1 shipped (#3595, `INV-MONEY-033`), because the first draft of
this design did not say, and C1's review lens that would have asked was cut
short. Two rules, because the first fix found one was not enough.

**Every posting carries a key** derived from the event it records — never from
when it was posted or by whom — and the write door inserts with
`ON CONFLICT DO NOTHING`. The same event produces the same key and the second
write is a no-op. That it is a *skip* and not a *refusal* is the point: a
refused statement aborts the caller's transaction (#3590's review). Every key
is built in `src/lib/booking-ledger-posting-keys.ts` and nowhere else — a
child that hand-rolled a spelling would produce keys that never collide with
the ones it was meant to. A **reversal** is keyed by the reversed line's *id*
(every line has one; a line posted before #3595 has no key), so a second
reversal of one line is a skipped replay rather than a second, different
posting the unique `reversesLineId` could silently absorb.

**A key makes one event idempotent — not a booking's confirmation.** A booking
can pass the settle's PAID claim twice: an officer marks it paid, reverses the
mark-paid (restoring a payable status), and the member then pays by card. In
between, its nights can change — a date shift recreates them, a guest removed
and re-added gets a new id — so per-night keys would all be new and the whole
charge would post again. The first cut of #3595 claimed keys alone closed
this; its review showed they do not. So the settle also **fences per
booking**: under its own global `lock(1)`, it asks whether any confirmation
line exists for the booking (keyed or not, so #3580-era lines fence too) and
posts nothing if one does.

That fence has a consequence C3 must honour: **an edit to a booking that is
already confirmed on the ledger posts modification lines, whatever its payment
status** — including in the window between a mark-paid reversal and the next
settle, because the next settle will post nothing.

Two limits, stated rather than hidden. A line the *old* colour posts during a
blue/green drain has no key and the old colour has no fence, so a booking
re-settled by the old colour inside that window could post twice; C4's census
reports it. And C4's back-post (#3583) must fence per booking the same way,
not rely on keys alone, because it runs over lines that predate them.

### 4.2 What is deliberately not in the model

- **No running balance column, no `status`.** Both are derived; a stored copy
  is the mirror this design retires.
- **No Xero or Stripe id on the line.** The anchor row carries the provider's
  id (`PaymentTransaction.stripePaymentIntentId`, `MemberCredit.xeroCreditNoteId`,
  `XeroObjectLink`); a line points at the anchor. Provider identity is
  `INV-PAY-014`/`INV-PAY-015`'s concern and stays where it is.
- **No `Money` outside cents** (`INV-MONEY-001`, `INV-MONEY-003`). Currency is
  the club's (#3563), never per line.
- **No personal data beyond the guest names D-3532-3 puts there.** No email, no
  member id beyond `postedByMemberId` (the officer who decided), no note except
  the narration a person typed for an `AGREED_ADJUSTMENT`. A name on an
  immutable row cannot be corrected later, which is the cost the owner
  accepted for self-contained lines; a correction is a reversal and a re-post,
  like every other correction here.
- **No line for an *ask*.** An unpaid additional-payment request is an
  obligation the derived `owed(b)` already states; storing it as a line would
  reintroduce `additionalAmountCents` under another name (§5.3).

## 5. Posting rules: every money event the system handles today

Each row answers the acceptance criterion *which lines are posted, and by
whom*. "Writer" is the module that owns the transaction today. Where a child
found a single point every one of those writers already passes through, the
lines are posted there instead, from the same rows, inside the same
transaction — so the column names the ORIGIN of the fact, and each child's
prose says where it is actually posted. §5.2's preface is the case in point.

### 5.1 Pricing the stay (CHARGE)

| Event today | Lines posted | Anchor | Writer |
| --- | --- | --- | --- |
| Booking confirmed / paid for the first time (`booking-create.ts`, the pay routes, waitlist confirm, quote conversion) | one `GUEST_NIGHT` (+) per `BookingGuestNight` row, quantity 1, `unitCents = priceCents`, rate tier and age tier from the guest's snapshot (`INV-MOD-010`); one `PROMOTION` (−) for `promoAdjustmentCents` when non-zero; one `GROUP_DISCOUNT` (−) for `discountCents` when non-zero; one `CHANGE_FEE` (+) when `changeFeeCents > 0` | `CONFIRMATION` / booking id | the settle body (`INV-PAY-038`: mark-paid, card and IB all enter it) |
| Whole-lodge / officer flat price (`INV-MONEY-004`) | the same `GUEST_NIGHT` lines from the night rows the rebase wrote; a flat price that does not divide is a `GUEST_NIGHT` per strand at the rebased strand figure (`INV-MOD-038`) | `CONFIRMATION` | same |
| Booking edited and priced (four doors + batch, `INV-MOD-044`) | for each `ModificationLine` in `priceLines`: a **reversal** line (−) per removed run that names the original `GUEST_NIGHT` line(s) it reverses, and a fresh `GUEST_NIGHT` (+) per added run; a `PROMOTION` reversal + re-post when the promo delta is non-zero; a `CHANGE_FEE` (+) when the edit charged one | `MODIFICATION` / modification id | the four edit services, in the transaction that already writes `priceLines` (`INV-MOD-058`) |
| Booking edited and **parked** (`INV-MOD-040`) | **nothing** — a parked edit writes structure, never an amount; the lines post when the review closes | — | — |
| Review closed by re-pricing (`INV-MOD-055`) | the edit's lines as above, from the re-based strands | `MODIFICATION` | `edit-financial-review` closure |
| Admin price rebase (`booking-review-price-rebase.ts`) | reversal of every `GUEST_NIGHT` the rebase changed + re-post at the new figure | `MODIFICATION` (the rebase already writes its own `BookingModification` history row, both money components zero) | the rebase |

### 5.2 Moving money (SETTLEMENT)

**How C2 (#3581) actually posts these, which refines the "Writer" column
below.** The capture, receipt, cash and card-refund rows do not post from each
writer. Every one of those writers already ends in `reconcilePaymentAggregates`
— the one place the `Payment` mirror is derived from `PaymentTransaction` and
`PaymentRefund` rows — so a single sync runs there and CONVERGES the ledger
from the same rows: it posts a line for every captured transaction and
recorded refund that lacks one, and a reversal for every line whose source no
longer holds. Insert-only would not have been sound: a mark-paid reversal flips
its row from `SUCCEEDED` to `FAILED`, and a refund can fail after it was
recorded. "Captured" and "recorded" are the mirror's own predicates
(`payment-transaction-status.ts`), so the ledger's capture lines equal
`Payment.amountCents` whenever anything is captured (with nothing captured the
column falls back to the latest primary's face amount, which is not money).
The refund side is honest where the column is not: `refundedAmountCents` only
ever rises, is seeded without refund rows on legacy payments, and is moved by
credit and hand-back refunds that have no `PaymentRefund` row — so after a
refund fails, the ledger reverses it while the column keeps counting it.
`INV-PAY-050` already names that column as not cash evidence; §6's refund
identity is therefore one C4 (#3583) must classify, not assert. Three writers
bypass the chokepoint and call the same sync explicitly: the manual mark-paid
settle, its reversal, and the Xero payment-received path, which writes its
Internet Banking receipt row and sets the payment's columns itself — the one
review of #3604 found missing.

**Refund lines are posted after the provider answers, not before.** The table
below says "before the provider call"; that is when the *debt* is made durable
(`INV-ADDPAY-018` — the `PaymentRefund`/recovery row), and it still is. The
ledger line records money actually returned, so it converges from the row once
the row says so. Posting it before the provider answered would record a refund
that might never happen. The credit rows and the hand-back
are not payment transactions and never pass through it; they post from their
own writers in #3599.

| Event today | Lines posted | Anchor | Writer |
| --- | --- | --- | --- |
| Card capture, PRIMARY or ADDITIONAL (`INV-PAY-055`, `INV-PAY-081`) | `CARD_CAPTURE` (+) for the captured amount, `method = CARD` | `PAYMENT_TRANSACTION` | the Stripe webhook / recovery settle, inside the fenced claim |
| Internet Banking invoice paid (`INV-PAY-015`, `INV-PAY-026`) | `BANK_RECEIPT` (+) for the cash evidenced, `method = INTERNET_BANKING` | `PAYMENT_TRANSACTION` | the inbound Xero reconciler's settle |
| Account credit applied at confirmation (`INV-PAY-002`, `INV-PAY-024`) | `CREDIT_APPLIED` (+), `method = ACCOUNT_CREDIT`, linked to the `BOOKING_APPLIED` `MemberCredit` row | `MEMBER_CREDIT` | the credit-election consumer (`INV-PAY-005`) |
| Manual mark-paid (`INV-PAY-001`, `INV-PAY-038`) | `CASH_RECORDED` (+), `method = CASH`, `postedByMemberId` = the officer | `PAYMENT_TRANSACTION` | the mark-paid settle |
| Mark-paid reversal (`INV-PAY-045`) | reversal of the `CASH_RECORDED` line | `PAYMENT_TRANSACTION` | the reversal |
| Card refund — cancellation tier, reduction, superseded payment, duplicate capture (`INV-MOD-011`, `INV-PAY-043`, `INV-PAY-065`) | `CARD_REFUND` (−), `method = CARD` | `PAYMENT_REFUND` | converges from the `PaymentRefund` row once it records the refund (see above: the debt is durable before the provider call, `INV-ADDPAY-018`; the ledger line follows the answer) |
| Cancellation credited to account (`CANCELLATION_REFUND`) | `CREDIT_ISSUED` (−), `method = ACCOUNT_CREDIT`, linked to the credit row | `MEMBER_CREDIT` | `booking-cancel.ts` |
| Reduction credited to account (`BOOKING_MODIFICATION_REFUND`) | `CREDIT_ISSUED` (−), `method = ACCOUNT_CREDIT` | `MEMBER_CREDIT` | the reduction path |
| Hand-back completed for an IB/cash cancellation (`CANCELLED_BOOKING_HAND_BACK`, #3529) | `BANK_REFUND` (−), `method = INTERNET_BANKING`, `postedByMemberId` = the officer | `REVIEW_TASK` | `manual-refund-task-resolution.ts` |
| Applied credit restored on cancellation (`INV-PAY-019`) | reversal of the `CREDIT_APPLIED` line | `CANCELLATION` | `booking-cancel.ts` |
| Hold-expiry release / stale-invoice clearing note (`INV-PAY-017`) | nothing — no money moved; the Xero note is a rendering of `owed(b)` going to zero by reversal of the charge lines | — | — |

### 5.3 A person decides (ADJUSTMENT) and the ask

| Event today | Lines posted | Anchor | Writer |
| --- | --- | --- | --- |
| Review share completed `CHARGE_TO_MEMBER` (+) or `REFUND_TO_MEMBER` (−) (`INV-PAY-061`, `INV-PAY-069`; the only two directions today) | `AGREED_ADJUSTMENT` (± the share) with the task note as narration; the *settlement* that follows — the ask, the card refund, the account credit, the hand-back — posts its own line through §5.2 | `REVIEW_TASK` | task completion |
| Review share dismissed (`INV-PAY-099`) | nothing; a dismissal moves no money and can be reopened | — | — |
| Admin credit adjustment (`ADMIN_ADJUSTMENT`, `INV-MONEY-007`) | not a booking-ledger event unless applied to a booking, when it posts `CREDIT_APPLIED` | `MEMBER_CREDIT` | — |
| Additional-payment ask raised (`INV-PAY-062`, `INV-PAY-098`) | **no line.** `owed(b)` already states it. The ask row (`PaymentTransaction` `ADDITIONAL`, PENDING) is the *instrument* — the intent, the reminder clock, the Xero supplementary invoice — and stays a row about collection, not about money | — | — |
| Ask withdrawn (#3528, `INV-ADDPAY-040`) | no line; the debt is not written off (`INV-PAY-093`) — `owed(b)` is unchanged and a later ask can re-collect it | — | — |
| Late capture on a deleted booking (`INV-ADDPAY-036`) | `CARD_CAPTURE` (+) as any capture; the task that queues it for a person is the instrument | `PAYMENT_TRANSACTION` | the webhook |

**The ask is the one place today's shape survives.** `additionalAmountCents`
is retired (it is `max(0, owed(b))`), but the `ADDITIONAL` transaction row
remains because it is what Stripe, Xero and the reminder cron act on. That is
a collection instrument, not a money fact, which is why it is not a line.

## 6. The projection guard

Until §7's reads switch, `Payment.amountCents`, `creditAppliedCents`,
`refundedAmountCents`, `additionalAmountCents`, `changeFeeCents` and
`Booking.finalPriceCents` are **projections** of the ledger:

```
finalPriceCents        == charged(b) + adjusted(b)
amountCents            == Σ CARD_CAPTURE + BANK_RECEIPT + CASH_RECORDED     (gross of refunds — today's meaning)
creditAppliedCents     == Σ CREDIT_APPLIED (net of reversals)
refundedAmountCents    == -Σ CARD_REFUND
changeFeeCents         == Σ CHANGE_FEE
additionalAmountCents  == max(0, owed(b)) when an ADDITIONAL PENDING row exists, else 0
```

`npm run booking-ledger:census` (read-only, one `RepeatableRead` snapshot —
the `censusBookingMoneyReconciliation` pattern, `INV-MONEY-031`) evaluates
those six identities for every booking and reports, per identity, the count
that agrees, the count that disagrees, and per disagreeing booking the six
figures and the delta — never a repair. It also reports **coverage**:
bookings with money columns and no lines at all.

**This census is the cut-over gate, not a monitor** (§7, D-3532-1). Its
load-bearing run is once, over the club's whole booking history, after the
back-post: every booking ever made, every event kind that has ever occurred,
compared line-against-column. Zero disagreements and zero coverage gaps is
what permits Release 2; a disagreement is a poster bug, fixed and re-run. It
then keeps running — in CI against the seeded database, and on the operator's
word against production read-only — for as long as the columns exist, which
is what makes Release 2 reversible.

The census reuses `auditIbAppliedCreditStrands`'s shape (`INV-PAY-047` (3)) and
retires it: that script's identity is one of the six.

## 7. Cut-over order

**Owner decision D-3532-1 (23 Sep 2026): prove against history, then cut over
fast — no shadow period.** The gate between posting and reading is *evidence*,
not elapsed time, and the strongest evidence available is the club's whole
booking history rather than a few weeks of new traffic: a month of live
bookings at this volume is a couple of dozen bookings and probably no
cancellation, hand-back or late capture, while the backfill exercises every
event kind that has ever occurred, thousands of times. So the census runs once
over everything, the reads move as soon as it is clean, and the columns are
dropped when the owner says so.

Three deploys, not three months.

**Release 1 — post and prove (children C1–C4).** The table is added (expand,
`old_code_compatible = yes`, ledger row in `BLUE_GREEN_MIGRATION_SAFETY.tsv`);
every money fact in §5 posts its lines inside the transaction and claim that
records it — from its writer, or from a single point every writer of that kind
already passes through (§5.2); an operator script back-posts every existing booking; §6's census
compares the ledger against today's columns **for every booking ever made**.
Nothing reads a line. The exit condition is the census: zero disagreements and
zero coverage gaps, not a date. Anything it finds is a poster bug, fixed and
re-run — which is the whole point of doing this over history rather than over
next month's traffic.

**Release 2 — reads switch (children C5, C6).** Statement, emails, booking
history, finance reports, officer money panel and the Xero renderers read
`booking-ledger-balance.ts`. Each read moves in its own PR, with the census
green before and after; `INV-PAY-020`'s statement reconciliation becomes a
read of `owed(b)`. The columns are still written and still compared, so this
release is reversible by reverting the readers.

**Release 3 — contract (child C7), on the owner's word.** The six columns are
dropped, the fences that re-asserted them (`INV-PAY-047` (2)) are deleted, and
§9's `P` rows retire. Hours or weeks after Release 2, as the owner chooses;
the gap costs nothing but the unused columns.

Two rules survive the compression, because they are what make the speed safe:

- **No read moves before the census is clean over the whole population**
  (Release 1's exit condition). This is not a soak; it is a proof, and it is
  finished when it is finished.
- **No column is dropped in the same release as the code that stops writing
  it.** `BLUE_GREEN_MIGRATION_POLICY.md` forbids a child pairing an expand
  with its own contract, and the validator enforces it; a one-release drop is
  available only as a `windowed` row behind a maintenance window (the #2520
  precedent, an owner directive on 3 Aug 2026) and is not worth it here,
  because keeping the columns through Release 2 is what makes Release 2
  reversible.

## 8. Renderings

Every surface below is a **pure function of a ledger slice** and the
booking's identity, in one module each, none of which reads a `Payment` column
after C5:

| Surface | Slice | Module |
| --- | --- | --- |
| Member statement / booking page money panel | all lines, grouped by side, `owed(b)` | `booking-ledger-statement.ts` |
| Confirmation email (`INV-PAY-020`) | `CHARGE` + `CREDIT_APPLIED` + the settling line | `booking-confirmation-money.ts` |
| Modification email (`INV-MOD-042`) | the `MODIFICATION` anchor's lines | `booking-modification-money.ts` |
| Booking history narrative (`booking-history-modification-narrative.ts`) | lines by anchor, `narration` | existing module, reading lines |
| Xero invoice / supplementary / credit note (§7 C6) | per §7 | the existing builders, reading lines |
| Finance reports, exports (`INV-MONEY-031`'s consumers) | sums by kind and month | existing modules |

One rendering is not a projection: the **verdict** (`INV-MONEY-031`) survives
as the census's per-booking result and stays officer-only.

## 9. Invariant gap analysis

Every `INV-PAY`, `INV-MOD`, `INV-MONEY` and `INV-ADDPAY` rule, classified.
No row is "unknown". Codes:

- **C — retired by construction.** The ledger makes the violation
  unrepresentable; the rule is deleted at C7 with a pointer here.
- **L — ledger equivalent.** The rule survives restated about lines; the
  restatement is given.
- **P — projection era only.** Holds the mirror true until C7, then retires
  with the columns.
- **U — unchanged.** Not about the money mirror (provider idempotency, card
  handling, capacity, policy, membership billing); untouched by this design.

### 9.1 `INV-MONEY`

| Id | Code | Ledger reading |
| --- | --- | --- |
| 001, 003 | U | cents everywhere; the line's three integer columns and the check constraint |
| — | U | `INV-PRIV` retention applies to `guestNames` on a line (D-3532-3) exactly as to the guest row it was copied from |
| 002, 008–022 | U | membership and joining-fee billing; a different ledger (`MembershipSubscriptionCharge`), out of scope by the issue |
| 004 | L | a flat price posts per-strand `GUEST_NIGHT` lines at the rebased figure |
| 005, 023–027 | U | promo caps count `PromoRedemption`/allocation rows, which stay the promo authority; the `PROMOTION` line is their posting |
| 006 | L | "reconcile back to cent-based ledger records" becomes literal: every Stripe/Xero amount is a line's `amountCents` |
| 007 | L | an `ADJUSTMENT` line requires `postedByMemberId` and a narration; approval stays on `AdminCreditAdjustmentRequest` |
| 028 | L | a `GUEST_NIGHT` line posts only from an exact night row; inexact strands post at whole-guest grain (§7 C1) |
| 029 | L | `PROMOTION` line = the promo build-up; unknown posts nothing and the census reports the gap, never zero |
| 030 | U | reader discipline; the ledger readers follow it |
| 031 | L | the verdict becomes the census's per-booking result (§6, §8) |

### 9.2 `INV-PAY`

| Id | Code | Ledger reading |
| --- | --- | --- |
| 001, 038, 039, 040, 049 | L | mark-paid posts `CASH_RECORDED` with the officer; the provenance columns become that line's `postedByMemberId`/`postedAt`; refusals unchanged |
| 041, 042, 043 | U | invoice-mint fences, inbound PAID raise, duplicate-capture auto-refund — the refund posts a `CARD_REFUND` |
| 044 | L | a manually settled cancellation posts `BANK_REFUND` only when the hand-back completes (§5.2) |
| 045 | L | reversal permitted while no later line is anchored after the `CASH_RECORDED` line |
| 046 | C | an upward delta is `owed(b) > 0`; it cannot be absorbed or dropped because nothing stores it |
| 058 | U | the not-covered settle's intent handling |
| 047 | C | the identity *is* `owed(b)`; (1) construction and (2) the fence exist to keep a stored copy true — retired with the copy; (3) is the census |
| 048, 009, 010, 011, 012 | U | the credit election (a pre-settlement intent, not money) |
| 050 | L | a Stripe refund note renders a `CARD_REFUND` line; the "refunded-amount mirror" no longer exists to be rendered by mistake |
| 051, 067, 060, 068, 096, 097, 099, 100 | U | the review task's lifecycle; it anchors `ADJUSTMENT` lines and is otherwise unchanged |
| 052–054, 073–080 | U | saved-card handling |
| 055, 081–090 | L | one attempt = one `PaymentTransaction` = at most one `CARD_CAPTURE` line (anchor uniqueness per transaction id) |
| 056, 091, 092 | U | recovery terminality |
| 057, 093, 094, 095 | L | withdrawal cancels the instrument; `owed(b)` is unchanged (§5.3) — 093 "never writes off the debt" is structural |
| 061, 069 | L | a completion posts an `AGREED_ADJUSTMENT`; the direction is the line's sign; the settlement path chosen at completion posts the §5.2 line |
| 062, 098 | L | one edit raises one ask for `max(0, owed(b))`; a replacement ask's "carried" figure is the same derivation, `carriedAskCents` retires |
| 101 | L | `settlementMethod` on the line is the recorded decision the document names |
| 070, 063, 071, 072 | L | the Xero leg bills the anchor's slice; a shortfall is a slice whose lines post after the invoice was sent |
| 064 | L | recovery replays close debt only when an ask row exists — unchanged in shape, `owed(b)` replaces the stored figure |
| 065 | L | a card refund caps at Σ `CARD_CAPTURE` − Σ `CARD_REFUND` for the anchor, derived |
| 066 | U | the four doors an open review fences; DB constraints unchanged |
| 002–008 | U | credit election and $0 settlement; 007's "$0 settle" posts no settlement line and `owed(b) = 0` |
| 013, 014, 015 | U | Stripe and IB paths stay distinct; the line records the method, the anchor the provider |
| 016, 017 | U | holds and hold-expiry release (§5.2: no line) |
| 018 | C | "captured" is Σ `CARD_CAPTURE` for the booking; nothing else can be rewritten to say otherwise |
| 019 | L | applied credit is conserved: a `CREDIT_APPLIED` line is reversed exactly once (`reversesLineId` unique) and the `MemberCredit` row stays the credit authority |
| 020, 021, 022, 059 | L | the statement reconciliation is `owed(b)`; "pay the smaller" is a derivation over `CREDIT_APPLIED` and the charge slice |
| 023, 024 | U | how applied credit reaches Xero and Stripe (allocation, effective intent amount) |
| 025, 026 | U | cash evidence before crediting; a `BANK_RECEIPT` posts only on that evidence |
| 027, 028, 029, 030 | U | idempotency and provider retry; posting is inside the same idempotent claims |
| 031–037 | U | group settlement and organiser cancel; each child posts its own lines under its own anchor; 037's "no child mirror applies twice" is C once the mirror is gone |

### 9.3 `INV-MOD`

| Id | Code | Ledger reading |
| --- | --- | --- |
| 001 | L | "never desynchronise money" — money is one table; the rest of the list (guests, Xero, beds, audit, waitlist) unchanged |
| 002 | C | traceability is the anchor column |
| 003 | U | transient intent failure recovery |
| 004, 019, 020–024, 025 | U | dates, windows and minimum stay |
| 005, 006, 026 | L | locked nights are `GUEST_NIGHT` lines that a re-post preserves (same unit, same tier); only reversed lines reprice |
| 007, 008, 009, 010, 027, 029–035 | U | rates, eligibility, snapshots |
| 011, 012 | L | a reduction posts a reversal; the refund/credit line follows the tier; "over-consumed slice" is Σ `CREDIT_APPLIED` − `charged(b)` |
| 013 | L | a parked modification posts nothing (§5.1) |
| 014, 015, 016, 017 | U | Xero credit-note allocation mechanics (`MemberCreditNoteAllocation` stays) |
| 018 | U | lifecycle transitions |
| 028, 036, 037, 045–048, 051–054 | L | the night row stays the sold-price authority; the line posts from it; a blank posts nothing; the repair store's writes reverse-and-re-post |
| 038 | C | three consumers of a re-based strand read one line set |
| 039 | L | whole-guest vs individual-night evidence decides the grain a strand posts at (§7 C1) |
| 040, 041, 042, 043, 044 | U | what parking writes and discloses |
| 049 | L | during an open review the pre-edit lines stand; `owed(b)` is the pre-edit figure |
| 050 | U | the placeholder link and the other-club tick |
| 055 | L | closing re-prices = reversal + re-post from strands, or declines (posts nothing) |
| 056 | U | operation-grain provenance |
| 057 | U | cancellable statuses |
| 058 | L | `priceLines` become the `MODIFICATION` anchor's lines; "every reader reads those rows" is the design's premise |

### 9.4 `INV-ADDPAY`

| Id | Code | Ledger reading |
| --- | --- | --- |
| 001 | L | "who is owed" is `owed(b) > 0` and the booking status together |
| 023 | L | a retired obligation is a reversed `AGREED_ADJUSTMENT` or a reversed charge; the intent cancel is unchanged |
| 024–029 | U | the reminder cron |
| 002–013 | U | side doors, approvals, quotes, the name lock |
| 014 | L | a reduction against an unpaid invoice renders the reversal slice as a credit note |
| 015 | C | "capped by booking worth, never the payment mirror" — there is no mirror; the cap is Σ captures for the anchor |
| 016 | L | a credit-settled reduction posts `CREDIT_ISSUED` against the capture lines it allocates |
| 017 | L | a net-positive mixed edit bills the `MODIFICATION` slice on one supplementary invoice |
| 018 | L | the `CARD_REFUND` line and the `PaymentRefund` row are written before the provider call |
| 019 | U | contact resolution |
| 020 | L | stepped refunds are stepped `CARD_REFUND` lines; the credit notes render them |
| 021 | L | for Stripe payments the line set is truth; inbound Xero raises, never posts |
| 022, 030–035 | U | soft delete |
| 036 | L | a late capture posts `CARD_CAPTURE`; the task queues the person |
| 037, 038, 039 | U | orchestrator decisions on the late-capture path; the owner has not ruled and this design does not rule for them |
| 040 | L | withdrawal retires instruments and posts nothing (§5.3) |

## 10. Child issues

Each passes the four-question test on its own: one release outcome, safe on
`main` alone, no other child needed for it to be true, no shared-file reason
to bundle.

| # | Title | Ships | Risk |
| --- | --- | --- | --- |
| [#3580](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3580) | `BookingLedgerLine`: expand migration, the write-only Prisma extension, confirmation-time charge posting | a table nothing reads | High (schema) |
| [#3581](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3581) | Settlement lines from payment rows — card capture, bank receipt, cash recorded, card refund, and their reversals — converging where the payment mirror is derived | lines nothing reads | High (money writers touched, no behaviour change) |
| [#3599](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3599) | Settlement lines from account credit (applied, issued, restored) and the hand-back — split from #3581, whose chokepoint never sees them | lines nothing reads | High |
| [#3582](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3582) | Posting from the edit, review-share, rebase and cancellation writers | lines nothing reads | High |
| [#3583](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3583) | The back-post script for every existing booking, and `npm run booking-ledger:census`: the six identities, coverage, the invariant entry, the CI seed run | a dry-run report and a read-only census — **the cut-over gate** | High |
| [#3584](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3584) | Reads switch, one surface per PR: statement, emails, history, reports, officer panel | member-visible figures from the ledger, census-proven equal | High |
| [#3585](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3585) | Xero renderers read ledger slices; `settlementMethod` names the method on every credit note | Xero documents unchanged in content | High |
| [#3586](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/3586) | Contract: drop the six columns; delete the `INV-PAY-047` fences; retire §9's `P` rows | the mirror is gone | Critical |

#3580–#3582 may run as parallel lanes (distinct writers) and compose
**Release 1** with #3583, whose census must be clean over the whole history
before #3584 opens. #3584 and #3585 compose **Release 2**; #3586 is
**Release 3**, on the owner's word. Filed 23 Sep 2026.

## 11. Decisions this design takes, and the ones it leaves to the owner

Taken here, on the evidence above:

- **One table, three sides** (charge / settlement / adjustment), not three
  tables — the balance is one sum and the census one query.
- **The ask is not a line** (§5.3).
- **Account credit stays in `MemberCredit`**; the booking ledger posts the
  booking-side leg and links the row (`INV-PAY-019`).
- **Night rows stay the sold-price authority** until C7, and after it: a
  `GUEST_NIGHT` line is a posting of a night row, so `INV-MOD-028`'s evidence
  discipline is unchanged.

Owner decisions (#3532, 23 Sep 2026):

**D-3532-2 — decided 23 Sep 2026: drop the columns.** C7 removes
`Payment.amountCents`, `creditAppliedCents`, `refundedAmountCents`,
`additionalAmountCents`, `changeFeeCents` and `Booking.finalPriceCents` in the
two-step stop-writing-then-drop sequence, and deletes the fences that existed
to keep them true. A guarded copy is still a copy.

**D-3532-3 — decided 23 Sep 2026: copy the guest names onto the line.**
`guestNames String[]` on `CHARGE` lines, as `ModificationLine.guestNames`
already does, so a document rendered from a line reads the same years later.
The accepted cost is that a name in an immutable row cannot be corrected in
place; a correction is a reversal and a re-post, and `INV-PRIV`'s retention
rules apply to the column as they do to the guest row.

**D-3532-4 — decided 23 Sep 2026: bookings only.**
`MembershipSubscriptionCharge` does not join this ledger; it keeps
`INV-MONEY-008`'s immutable-snapshot rule.

**D-3532-1 — decided 23 Sep 2026: prove against history, then cut over fast.**
No shadow period. Release 1 posts and back-posts, and the census proves the
six identities over every booking ever made; Release 2 moves the reads as soon
as that is clean; Release 3 drops the columns on the owner's word. §7 carries
the reasoning and the two rules that survive the compression.

## 12. Provenance

#3527 (programme), #3272 (provenance and build-up: `INV-MONEY-028`–`031`),
#3530 (stored lines: `INV-MOD-058`), #3531 (exact night prices; the
population C1 back-posts), #3528 (the withdrawable ask), #3529 (the settlement
method on refund documents: `INV-PAY-101`), #2397 (the generalised mirror:
`INV-PAY-047`), #3340 (the second-edit deletion — the bug class §1 names),
#2902 (fictitious refund notes from a mirror read).
