- **A credit-paid booking's review refund is no longer paid back twice when the
  booking is cancelled** (#3791). When a financial review refunded a share as
  account credit on a booking paid entirely by credit, the share was minted as
  new credit while the booking still counted its full applied credit, so a later
  cancellation restored the whole amount by tier and the member received the
  share twice. The share now goes back as the member's applied credit — the same
  give-back an ordinary price reduction uses — so the cancellation tiers only
  what is still applied. A $200 credit-paid booking with a $50 share now returns
  $200 in total on a 100% cancellation (was $250) and $105 at 50% with a $20 fee
  (was $130). Bookings with a captured payment are unchanged.
