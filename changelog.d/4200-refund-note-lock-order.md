- **A refund note voided in Xero no longer risks losing the record of a new
  refund note raised on the same payment at the same moment (#4200).** The
  two updates could lock the payment and its Xero link in opposite orders, and
  the database would cancel one of them. They now lock the payment first and
  the link second, so both finish.
