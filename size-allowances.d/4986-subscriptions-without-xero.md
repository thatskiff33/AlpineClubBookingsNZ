# File-size allowances for #4986

Four already-over-budget files grow by a few lines each. Every addition is the
`INV-INT-039` check placed inside the writer it guards, or one call into a new
shared helper. The shared logic itself went into new, small modules
(`xero-invoicing-guard.ts`, `xero-invoicing-off.ts`), so nothing here is a copy of it.

file: src/app/api/admin/subscription-billing/route.ts
lines: 405
reason: the guard has to run inside `CONFIRM_ANNUAL_BATCH` and `RETRY_CHARGE`
  before the confirm writes its immutable charges, the 409 mapping sits in the
  catch with the route's other error classes, and the GET reports the module
  state plus the count of charges still waiting for Xero, which the panel reads.
  The confirm also answers truthfully when Xero is switched off after its check
  but before its enqueue (the charges are already committed).
  Splitting the route's actions out would change far more than this fix needs.

file: src/lib/nomination.ts
lines: 2510
reason: the joining-fee decision must be read before the approval transaction
  and turned into a recorded SKIP right next to the decision it replaces. The
  approval warnings are assembled in this function, so they live here too.

file: src/lib/membership-subscription-billing.ts
lines: 2736
reason: `queueApprovedMembershipSubscriptionCharges` must return before it
  freezes a charge, so the early return and its result flag belong inside it.
  That is the seam M7 (#4519) replaces. The preview's read-only Xero-off option
  has to sit on the mapping check it skips.

file: src/lib/xero-operation-retry.ts
lines: 2244
reason: the subscription branch of the generic retry refuses in place, beside
  the requeue it stops. Two imports and a five-line check.
