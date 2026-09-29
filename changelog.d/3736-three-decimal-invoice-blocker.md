- **A tiny balance on a Xero invoice in a three-decimal currency now blocks a
  membership cancellation, and is shown to the fils (#3724).** The unpaid-invoice
  check used to round Xero's amount to cents first, so KWD 0.004 read as nothing
  owing and the approval could archive a contact with money still on it, and
  KWD 1.234 was shown as "KWD 1.23". It now decides from Xero's own figure and
  shows "KWD 1.234". Invoices in NZD and other currencies with cents are
  unchanged.
