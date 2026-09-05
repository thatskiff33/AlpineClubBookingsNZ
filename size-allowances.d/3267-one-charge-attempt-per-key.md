# File-size allowances for #3267 (one saved-card charge attempt per Stripe key)

The attempt contract itself went into two NEW modules, both inside budget:
src/lib/saved-card-charge-attempt.ts (what an attempt is, beginning one under
the claim's locks, asking Stripe) and src/lib/saved-card-charge-settle.ts
(recording the answer). Three already-over-budget files grow here because each
is a CALL SITE of that contract, and the calls have to sit inside the claim
transaction and the release transaction those files already own.

file: src/lib/cron-confirm-pending.ts
lines: 1819
reason: the one call inside the claim transaction that mints the attempt row
  under both locks, the SavedCardChargeRefusedError branch of the per-booking
  catch, the #1992 sweep exclusion moving from two reason literals to the shared
  key prefix, and the comments saying why each of those sits exactly where it
  does. Lifting the claim or the catch out would split the lock order, the
  release and the #3268 classification across two files, which is the ordering
  a reviewer most needs to see in one place.

file: src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts
lines: 821
reason: the claim transaction gains the attempt-row mint, the claim call gains
  a typed catch for SavedCardChargeRefusedError (alert, audit, 409), the charge
  and its two record sites move onto the shared attempt contract, and the 502
  and 409 bodies now say what Stripe actually answered. What remains here is
  the call sites and the comments at each saying why the shared key is gone.

file: src/app/api/payments/charge-saved-method/route.ts
lines: 564
reason: the route gains the claim shape the cron and confirm-pending-guests
  already have (global lock, lodge lock, post-lock capacity re-check,
  status-guarded PENDING to CONFIRMED claim, bed reconcile, the #2576 hosting
  seam, the attempt row) and a locked release for a charge that does not
  capture, because the ledger guard that replaced the shared Stripe key only
  holds if every path writes its attempt under the same locks. Until #3267
  this route charged with no claim at all. The two transactions mirror the
  admin route's line for line so a reader can diff them; extracting a shared
  claim helper across three money paths is a refactor of its own, not this fix.
