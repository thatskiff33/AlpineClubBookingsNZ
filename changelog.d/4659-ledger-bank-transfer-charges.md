- **A bank-transfer booking's charge now posts to the member-money journal when
  its invoice is issued, not when it is paid (Ledger M3c, #4628).** A booking
  made to be paid by internet banking (by a member, an officer on their behalf,
  or a group joiner who pays their own way), a switch to internet banking, a
  school request's pay-on-account approval, and a member whole-lodge request's
  pay-on-account approval (when the Xero and internet-banking modules are not
  both on) post the booking's charge into the built-in journal
  straight away, priced exactly as the booking's confirmation will later price
  it. Edits and cancellations before payment adjust that charge. When the
  payment is recorded (marked paid, or Xero reports the invoice paid), the
  booking-ledger lines it writes are linked to the charge already posted, so
  nothing is charged twice. A Xero "invoice paid" receipt now also writes the
  booking's confirmation lines on the booking ledger, as recording the payment
  by hand already did. Nothing reads the journal yet, so no screen, email,
  invoice or Xero document changes. `pnpm run booking-ledger:census` gains a
  `JOURNAL_PENDING` check comparing a bank-transfer booking's pending charge with
  its final price plus its recorded fees.
