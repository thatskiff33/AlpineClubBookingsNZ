# File-size allowances for #3268

file: src/lib/cron-confirm-pending.ts
lines: 1773
reason: the terminal-versus-retry decision itself lives in the new module
  `saved-card-charge-failure.ts`; what grows here is the one call site in the
  per-booking catch block that has to run AFTER `releaseChargeClaim` and
  BEFORE today's admin alert, plus the anchor for the soft-decline window,
  which reads the claim's own `previousHoldUntil` and the cron-private
  `resolveOriginalHoldExpiry`. Lifting that catch block out would split the
  release, the classification and the fallback alert across two files, which
  is the ordering a reviewer most needs to see in one place. The fix round
  added the `claimReleased` outcome of `releaseChargeClaim`, read where the
  release happens so the terminal alert never asserts a pending state the row
  is not in.

file: src/lib/payment-transactions.ts
lines: 1170
reason: the saved-card derivation rule (INV-PAY-054, "the ledger never moves a
  saved card") is one conditional inside `reconcilePaymentAggregates`, next to
  the intent-id derivation it deliberately diverges from; lifting one column's
  rule out of the function that derives every other column would hide exactly
  the divergence a reader needs to see.

file: src/lib/email/booking.ts
lines: 1600
reason: the new `saved-card-charge-failed` sender must sit beside
  `sendSetupIntentFailedEmail`, whose context, tokens and lodge identity it
  mirrors line for line; every booking-scoped member sender lives in this one
  module and the suppression inventory names the module as their home.

file: src/lib/email-message-registry.ts
lines: 2054
reason: eight lines of trigger metadata so the operator editor describes when
  the new template fires instead of the generic "Audited application email";
  the metadata map is keyed by template and has no seam to move one entry to.
