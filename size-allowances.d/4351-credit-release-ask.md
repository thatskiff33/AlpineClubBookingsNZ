# File-size allowances for #4253

Every new rule of the released-credit request lives in its own new module
(`credit-release-*.ts`, `xero-invoice-balance.ts`), and the two files that could
not grow at all, `payment-recovery-keys.ts` and `additional-payment-ask.ts`, were
kept at their ceiling by moving the key family and the sizing there. The four
files below grow by the unavoidable registration line count of a new cron job, a
new email message and the runner's single hook.

file: src/lib/payment-recovery.ts
lines: 3374
reason: the runner's branch is one early fork at the top of
  `processCreateAdditionalPaymentIntentOperation` plus its import; the rest is in
  `credit-release-ask.ts`. The fork must sit inside the function that claims the
  row, before the ordinary replay derives its inputs from a `BookingModification`
  this request does not have.

file: src/lib/admin-cron-health.ts
lines: 927
reason: one `defineCronJob` entry for the new `credit-release-asks` job, which the
  health page reads from this registry; the job's own logic is in its own module.

file: src/lib/email-message-registry.ts
lines: 2384
reason: a new message's required tokens and its trigger metadata are entries in
  the two tables that define every message, and a message not in them is
  rejected by the registry's own census.

file: src/lib/email/booking.ts
lines: 1821
reason: the payment-request sender chooses between two wordings by the request's
  cause. A second sender would duplicate the 60-minute stamp and cooldown handling
  that the cron and the manual re-send both rely on being in one place.
