# File-size allowances for #4627 (Ledger M3b)

Each door resolves the member-money journal's posting context before its
transaction (`INV-LOCK-004`) and threads it to the legacy chokepoint it already
calls. The few lines each needs sit beside the pre-transaction reads they
join; splitting these modules would separate a read from the transaction it
serves, which is the hazard the rule exists to prevent.

file: src/app/api/bookings/[id]/guests/[guestId]/route.ts
lines: 545
reason: the guest-removal door resolves the journal's posting context beside its other pre-transaction reads and hands it in; the read belongs next to the transaction it serves.

file: src/app/api/bookings/[id]/guests/route.ts
lines: 1601
reason: the guest-add door resolves the journal's posting context beside its other pre-transaction reads and passes it to the modification poster in its transaction.

file: src/lib/booking-batch-modification-service.ts
lines: 2752
reason: the journal's posting context joins the one pre-transaction preparation this module allows (prepareBookingBatchModification), so it covers both the owned and the caller transaction.

file: src/lib/booking-cancel.ts
lines: 2869
reason: every cancel branch passes the journal's posting context, resolved once on the cancellation's own club zone, to the cancellation poster inside its lock(1) claim.

file: src/lib/booking-date-modification-service.ts
lines: 2262
reason: both date-edit doors resolve the journal's posting context beside their club day and format and pass it to the posters in their transactions.

file: src/lib/booking-guest-removal-service.ts
lines: 1252
reason: the removal takes the journal's posting context from its caller, like its club day and format, and passes it to the modification and confirmation posters.

file: src/lib/cron-confirm-pending.ts
lines: 2039
reason: the cron resolves the journal's posting context once per run on the zone it already reads, and the lock-bound hold resolver passes it to its three cancellation posters.

file: src/lib/group-cancel.ts
lines: 1071
reason: the organiser cancel resolves the journal's posting context before its per-child claims and passes it to each child's cancellation lines.

file: src/lib/group-settlement.ts
lines: 1669
reason: the group settle resolves the journal's posting context outside its lock, beside its club day, for the children's confirmation lines.

file: src/lib/member-guest-consent-service.ts
lines: 1407
reason: both consent doors resolve the journal's posting context on the zone they already read and thread it to the removal and reprice they run under lock(1).

file: src/lib/member-merge.ts
lines: 3134
reason: D4's transfer must run inside the merge transaction, after the owner move and the Member FOR UPDATE set; moving it to another module would hide that ordering, which is the point.

file: src/lib/payment-reconciliation.ts
lines: 2839
reason: the one settlement body takes the journal's posting context from its two callers, which resolve it before their transactions, for the confirmation and capacity-void posters.

file: src/lib/school-booking-request.ts
lines: 3223
reason: the whole-lodge approval resolves the journal's posting context on the zone it already reads, for its credit-settled confirmation.

file: src/lib/xero-inbound/invoice-paid-effects.ts
lines: 2081
reason: the inbound reconcile resolves the journal's posting context before its per-payment transactions, for the late capacity cancel's lines.
