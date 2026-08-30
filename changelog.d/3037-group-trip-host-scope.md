- **Groundwork for letting related bookings in one Group Trip share adult cover,
  switched off until a club chooses it (#3037).** A real travelling group is
  often several separate bookings, and the adult who is actually with everyone
  may be on a different one. The adult-member hosting rule can now be told to
  treat those bookings as one travelling party for cover purposes — but only
  where a club says so.

  This release adds the setting and the plumbing behind it, not the finished
  behaviour. On the **Adult-member hosting** card under booking policies there is
  now a third box beside the existing two, **"Another booking in the same Group
  Trip"**. It is off for every club, including every club that has already chosen
  a custom set of who counts, and it stays off until somebody ticks it and saves.
  Upgrading changes nothing: the same bookings are compliant, the same bookings
  go to a Booking Officer, and the wording a member sees when their booking is
  short of cover is unchanged to the letter.

  The box is deliberately not useful yet, and ticking it does nothing on its own
  — the cross-booking rule that reads it, the reconciliation that keeps sibling
  bookings correct when one of them changes, and the kiosk privacy work all
  arrive together later in the same piece of work. It is listed here because the
  setting, the configuration file column and the transfer format are visible from
  this release onward.

  For clubs that move settings between installations: the `hostScopes` cell in
  `booking-policies/adult-member-hosting.csv` accepts a third name,
  `SAME_GROUP_TRIP`, alongside `SAME_BOOKING` and `SAME_BOOKING_OWNER`. A cell
  that does not name it leaves the option off, so an existing bundle imports
  exactly as it always did.
