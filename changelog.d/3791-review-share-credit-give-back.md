- **A credit-paid booking's review refund is no longer paid back twice when the
  booking is cancelled** (#3791). When a financial review refunded a share as
  account credit on a booking paid entirely by credit, the share was minted as
  new credit while the booking still counted its full applied credit, so a
  cancellation restored the whole amount by tier and the member received the
  share twice. The share now goes back as the member's applied credit, through
  the same give-back a price reduction before payment uses, so the cancellation
  tiers only what is still applied. A review completed after the booking was
  already cancelled now gives back only what the cancellation's restore left
  owing. A $200 credit-paid booking with a $50 share returns $200 in total at a
  100% tier (was $250) and $105 at 50% with a $20 fee (was $130), whichever came
  first. On an internet-banking booking whose credit is allocated against its
  Xero invoice, the give-back now releases that allocation in Xero, as the price
  reduction does, so the next Xero sync no longer takes the credit back; the
  review no longer raises a second Xero credit note for it. On a booking that is
  still unpaid, no more is given back than the review's re-price took off the
  price. Bookings with a captured payment are unchanged.
