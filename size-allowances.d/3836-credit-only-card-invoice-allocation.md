# File-size allowances for #3836

A card-path booking paid wholly or partly by account credit has that credit
allocated against its Xero invoice, and the app keeps the credit actually
applied (the ledger's figure) rather than clamping it to the card amount, so a
later cancellation restores what was really applied.

file: src/lib/booking-cancel.ts
lines: 2784
reason: the cancel reads the ledger-derived applied credit
  (`cancelTieredAppliedCreditCents`) before it tiers the restore; the rule lives
  in `booking-payment-state.ts`, and what stays here is the call inside the
  claim that already owns the restore.

file: src/lib/xero-booking-repair-classify.ts
lines: 2301
reason: two lines, the import and the call of the unallocated-credit arm,
  whose rules live in `xero-booking-repair-applied-credit.ts`.

file: src/lib/xero-inbound/credit-note-repairs.ts
lines: 1144
reason: the inbound fold writes the applied-credit mirror as the ledger's
  figure, uncapped, where the card-amount cap was; the reader lives in
  `xero-applied-credit-ledger-state.ts`.
