- **Retrying a partly done booking-change credit note now claims it first and closes it (#4259).**
  When Xero raised a booking change's credit note but could not apply it to the
  invoice, **Retry** on the Xero Operations screen applies it. That retry now
  takes the operation first, like the other partial repairs: if an officer
  resolves it or marks it non-replayable, or a second retry starts, at the same
  moment, only one goes ahead and nothing is sent to Xero twice. A successful
  repair now closes the operation as succeeded; before, it stayed partial and
  looked unrepaired. An operation repaired before this change closes the next
  time it is retried, without contacting Xero.
