# File-size allowances for #3792

The late internet banking capacity cancel restores the booking's applied
credit inside the claim that cancels it, and the inbound credit-note sync
refuses to credit that booking a second time inside the transaction that holds
the member's credit-ledger lock. Neither can move to a seam outside its
transaction without losing the lock that makes it correct.

file: src/lib/xero-inbound/invoice-paid-effects.ts
lines: 1941
reason: in the late-capacity cancel arm, under the lock(1) and lodge locks it
  already holds, the member credit-ledger lock and the applied-credit
  deallocation fence, then the full restore of the booking's applied credit,
  with its booking event; the restored figure in the member email and the
  admin alert, and the "restored in full" basis it passes the email.

file: src/lib/xero-inbound/credit-note-repairs.ts
lines: 1127
reason: the restore-row guard reads under the member credit-ledger lock in the
  same transaction and refuses both BOOKING_APPLIED writes a provider change
  can make (the reconciliation offset, either direction, and the fresh applied
  row); the refused changes are alerted after commit beside the file's other
  notifyXeroSyncError alerts, and recorded as a deduped critical audit row by
  a small helper here, because the alert email is throttled across all Xero
  error types and the record belongs with the decision that makes it.

file: src/lib/email/booking.ts
lines: 1756
reason: sendBookingCancelledEmail takes and passes on the restored-credit basis
  (by policy, or in full for a cancel the member did not choose), and its
  override-body message uses the template's shared sentence for it.

file: src/lib/member-credit.ts
lines: 1038
reason: restoreCreditFromBooking takes the member credit-ledger lock before its
  read when it joins a transaction, so a restore in flight excludes the inbound
  credit-note sync; it has to sit inside the one function every restore path
  calls, ahead of the read it protects.
