# File-size allowances for #4627 (Ledger M3b)

Each door resolves the member-money journal's posting context before its
transaction (`INV-LOCK-004`) and threads it to the legacy chokepoint it already
calls. The few lines each needs sit beside the pre-transaction reads they
join; splitting these modules would separate a read from the transaction it
serves, which is the hazard the rule exists to prevent.

file: src/lib/booking-cancel.ts
lines: 2863
reason: every cancel branch passes the journal's posting context, resolved once on the cancellation's own club zone, to the cancellation poster inside its lock(1) claim.

file: src/lib/booking-guest-removal-service.ts
lines: 1252
reason: the removal takes the journal's posting context from its caller, like its club day and format, and passes it to the modification and confirmation posters.

file: src/lib/group-cancel.ts
lines: 1071
reason: the organiser cancel resolves the journal's posting context before its per-child claims and passes it to each child's cancellation lines.

file: src/lib/member-guest-consent-service.ts
lines: 1407
reason: both consent doors resolve the journal's posting context on the zone they already read and thread it to the removal and reprice they run under lock(1).

file: src/lib/member-merge.ts
lines: 3140
reason: D4's transfer must run inside the merge transaction, after the owner move and the Member FOR UPDATE set, and the merge must refuse before it while the journal is inactive; moving either to another module would hide that ordering, which is the point.

file: src/lib/payment-reconciliation.ts
lines: 2839
reason: the one settlement body takes the journal's posting context from its two callers, which resolve it before their transactions, for the confirmation and capacity-void posters.

