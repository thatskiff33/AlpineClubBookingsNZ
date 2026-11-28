# Size allowances for #5288 (an unlinked Internet Banking increase is asked for)

Each edit door carries one more settlement flag, `primaryInvoiceBillsIncrease`,
from `applyPaymentAdjustments` to its Xero leg. The rule itself lives in its own
module (`primary-invoice-bills-increase.ts`); what remains here is the field the
guest-acceptance re-price passes on.

function: src/lib/booking-guest-acceptance-reprice.ts#repriceBookingAfterGuestAcceptance
lines: 358
reason: carries the new flag on the re-price result and its unmoved early
  return, so the acceptance door's Xero leg asks the same rule as every other
  door; the function was already over its limit, and lifting it apart is a
  refactor of its own.
