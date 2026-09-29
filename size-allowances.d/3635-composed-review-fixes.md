# File-size allowances for #3635 (composed-tree review fixes)

file: src/lib/admin-bookings-service.ts
lines: 1439
reason: the booking list's "invoice expected" test called a hand-written
  captured-status triple; it now asks `isXeroInvoiceExpectedPaymentStatus`,
  the one home of that question, which costs one import line. The
  captured-status guard found the copy.
