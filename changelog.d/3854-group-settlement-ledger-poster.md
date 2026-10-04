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
  without showing a group joiner's booking as unpaid. The booking-ledger
  back-post (#3583) now records the same for groups settled before this
  release — each joiner's share, and for a cancelled group its planned refund
  and what the club kept — so a joiner it covers is no longer only listed; a
  joiner it cannot explain is listed with the reason, and the cut-over census
  now keeps the gate shut on such a joiner rather than listing it as covered
  (a refund the card retries have given up on, or shares that do not add up).
  The census also counts a card refund that failed but will be retried as
  still in flight, and accepts a joiner's share when the organiser's whole
  payment was refunded. A database change adds
  one value to the ledger's list of anchors; it is safe to run while the
  previous version is still serving.

  **Deploy note:** finish the switch to the new version before processing any
  group organiser's cancellation. If the previous version cancels a joiner the
  new version has already settled, that joiner's ledger is left wrong (the
  census reports it, and an officer corrects it by hand).
