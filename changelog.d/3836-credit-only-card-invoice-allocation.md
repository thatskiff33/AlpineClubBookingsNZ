- **A booking paid entirely with account credit no longer shows as owing in
  Xero** (#3836). A card booking covered in full by the member's credit was
  invoiced in Xero at its full price, but the credit was never put against the
  invoice, so Xero showed the whole amount outstanding, aged receivables were
  overstated, and an invoice reminder could ask the member for money they had
  already paid. The member's credit is now allocated against the invoice as soon
  as it is raised, the same way a booking paid partly by card and partly by
  credit already was: a $200 booking paid with $200 of credit shows $0 due in
  Xero (was $200). A later price reduction or cancellation keeps Xero in step.
  For bookings invoiced before this release, the Xero booking repair tool
  (`pnpm run xero:booking-repair`) now reports each one as
  `UNALLOCATED_APPLIED_CREDIT` and, with `--apply`, allocates the credit once;
  cancelled ones are cleared by its existing cancelled-invoice repair. Bank
  transfer bookings are unchanged.
