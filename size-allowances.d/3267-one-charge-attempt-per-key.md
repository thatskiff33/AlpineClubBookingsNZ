# File-size allowances for #3267 (one saved-card charge attempt per Stripe key)

The attempt contract itself went into three NEW modules, all inside budget,
split where the provider call is: src/lib/saved-card-charge-attempt.ts (what an
attempt is, and beginning one inside the caller's claim transaction),
src/lib/saved-card-charge-request.ts (asking Stripe, with no lock held) and
src/lib/saved-card-charge-settle.ts (recording the answer). Four
already-over-budget files grow here because each is a CALL SITE of that
contract, and the calls have to sit inside the claim transaction, the release
transaction or the reconcile those files already own.

file: src/lib/cron-confirm-pending.ts
lines: 1977
reason: the one call inside the claim transaction that mints the attempt row
  under both locks, the SavedCardChargeRefusedError branch of the per-booking
  catch, the #1992 sweep exclusion moving from two reason literals to the shared
  key prefix plus the by-id exclusion of the row this run is replaying, the
  locked release now recording Stripe's answer before it re-reads the booking
  and branching on the LEDGER status rather than the intent's, the capped
  admin-alert cadence for a refusal, and the comments saying why each of those
  sits exactly where it does. Lifting the claim or the catch out would split the
  lock order, the release and the #3268 classification across two files, which
  is the ordering a reviewer most needs to see in one place. This one entry also
  carries #3268's terminal-branch growth in the same file (the unusable-card
  classification and escalation that runs after the release commits), because
  one path gets one allowance. The second fix round adds the shared
  charge-due-date helper the refusal cadence and the soft-decline window count
  both anchor on, and splits the release fence's signal so a claim lost to
  anyone but the settling webhook is an error and a failed booking rather than
  a warning.

file: src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts
lines: 910
reason: the claim transaction gains the attempt-row mint, the post-lock re-read
  of the card columns (own row and split parent) so the card CHARGED is the one
  under the locks, and a typed catch for SavedCardChargeRefusedError (alert,
  audit, 409); the charge and its record sites move onto the shared attempt
  contract, the non-captured record moves INSIDE the locked release, which now
  re-reads the booking's status before releasing, and the 502 and 409 bodies say
  what Stripe actually answered. What remains here is the call sites and the
  comments at each saying why the shared key is gone. This one entry also
  carries #3269's growth in the same file (the shared parent-card predicate and
  the parent row the claim reads), because one path gets one allowance.

file: src/app/api/payments/charge-saved-method/route.ts
lines: 638
reason: the route gains the claim shape the cron and confirm-pending-guests
  already have (global lock, lodge lock, post-lock capacity re-check, post-lock
  card re-read, status-guarded PENDING to CONFIRMED claim, bed reconcile, the
  #2576 hosting seam, the attempt row) and a locked release for a charge that
  does not capture — one that records Stripe's answer and re-reads the booking
  before handing the claim back — because the ledger guard that replaced the
  shared Stripe key only holds if every path writes its attempt under the same
  locks. Until #3267 this route charged with no claim at all. The two
  transactions mirror the admin route's line for line so a reader can diff them;
  extracting a shared claim helper across three money paths is a refactor of its
  own, not this fix. This one entry also carries #3269's growth in the same file
  (the shared saved-card predicate this route reads twice), because one path
  gets one allowance.

  The second fix round adds the post-lock amount to this route's operator
  alerts. Declaring it because it WIDENED the first fix round's item, which
  asked only that the CARD be re-read under the locks: the charge itself had
  already moved to the claim's post-lock `finalPriceCents`, so leaving the
  alerts on the pre-lock snapshot would have had them name a figure nobody was
  ever charged. Moving the charged amount post-lock is the more correct
  reading of "charge what the locks say", and it is stated here rather than
  left silent.

file: src/lib/payment-transactions.ts
lines: 1169
reason: ten lines, nine of them comment, on the one derivation that reads a
  Payment's aggregate from its latest PRIMARY row. An attempt row is a Stripe
  PRIMARY row born with NO intent id, so while it is the latest, the derivation
  would null Payment.stripePaymentIntentId and send /pay and
  create-payment-intent back to the `_initial` idempotency key — which Stripe
  answers with the cancelled first intent, a dead client secret. The fix is
  `?? payment.stripePaymentIntentId` on that one expression, the same rule #3268
  applies to the card column three lines below it; both belong in the module
  that owns the derivation, and neither is separable from it.
