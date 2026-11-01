- **A bank refund recorded with "Paid another way" no longer disappears from the refunded total when a late card refund fails (#4280).**
  When the treasurer closed a card refund as paid another way, and the card
  refund Stripe had lost then turned up late and later failed, the app took
  the whole failed refund off the payment's refunded total. The bank refund
  still stood, but the total could fall to nothing, so the booking showed that
  money as kept and as refundable again. The total now never falls below the
  bank money "Paid another way" closes recorded: the full amount, or for a part
  close what was actually paid.

  Only these closes count. Card and capacity refund shortfalls paid back by
  bank are outside this repair (the owner's decision of 26 October; a voided
  refund note never undoes them). Ordinary bank hand-backs are not counted,
  because a voided refund note can undo one while its task still reads
  completed.

  Known limits. On a payment with more than one charge, bank money from a
  shortfall or hand-back on another charge is not protected: for example, a
  $200 card charge closed as paid another way beside a $100 shortfall paid
  back on a second charge can still drop to $100 when the late card refund
  fails, and the audit below does not see it (#4488). Account credit the app
  over-counts on some old bookings can keep a total slightly too high, which
  errs on the safe side.

  Payments a failure already took below a close's bank money are not changed
  automatically. The read-only `pnpm run payments:audit-refunded-total` report
  now lists them, with the bank money it counted, for the treasurer to review.
  Rolling the app back to an earlier version brings the old behaviour back.
