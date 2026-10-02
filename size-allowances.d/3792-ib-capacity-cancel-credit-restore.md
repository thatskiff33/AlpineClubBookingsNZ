# File-size allowances for #3792

The late internet banking capacity cancel restores the booking's applied
credit inside the claim that cancels it, and the inbound credit-note sync
refuses to credit that booking a second time inside the transaction that holds
the member's credit-ledger lock. Neither can move to a seam outside its
transaction without losing the lock that makes it correct.

file: src/lib/xero-inbound/invoice-paid-effects.ts
lines: 1939
reason: in the late-capacity cancel arm, under the lock(1) and lodge locks it
  already holds, the member credit-ledger lock and the applied-credit
  deallocation fence, then the full restore of the booking's applied credit,
  with its booking event; the restored figure in the member email and the
  admin alert.

file: src/lib/xero-inbound/credit-note-repairs.ts
lines: 1056
reason: the restore-row guard sits at the one write that credits a provider
  de-allocation, under the member credit-ledger lock in the same transaction;
  the refused amounts are collected there and alerted after commit, beside the
  file's other notifyXeroSyncError alerts.
