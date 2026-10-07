- **A cash refund on a since-cancelled booking now says "Refunded in cash" in
  Xero (#3935).** When an officer settles a booking-change review and answers
  **In cash** to "How did the club pay the member back?", the Xero credit note
  already read "Refunded in cash". But if the booking had been cancelled after the
  change, the refund went to Xero as the cancellation's refund note, and that
  note ignored the answer and said the money went back by bank transfer.

  That note now carries the same "Refunded in cash" wording, and keeps it if the
  Xero sync is retried. Only the words change: the amount, the account the
  refund is recorded against, and everything the club's books reconcile on are
  exactly as before.
