# File-size allowances for ALP-675 (#5208)

file: src/lib/xero-booking-invoices.ts
lines: 1580
reason: the primary invoice's create and update each gain one call to the GST
  safeguard right after Xero answers, and the create reads the pause and sends
  the plan's lines where it already plans them. The safeguard itself lives in
  xero-tax-override-safeguard.ts; the call has to sit where the request and
  Xero's reply are both in hand.

function: src/lib/xero-booking-invoices.ts#createXeroInvoiceForBooking
lines: 965
reason: the same create-side call and pause read as above, inside the one
  function that holds both the lines sent and the invoice Xero returned.
  Splitting it is #4525's rendering work, not this change's.

file: src/lib/stuck-state-dashboard.ts
lines: 1096
reason: the Finance dashboard gains its GST-overrides-paused item beside the
  other Xero items, in the one list of dashboard items; its sentence comes
  from the safeguard module.
