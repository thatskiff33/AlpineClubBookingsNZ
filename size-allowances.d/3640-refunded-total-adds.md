# File-size allowances for #3640 — a card refund adds to the refunded total

Every Stripe card refund now reaches a transaction's `refundedAmountCents`
through one writer, `recordStripeRefundsAgainstTransaction`, which adds only
the refund it newly recorded, through a compare-and-set, in one transaction
with the ledger rows. The superseded-payment recovery's own copy of the old
formula moved into it, so `payment-recovery.ts` shrinks by the same logic.

file: src/lib/payment-transactions.ts
lines: 1506
reason: the writer belongs beside the ledger insert whose "newly recorded"
  answer it keys on, the refund-status helper it sets and the two callers it
  serves (the inline refund and the charge.refunded sync); moving it out would
  split the one formula for the refunded total from the rows it is derived
  from, which is the drift #3640 exists to end (INV-SSOT). The shared
  compare-and-set loop, the fixed ledger start, the failed-refund reversal,
  the #1491 fold and the account-credit allocation all write the column
  through that one loop, so they sit with it.
  The delta review added the Payment-first lock every writer takes and the
  floor on a failed refund's subtraction, both part of that one writer.

booking-cancel.ts is declared once for the epic, in
`3535-ib-hold-expiry-clearing-note.md`; this lane's share is recorded there.
