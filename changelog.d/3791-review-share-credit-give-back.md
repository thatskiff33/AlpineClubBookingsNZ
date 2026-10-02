- **A credit-paid booking's review refund is no longer paid back twice when the
  booking is cancelled** (#3791). When a financial review refunded a share as
  account credit on a booking paid entirely by credit, the share was minted as
  new credit while the booking still counted its full applied credit, so a
  cancellation restored the whole amount by tier and the member received the
  share twice. The share now goes back as the member's applied credit, through
  the same give-back a price reduction before payment uses, so the cancellation
  tiers only what is still applied. A review completed after the booking was
  already cancelled gives back only what the cancellation's restore left owing,
  and two reviews of one booking share that between them. A $200 credit-paid
  booking with a $50 share returns $200 in total at a 100% tier (was $250) and
  $105 at 50% with a $20 fee (was $130), whichever came first. In Xero the share
  now matches a price reduction: on an internet-banking booking the credit
  allocated against the invoice is released, the invoice is reduced by an
  allocated credit note, and the next Xero sync no longer takes the credit back;
  a cancelled booking's invoice is left closed and the member is credited by an
  unallocated note. On a booking that is still unpaid, no more is given back than
  the reviews' re-prices took off the price. Officers are told when a failed Xero
  update has to be retried before a review can close. Bookings with a captured
  payment are unchanged.
