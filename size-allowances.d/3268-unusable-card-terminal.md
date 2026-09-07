# File-size allowances for #3268

The cron's growth is declared in `size-allowances.d/3267-one-charge-attempt-per-key.md`
(one allowance per path across the epic; #3267 grows the same file further and
carries this lane's reason too: the terminal branch of the charge arm).

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
