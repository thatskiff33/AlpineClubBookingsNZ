- **A price reduction on a booking paid with account credit now gives the
  member back what a card-paid member would get** (#3809). Removing a guest,
  shortening a stay or any other edit that lowered the price of a paid booking
  with no card or bank payment behind it returned nothing, where a card-paid
  member making the same edit got the difference back under the cancellation
  policy; with no later cancellation the member stayed short for good. The
  reduction is now tiered exactly like a card refund and comes back as the
  member's account credit. A $200 credit-paid booking reduced to $150 at a 100%
  tier returns $50 (was $0); a later cancellation at 50% with a $20 fee brings
  the total to $105, the same as a card-paid booking. A booking paid partly by
  card and partly by credit gets back from its credit whatever the card refund
  cannot cover, so $100 by card and $100 by credit reduced by $150 returns $150
  at 100% and $55 at 50% with a $20 fee, as an all-card booking would. The edit
  screen shows the amount before saving, and the "Booking Modified" email says
  how much account credit was returned. A booking still owing money is
  unchanged: its reduction lowers what it owes.
- **A cancellation no longer returns account credit above what the booking is
  worth** (#3809). After a reduction the policy kept part of, the cancellation
  restored credit tiered on everything still applied rather than on the
  booking's new price, so a credit-paid member got more back than a card-paid
  one. Reduced from $200 to $150 at 50% with a $20 fee ($5 back) and then
  cancelled at the same tier, the member now gets $60 in all, as a card-paid
  member does (was $82.50). The cancellation preview shows the same figure.
- **Xero hears of every guest removal, including a member guest's declined or
  lapsed consent** (#3809). Those removals repriced the booking but queued no
  Xero document, so the invoice kept the old price. In Xero, credit given back
  is released from the invoice and the invoice is reduced by an allocated
  credit note for it, so the amount due and the member's credit agree with the
  app.

  **Deploy note:** a booking edit's Xero credit note now waits for the
  booking's applied-credit deallocation, which the previous release does not
  do. As for #3791, stop the old release's workers before the first edit of a
  credit-paid booking on the new release, or pause and drain the modification
  credit-note outbox rows until they have stopped.
