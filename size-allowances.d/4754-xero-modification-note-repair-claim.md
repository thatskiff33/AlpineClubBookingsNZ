# File-size allowances for #4259

file: src/lib/xero-booking-repair-classify.ts
lines: 2423
reason: the invoice-clearing arm must see the clearing note's own row while a
  retry holds its PARTIAL repair claim (RUNNING), and report it instead of
  queueing the note's whole amount against the primary invoice beside the
  repair's allocations (#4259 review F1). The check has to sit in that arm,
  beside the PARTIAL-row lookup and the queue it guards; it reuses
  `addBlockedClearingAllocationFinding` with a summary override, so the growth
  is the one lookup and one branch. Splitting the per-booking classifier is its
  own job with its own review (see the file's header).
