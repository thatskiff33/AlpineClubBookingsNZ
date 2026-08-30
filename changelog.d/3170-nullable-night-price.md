- Editing a booking whose stay is already under way no longer refuses when the
  club cannot work out the amount from the booking's own price history. The
  change now saves, and the money waits for a person: no charge, no refund, no
  credit and no change fee until someone from the office confirms the figure with
  the member. The edit panel says so before the member saves, in place of a
  refusal that told them to ring the office.
- A night whose price the club genuinely does not know is now recorded as **not
  known**, rather than as `$0.00` and rather than by removing the night from the
  booking's history. Those were the only two alternatives before, and both were
  worse: a zero is a real price a comped night can legitimately carry, and later
  edits read it back as though the member had paid nothing; deleting the rows
  would let a change that never touched a guest erase that guest's price history
  for good.
- What the club already knows is kept exactly. Every night with a stored price
  keeps it to the cent, the guest's own total is left alone, and an evenly split
  historical booking still counts as fully priced — so the change does not push a
  large share of older bookings into review.
- Correcting a name on a booking that is waiting for a price check still works.
  It used to be refused.
- Lodge capacity is still checked before such a change is accepted, and the
  club's invoice for the stay still adds up to the guest's total to the cent.
- The office can now settle one of these reviews **in either direction**. Some
  changes to a stay cost more than the original booking — an extra night, or
  another person — so the member may owe the club rather than the other way
  round. The review screen asks how much and which way, and says which on the
  button you press. Asking for money uses the club's ordinary additional-payment
  path: it appears on the booking as an additional payment or on the invoice, and
  the member pays it themselves. Nothing is taken from anybody's card by that
  screen.
- Until now that screen could only pay money back, and it said "record an
  adjustment" either way — so an officer who correctly worked out that the member
  owed $200 and entered it would have sent $200 to their card instead. That is
  now impossible: the direction has to be chosen, there is no default, and the
  task itself records which way the money went.
- If a booking has no card payment and no invoice to add to, the office is told
  plainly that the money has to be collected another way, and the review stays
  open — rather than being closed as though it had been collected.
- One change to a booking can raise more than one of these reviews — one for
  each person on it whose price history could not be read. When the office
  settles two of them as money owed to the club, the member now gets **one bill
  for the total** rather than two separate ones. Before this, the second request
  cancelled the first: $200 followed by $30 collected $30, both reviews looked
  settled, and the member's payment link showed $30.
- Each review still records its own amount and which way it went, so the
  combined bill can always be traced back to the two decisions behind it, and
  the club's invoice for the change is raised once, for the total.
- If the member has already paid the bill for that change, or the invoice for it
  has already gone out, the office is told plainly and the review stays open
  rather than a second request being raised behind the first.
- If the club's card provider is unavailable at the moment one of these bills is
  raised, the amount owed is kept on a retry queue until it succeeds, and the
  office is alerted if it never does. It is no longer possible for the retry to
  quietly mark itself done having asked for nothing.
- In the rare case where the office settles a second review at the same instant
  as the first, the member still gets exactly one invoice, for the combined
  total, and an amount already asked for is never revised downwards.
- Where a settled amount genuinely cannot be added to the bill — because the
  member paid it seconds earlier — that is now written into the club's audit
  record, naming the shortfall, so somebody can find it and collect it.
