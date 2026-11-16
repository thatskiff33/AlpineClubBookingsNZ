# File-size allowances for #4986

One already-over-budget file grows. The `INV-INT-040` check sits inside the
writer it guards, and the shared logic itself went into new, small modules
(`xero-invoicing-guard.ts`, `xero-invoicing-off.ts`), so nothing here is a copy of it.

The other three files #4986 touched (`src/lib/nomination.ts`,
`src/lib/membership-subscription-billing.ts` and `src/lib/xero-operation-retry.ts`)
were already past the hard ceiling of three times their budget on `origin/main`
(#4926), where a file may only stay the same length or shrink. Each had a
cohesive part moved out verbatim into a sibling module instead, so they end
shorter than on `origin/main` and need no allowance.

file: src/app/api/admin/subscription-billing/route.ts
lines: 405
reason: the guard has to run inside `CONFIRM_ANNUAL_BATCH` and `RETRY_CHARGE`
  before the confirm writes its immutable charges, the 409 mapping sits in the
  catch with the route's other error classes, and the GET reports the module
  state plus the count of charges still waiting for Xero, which the panel reads.
  The confirm also answers truthfully when Xero is switched off after its check
  but before its enqueue (the charges are already committed).
  Splitting the route's actions out would change far more than this fix needs.
