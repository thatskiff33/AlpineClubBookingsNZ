- **A booking now says when its Xero invoice has failed, instead of looking
  perfectly normal (#3001).** A booking could sit confirmed, with payment still
  pending, while the Xero operation that should have raised its invoice had
  already failed. The only evidence lived several clicks away under
  **Admin -> Xero -> Operations**, so the booking itself implied everything was
  progressing.

  An officer or treasurer looking at the booking now sees an admin-only warning
  on it. The warning names what the club can and cannot see in Xero, and what to
  do about it: whether no invoice was raised at all, whether the invoice exists
  but the club's payment was not recorded against it, whether it exists but the
  member was never sent it, or whether the operation finished only in part.
  Where the invoice already reached Xero it says **do not raise a second
  invoice**, and it names the invoice number so it can be checked in Xero.

  The link beside it follows what the existing recovery path will actually do.
  It offers **Retry from Xero activity** where a retry is possible, and
  **Resolve from Xero activity** where it is not — an invoice that failed only
  on its email is deliberately not retryable, because retrying it would record a
  payment against an invoice the member has not paid. Resolving the operation
  in Xero clears the warning; so does a retry that works. Neither changes the
  booking, the payment or the invoice.

  An invoice email that was withheld ON PURPOSE raises no warning at all, and
  that distinction is the point. The per-booking **No emails** switch, an
  officer's **Create without emailing** choice, and a non-production copy of the
  site that sends nothing are three deliberate outcomes, not failures. They are
  already listed in the booking's withheld-emails banner, and a warning for them
  would send somebody chasing a provider that did exactly what it was told.

  Nothing about booking, payment or invoice status changed. A provider failure
  does not mean a booking was cancelled, paid or invoiced, and none of that is
  rewritten to clear a warning.
