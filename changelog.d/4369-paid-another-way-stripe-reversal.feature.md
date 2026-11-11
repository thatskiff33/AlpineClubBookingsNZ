- **Closing a failed card refund as paid another way now records the money back
  in Stripe as well as the bank payment (#4369).** When Stripe had accepted a
  card refund and then failed it, Xero still showed that money leaving the
  Stripe account. Paying the member by bank and closing the row as Paid
  another way, while that old card note covered the amount, queued no bank
  document for the transfer.

  Closing now queues two documents: an invoice for the amount the card note
  covered, recording that money back in the Stripe account, and a
  bank-transfer refund credit note for the full amount paid back. Paying back
  less than the card note still leaves the difference on the Xero
  reconciliation report. A close the card note does not cover is unchanged.

  A close already taken by a previous release is unchanged, and there is no
  automatic backfill. After this release has taken a covered close, do not
  roll back to a release that does not know this invoice: that release will
  still send the bank note and leave the invoice waiting, so Xero shows both
  the old card note and the bank note until this release sends the invoice.
