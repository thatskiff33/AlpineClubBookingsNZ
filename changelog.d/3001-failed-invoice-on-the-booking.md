- **A booking now says when its Xero invoice has failed, instead of looking
  perfectly normal (#3001).** A booking could sit confirmed, with payment still
  pending, while the Xero operation that should have raised its invoice had
  already failed — or had been left half-finished by a worker that died
  mid-flight. The only evidence lived several clicks away under
  **Admin -> Xero -> Operations**, so the booking itself implied everything was
  progressing.

  A **full admin** looking at the booking now sees a warning on it, in the
  existing provider block on the Admin tools card. (A booking officer does not:
  that block has always been full-admin-only, and this change preserves the
  boundary rather than widening it.) The warning names what the club can and
  cannot see in Xero, and what to do about it: whether no invoice was raised at
  all, whether the invoice exists but the club's payment was not recorded against
  it, whether it exists but the member was never sent it, whether the operation
  finished only in part — or whether the operation stopped mid-flight and nobody
  can tell from here which of those happened, in which case the first thing to do
  is look in Xero. Where the invoice already reached Xero it says **do not raise
  a second invoice**, and it names the invoice number so it can be checked.

  **Whether an invoice reached Xero is taken from what the club itself recorded**
  — the invoice id stored on the payment, or the booking's primary-invoice link —
  and not from the operation row, which does not carry one on a failure. That
  distinction is the difference between telling an officer to retry and telling
  them not to.

  The link beside it follows what the existing recovery path will actually do,
  and **the sentence and the button now come from the same decision**, so the
  warning can never say *do not repeat the action* under a button labelled Retry.
  It offers **Retry from Xero activity** only where repeating is safe — nothing
  reached Xero, or the invoice exists and it is the club's payment that is
  missing, where the retry records that payment and raises nothing. Everywhere
  else it offers **Resolve from Xero activity**, carrying the recovery engine's
  own reason where the engine is what refuses: an invoice that failed only on its
  email is deliberately not retryable, because retrying it would record a payment
  against an invoice the member has not paid. Resolving the operation in Xero
  clears the warning; so does a retry that works. Neither changes the booking,
  the payment or the invoice.

  **An unsent invoice email now says which of three things stopped it**, because
  the answers differ: Xero could not send it (send it from Xero by hand), the
  booking's **No emails** switch could not be read (read the switch first — if it
  is on, the member must not be emailed at all), or this installation's role is
  unconfirmed (confirm it, then send that one invoice by hand).

  An invoice email that was withheld ON PURPOSE raises no warning at all, and
  that distinction is the point. The per-booking **No emails** switch, an
  officer's **Create without emailing** choice, and a non-production copy of the
  site that sends nothing are three deliberate outcomes, not failures. The first
  two are listed in the booking's withheld-emails banner; the third is recorded
  nowhere at all, by design, because on a copy of the real site nothing was
  transmitted and there is nothing for anyone to relay.

  Scope: this covers the operation that CREATES a booking's invoice. A failed
  invoice **update** — the push that follows a re-priced or re-dated booking — is
  a different question with a different remedy and stays where it was, under
  **Admin -> Xero -> Operations**.

  Nothing about booking, payment or invoice status changed. A provider failure
  does not mean a booking was cancelled, paid or invoiced, and none of that is
  rewritten to clear a warning.
