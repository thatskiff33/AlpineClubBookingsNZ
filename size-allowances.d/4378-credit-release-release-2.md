# File-size allowances for #4378 (#4253 release 2)

Every new rule lives in its own module (`additional-ask-cause.ts`,
`credit-release-bank-transfer.ts`, the cadence in the chase module); the reminder
cron was kept under its budget by moving the finished-stay narrowing, the pre-claim
reminder gate and the reachability check out. The
files below grow by the registration of two email tokens (one optional, one
required) and the sender's choice between wordings.

file: src/lib/email-message-registry.ts
lines: 2401
reason: the new optional `bankTransferNote` token and the required `askCauseSentence`
  token are entries in the registry's approved-token list, its required-token table and
  its sample resolver, and the released-credit cadence line is built from its constants;
  a token not in them is rejected by the registry's own census.

file: src/lib/email-message-token-contract.ts
lines: 726
reason: the token contract table is where optional tokens are declared; one entry
  for the same token.

file: src/lib/email/booking.ts
lines: 1844
reason: the payment-request sender picks the wording, the `{{askCauseSentence}}` value
  and the pre-resolved bank-transfer offer by the request's cause. A second sender would duplicate the 60-minute stamp and
  cooldown handling that the cron and the manual re-send rely on being in one place.

file: src/lib/email-message-renderer.ts
lines: 961
reason: the required-token guidance table is keyed by token for every template; the new
  required `{{askCauseSentence}}` needs its plain-English line beside the others, or an admin
  whose save is refused is told only a token name.

file: src/lib/payment-recovery.ts
lines: 3534
reason: a released-credit request blocked by an unpaid edit request must wait without
  spending its attempts (`waitPaymentRecoveryOperation`). The wait goes through the one
  failure chokepoint, `markPaymentRecoveryOperationFailed`, which is private to this module
  and pinned there by the terminal-failure census; a second module writing the row would be
  the second route to FAILED that census exists to refuse. The insert-once variant of the
  additional-intent row (`createAdditionalPaymentIntentRecoveryOnce`) shares the row builder
  with the existing upsert here, so the row has one shape. The dispatcher reports a wait as its
  own outcome so the run counts it as a retry, not a completion.
