- **One rule now values every night a guest holds on a booking (#4305, epic
  #4302).** A new calculation works out what each of a guest's nights is worth
  from what the booking already stores, and the values always add up to exactly
  what that guest was charged. Where every night has a stored price and those
  prices add up, they are used as they are. Where some nights have no stored
  price, the nights that do keep their price and the rest of the guest's total
  is shared evenly over the others. Otherwise the guest's total is shared evenly
  over all their nights, with any odd cents on the earliest nights. A guest
  whose stored total is below zero has every night valued at $0, and is
  flagged.

  Nothing uses it yet, so no booking, price, refund or charge changes in this
  release. A later release uses it to price booking edits automatically, in
  place of sending some of them to an officer for review.
