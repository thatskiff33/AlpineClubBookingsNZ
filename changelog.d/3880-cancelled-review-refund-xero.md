- **A review's refund on an already-cancelled booking now reaches Xero**
  (#3880). When a financial review was completed after its booking had been
  cancelled, and money went back to the member by card refund or by
  bank-transfer hand-back, no Xero document recorded it, so the Stripe payout
  or the bank transfer had nothing in Xero to match. That refund now raises the
  same document the cancellation's own card refund raises: a credit note in the
  member's name for exactly what the review sent back (for example $25 of a
  $50 share at 50% less a $20 fee), refunded from the card clearing account or
  the bank-transfer refund account and worded "Refund against original credit
  card" or "Refund requested via internet banking". The cancelled invoice is
  left exactly as the cancellation left it. Two reviews of one booking raise a
  note each, and a repeated attempt raises none twice. Any part given back as
  account credit raises no document now, as the cancellation's own restored
  credit does not: Xero records it when the member spends it.
