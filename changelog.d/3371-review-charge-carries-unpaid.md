- **A charge raised after a booking-change review no longer wipes out an earlier
  change's unpaid extra (#3371).** When a change to a booking could not be
  priced automatically, an officer prices it and settles it as money the member
  owes. Raising that request cancelled any request already outstanding on the
  booking — so if the member still owed something from an earlier change, that
  earlier amount quietly stopped being asked for. A booking with $200 owed from
  one change and $60 from the next asked the member for $60, collected $60, and
  nothing anywhere said the other $200 had gone.

  The new request now asks for both together, and the booking's history records
  in plain English how much of it was carried over from the earlier change. An
  officer who opens that earlier change and finds its request gone has a note
  explaining where the money went; a member who expected two amounts and sees
  one larger one is being asked for exactly the same total.

  Nothing needs collecting by hand and no existing amount was changed. The
  club's Xero invoices are unaffected: each change is still invoiced for its own
  money only, so nobody is billed twice.
