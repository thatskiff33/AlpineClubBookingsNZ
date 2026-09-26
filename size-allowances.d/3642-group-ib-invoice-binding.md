# File-size allowances for #3642 — a group settlement bound to its invoice

A group settlement waiting on its emailed Internet Banking invoice is bound to
it (`INV-PAY-105`): it is never switched to card, a change to the group replaces
the invoice only once Xero shows no money on it, an abandoned invoice is voided
(or alerted on when it carries money), and a payment settles the group only for
the settlement's own total. The parts that stand alone moved out to their own
modules — the replacement rule (`group-settlement-invoice-replacement.ts`), the
invoice's outbox keys and enqueue (`xero-group-settlement-invoice-outbox.ts`),
its lines (`xero-group-settlement-invoice-lines.ts`), its VOIDs and Xero read
(`xero-group-settlement-invoice-voids.ts`), the operator alert
(`group-settlement-invoice-alerts.ts`) and the organiser's pending-invoice panel
(`pending-group-invoice.tsx`). What remains sits inside the transaction or the
arm it guards.

file: src/lib/group-settlement.ts
lines: 1550
reason: the bound-invoice checks run inside the lock(1) transactions whose
  re-read they depend on — the child-commit, the Internet Banking settle (which
  retires the old invoice and asks for the next attempt), the card attach and
  the paid-invoice and card applies. Moving them out would separate each check
  from the transaction that makes it safe; the rule itself already lives in
  group-settlement-invoice-replacement.ts.

file: src/lib/xero-inbound/invoice-paid-effects.ts
lines: 1823
reason: the paid group invoice arm gains the cash hand-off, the recognition of
  a payment on an abandoned invoice (by its link, with the cancelled-group
  wording) and the card double-payment arm; all read the same fetched invoice
  and cash evidence that arm already classifies. The alert itself moved to
  group-settlement-invoice-alerts.ts.

file: src/lib/cron-group-settlement-reaper.ts
lines: 891
reason: the reaper reads an Internet Banking settlement's invoice in Xero
  before releasing it (keeping and alerting on a group whose invoice has
  started being paid), and its release transaction retires the invoice in the
  same commit, except for a cancelled group. Both belong beside the release they
  decide.

file: src/lib/xero-operation-retry.ts
lines: 1624
reason: the operator's Retry returns a failed group-settlement invoice row
  (CREATE or VOID) to the outbox, rebuilding the CREATE's queued payload; it
  joins the existing outbox-requeue branch beside the applied-credit one, the
  one place Retry decides how a row runs again.
