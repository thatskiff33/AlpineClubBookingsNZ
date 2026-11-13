- **Closing a failed card refund as Paid another way now puts the card money
  back in the Stripe account in Xero (#4369).** When Stripe accepted a card
  refund and then failed it, the card refund credit note raised at the time
  stayed in Xero and said the money had left the Stripe account. Closing that
  refund as Paid another way used to shrink or skip the bank-transfer note to
  avoid crediting the member twice, so Xero never showed the bank payment in
  full and the Stripe account stayed understated.

  The close now records two documents in Xero. An invoice for the part the old
  card note still covers, paid into the Stripe bank account, records that
  money back in Stripe. A bank-transfer refund credit note records the whole
  amount the club paid back. A close with no old card note behind it records
  only the bank-transfer note, as before.

  The invoice is never emailed to the member and is not the booking's bill.
  If an officer voids it in Xero, the app stops counting it and does not raise
  it again. A second close on the same payment sizes its invoice the same way
  whichever document reached Xero first.
