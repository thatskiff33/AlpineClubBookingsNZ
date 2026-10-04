- **The booking ledger now records a group organiser's payment on each joiner's
  booking (#3854).** When an organiser settles a whole group in one card payment
  or one combined internet-banking invoice, each joiner's booking is now
  confirmed on the ledger and records its own share of that payment, anchored
  on the group's settlement. A group cancellation records the refund it plans
  for each joiner and what the club keeps, and a refund to the organiser's card
  for one joiner (an edit's reduction or a cancellation) is recorded against
  that joiner, and taken back off if Stripe later fails it. Nothing anyone sees
  changes yet: every screen, email and report still reads the existing figures.
  This is the groundwork for moving those readers onto the ledger (#3584)
  without showing a group joiner's booking as unpaid. A database change adds
  one value to the ledger's list of anchors; it is safe to run while the
  previous version is still serving.
