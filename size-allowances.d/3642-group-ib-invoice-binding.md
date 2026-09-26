# File-size allowances for #3642 — a group settlement bound to its invoice

A group settlement waiting on its emailed Internet Banking invoice is now bound
to it (`INV-PAY-106`): it is not re-sized or switched to card, an invoice it
abandons is voided, and a paid invoice settles the group only for the
settlement's own total. Each rule lands on the writer that already owns the
settlement state it guards. The new VOID handlers moved out to
`xero-group-settlement-invoice-voids.ts`, which keeps
`xero-group-settlement-invoices.ts` inside its budget.

file: src/lib/group-settlement.ts
lines: 1510
reason: the refusal, the abandon-before-replace step and the in-lock cash
  check each sit inside the lock(1) transaction whose re-read they depend on
  (the child-commit, the Internet Banking settle, the card attach and the
  paid-invoice apply). Moving them out would separate each check from the
  transaction that makes it safe; the pure part of the rule already lives in
  group-settlement-invoice-binding.ts.

file: src/lib/xero-inbound/invoice-paid-effects.ts
lines: 1872
reason: the paid group invoice arm gains the cash hand-off, the alerts for a
  short payment, a card double payment and a payment on an abandoned invoice,
  and their cooldown; all read the same fetched invoice and cash evidence that
  arm already classifies, beside its existing mismatch and cancellation alerts.

file: src/lib/cron-group-settlement-reaper.ts
lines: 799
reason: the release transaction retires the settlement's invoice in the same
  commit that releases it; a separate pass would reopen the window the issue
  closes.

file: src/lib/xero-operation-outbox.ts
lines: 3311
reason: the existing GROUP_SETTLEMENT_INVOICE_VOID dispatch arm routes a
  payload that names its invoice to the abandon handler; the queue type is
  otherwise unchanged.
