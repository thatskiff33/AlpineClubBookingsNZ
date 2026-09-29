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
arm it guards. The growth of `xero-inbound/invoice-paid-effects.ts` and
`xero-operation-retry.ts` is declared in the #3535 fragment (one allowance per
file across the epic).

file: src/lib/group-settlement.ts
lines: 1645
reason: the bound-invoice checks run inside the lock(1) transactions whose
  re-read they depend on — the child-commit, the Internet Banking settle (which
  retires the old invoice and asks for the next attempt), the card attach and
  the paid-invoice and card applies. Moving them out would separate each check
  from the transaction that makes it safe; the rule itself already lives in
  group-settlement-invoice-replacement.ts.
  Re-measured at the #3635 main sync, composed with main's #3567 currency refusal.
  The #3635 sync fix reads any outstanding settlement intent before the lock and
  refuses one still `processing`, whatever the total or currency, as the two
  card doors do, so a group cannot be charged twice. #3672 (same epic) adds its
  share: the paid apply switches the joiners its bill missed to member-pays
  inside the same lock(1) transaction that marks the settlement paid, and hands
  them to the notice after commit, or, for a joiner whose stay has started, to
  the treasurer's once-per-group alert; the rule, the switch, the notice and the
  alert live in group-late-joiner.ts. Its three replay guards each carry one
  line saying why they stay SUCCEEDED-only rather than the shared "organiser
  has paid" predicate.

file: src/lib/cron-group-settlement-reaper.ts
lines: 1046
reason: the reaper reads an Internet Banking settlement's invoice in Xero
  before releasing it: it keeps and alerts on a group whose invoice has started
  being paid, holds (with an alert, for up to seven days) one Xero
  cannot show, and releases one Xero does not have. Its release transaction
  retires the invoice in the same commit, except for a cancelled group. Each
  rule decides the release it sits beside. #3672 (same epic) adds its share: the
  run calls the paid-group self-heal and reports how many joiners it moved
  and how many it left for the treasurer because the stay has started; the heal itself lives in group-late-joiner.ts.
  #3635 (same epic, composed review C5): a group whose stay has started is
  kept, counted and alerted once, at each arm that would otherwise release it
  (unreadable, missing in Xero, unpaid), beside the bound it replaces;
  the bound is one constant in `unreadable-invoice-hold-bound.ts` and the alert
  lives in `group-settlement-invoice-alerts.ts`.
