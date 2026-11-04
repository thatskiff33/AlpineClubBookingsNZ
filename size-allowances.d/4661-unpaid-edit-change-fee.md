# File-size allowances for #4661

file: src/lib/booking-batch-modification-service.ts
lines: 2761
reason: the batch edit's history row carries the fee marker beside the
  #3980 primary-invoice marker it already writes, and its lifecycle step
  reads the fee the settlement recorded; both are one-line additions at the
  existing call sites, and a split would move the history row away from its
  sibling markers.

file: src/lib/booking-date-modification-service.ts
lines: 2264
reason: the date edit's history row carries the same fee marker beside its
  existing markers, and its credit clamp adds the fee the settlement just
  recorded; both lines sit in the existing write and clamp, and there is no
  seam to split them out without separating them from the code they extend.
