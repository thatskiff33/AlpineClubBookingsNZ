# File-size allowances for #3199

file: src/lib/xero-booking-repair-classify.ts
lines: 1610
reason: the timing gate is a new arm of the supplementary-invoice branch inside
  `classifyBookingContext`, which this module's own header states is kept whole
  as one sequential function that mutates its local findings/action
  accumulators. Lifting one arm of that chain into another module would hand it
  six pieces of loop-local state as parameters and split a single decision - "is
  this invoice missing, blocked, unsizeable, or already billed by the primary
  invoice" - across two files, which is precisely the shape this file's header
  says it is avoiding. The rule itself, and every word of the reasoning behind
  it, already lives one module away in
  `xero-booking-repair-analysis.ts` (`resolvePrimaryInvoiceEditTiming`); what
  stays here is the branch and the note saying which population it engages on
  and why.
