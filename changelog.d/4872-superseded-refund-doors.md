- **Edits, approved refunds, capacity races, booking-change credits, recovery
  retries and manual hand-backs no longer spend a superseded card payment's
  money (#4872).** When a replaced card payment is captured anyway, the app
  queues its own refund for that charge. Another refund could take part of the
  same charge first, and the superseded refund then sent only what was left:
  the member was paid back less than they were owed, and no officer was told.
  Those refunds now leave the charge to its own refund. An edit's card plan is
  frozen under the payment's row before Stripe is asked. A refund an officer
  approves is capped without that money. A booking that lost its beds refunds
  the capture that just arrived, not the superseded one. A price cut paid back
  as account credit, a refund row that still has to work out its plan, and a
  hand-back an officer marks paid — including the part of a cancellation refund
  that has to be checked — do the same. A plan already frozen is left as it was.
