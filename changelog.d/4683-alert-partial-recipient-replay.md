- **A Finance editor no longer misses a payment alert because a colleague got
  theirs.** The bank-transfer amount alert and the two Stripe payment alerts go
  to every Finance editor. If one copy failed to send while another went out,
  the failed copy used to be lost. It is now re-sent by the email retry job,
  once. When nobody received the alert, it is still re-sent by its own retry
  (the Xero inbound job, or Stripe's redelivery) and never by both.
