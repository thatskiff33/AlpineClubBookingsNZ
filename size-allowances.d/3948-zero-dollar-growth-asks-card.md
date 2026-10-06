# File-size allowances for #3502 (PR #3948)

One already-over-budget file grows by three lines. The split was taken first:
the change-fee rule for a late primary invoice, its reasoning and its reads
live in a new module, `src/lib/xero-primary-invoice-change-fee.ts`, and the
fee line itself is the shared `changeFeeLineItem`. What is left is the import,
a one-line pointer and the one call.

file: src/lib/xero-booking-invoices.ts
lines: 1553
reason: the primary invoice must add its change-fee line where it assembles
  its other lines, between the promotion lines and the invoice body, so the
  call cannot move out of `createXeroInvoiceForBooking`. Everything else about
  it already lives in `xero-primary-invoice-change-fee.ts`.
