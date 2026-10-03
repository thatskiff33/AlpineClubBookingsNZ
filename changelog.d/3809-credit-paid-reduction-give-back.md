- **A price reduction on a booking paid entirely with account credit now gives
  the member something back** (#3809). Removing a guest, shortening a stay or
  any other edit that lowered the price of a paid booking with no card or bank
  payment behind it returned nothing, where a card-paid member making the same
  edit got the difference back under the cancellation policy; with no later
  cancellation the member stayed short for good. The reduction is now tiered
  exactly like a card refund and comes back as the member's applied credit,
  through the same give-back a price reduction before payment uses, so a later
  cancellation tiers only what is still applied. A $200 credit-paid booking
  reduced to $150 at a 100% tier returns $50 (was $0), and a later cancellation
  at 50% with a $20 fee brings the total to $105 (was $80), the same as a
  card-paid booking. In Xero the reduction matches a card one: on an
  internet-banking booking the released credit is deallocated from the invoice
  and the invoice is reduced by an allocated credit note for what was given
  back, worded as account credit, so the amount due and the member's credit
  agree with the app. A booking still owing money is unchanged: its reduction
  lowers what it owes.

  **Deploy note:** a booking edit's Xero credit note now waits for the
  booking's applied-credit deallocation, which the previous release does not
  do. As for #3791, stop the old release's workers before the first edit of a
  credit-paid booking on the new release, or pause and drain the modification
  credit-note outbox rows until they have stopped.
