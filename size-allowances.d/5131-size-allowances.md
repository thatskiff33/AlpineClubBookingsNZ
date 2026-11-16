# Size allowances for #5131

function: src/lib/xero-booking-invoices.ts#createXeroInvoiceForBooking
lines: 947
reason: records the primary booking invoice export manifest; those lines sit
  inside the function `createXeroInvoiceForBooking`, which was already over
  its limit before this change, and lifting it apart is a refactor of its own,
  not part of this fix.
