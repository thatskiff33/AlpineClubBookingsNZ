- **Two kinds of booking-change credit note no longer say "bank transfer" when none happened (#3536).**
  When a booking change lowered an invoice nobody had paid yet, the credit note
  raised in Xero read "Refund requested via internet banking", even though
  nothing was refunded. It now reads "Invoice correction — nothing refunded".
  And when an officer handed a booking-change refund back in cash, the note
  also read as an internet-banking refund; it now reads "Refunded in cash".

  Only the words changed. The notes are still applied to the same invoice, no
  payment is recorded against any bank account, and no amount moved. The credit
  note for stored credit spent on a booking and the membership cancellation
  credit note keep the wordings they had. A note that fails and is retried says
  the same thing as the first attempt; notes already queued keep their old
  wording.
