- **An expired internet-banking hold now closes the booking's unpaid Xero
  invoice, instead of leaving it open beside a "refund" (#3535).** When an
  internet-banking booking's payment hold ran out, the booking's still-unpaid
  invoice was answered with a refund credit note reading "Refund requested via
  internet banking" — for money nobody had paid — and that note was not
  applied to the invoice, so the treasurer found an open invoice and a
  floating credit note to match up by hand. It now gets the same note a
  cancelled unpaid booking already gets: applied straight against the invoice,
  so the invoice closes, with no payment recorded against any bank account,
  and worded "Invoice cleared - booking not paid". Holds that expired before
  this change are left as they are.
