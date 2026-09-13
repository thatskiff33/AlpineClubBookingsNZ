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

  Nothing needs collecting by hand and no existing amount was changed. Each
  change is still invoiced through Xero for its own money only, so nobody is
  billed twice.

  One thing this does not fix, said plainly because the change makes it easier
  to meet. When a booking is paid by card, the Xero invoice for a change waits
  until the member actually pays before it is issued. If the member never pays
  that change's request and a later change replaces it, that waiting invoice is
  never issued and is tidied away a day later — so the club can now collect the
  earlier money (which it previously lost outright) while Xero still has no
  invoice naming it. The booking-versus-Xero repair report is what finds those:
  it flags the change as missing its invoice and offers to raise it. This is not
  new — the same is true of ordinary changes since the September fix — and it is
  tracked separately as #3403 rather than folded in here, because putting the
  earlier change's money on the later change's invoice would double-bill every
  booking whose earlier invoice HAD been issued.
