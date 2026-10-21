- **Repairing a card booking's invoice payment in Xero Operations no longer
  records too much card cash when account credit was used (#4010).** If Xero
  refused the card payment when a booking's invoice was raised, an officer can
  repair it from the Xero Operations panel. That repair used to record the
  whole invoice total as card cash. On a booking partly paid with the member's
  account credit, that overstated the card cash, so the Stripe deposit no
  longer matched, and the credit then had nothing left to settle. The repair
  now records the card cash the invoice was meant to receive, the same figure
  used when the invoice was first raised. Repairs of operations made before
  that figure was kept still record the invoice total, as before.
