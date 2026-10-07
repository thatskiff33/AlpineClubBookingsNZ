# File-size allowances for #3750

Approving a locked-period change request on a finished stay executes it
through the canonical batch edit, under one service argument. The executor, its
fee rule, its call guard and the officer's decision handling live in new modules
(`booking-change-request-execution.ts`, `booking-finished-stay-correction.ts`,
`booking-change-request-admin-decision.ts`); only the lines that must sit at the
decision points they change are added to the two files below.

file: src/lib/booking-batch-modification-service.ts
lines: 2873
reason: the finished-stay mode changes four decisions inside the one
  transaction - the edit-policy window, the capacity confirm, the change fee and
  refund tier day (including a swap's same-day fee on the removed portion,
  settled once), and the Xero lock-date envelope - each at the line that
  already makes that decision for every other edit. Moving them out would put
  the rule and its exception in different files, which is how a second pricing
  home starts; the guard and the fee rule themselves already live in
  booking-finished-stay-correction.ts.

file: src/lib/booking-modify-plan.ts
lines: 3270
reason: the no-active-season refusal sentence becomes one exported constant
  the two throw sites use, so the finished-stay approval can recognise it
  without matching the sentence by hand (INV-SSOT-001). The constant belongs
  beside the throws that raise it.
