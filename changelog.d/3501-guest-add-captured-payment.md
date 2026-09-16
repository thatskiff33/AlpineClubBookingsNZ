- **Adding a guest to a booking that has had a refund now collects the extra
  money (#3244).** If a member had a partial refund on their booking — someone
  dropped out, or a night came off and money went back — and a guest was then
  added, the club was not asking that member to pay for the guest by card. No
  error appeared and nothing was logged.

  The cause was that this one screen decided "has this booking been paid?"
  differently from every other way of editing a booking. The other three treat a
  part-refunded booking as paid, because the money did go through that card and
  it is still the right place to collect from. This one treated it as never
  paid. All four now answer that question from the same place.

  **What an officer will notice.** A member adding a guest to a part-refunded
  booking is now asked to pay the difference by card, where before they were
  not. The amount asked for is the full difference between the new price and
  what the booking currently costs — it is deliberately not reduced by the
  refund, because that refund went back alongside a price reduction the booking
  already reflects.

  **Where the money used to go instead.** This depends on whether the club uses
  Xero. With the Xero connection on, and the booking's original invoice already
  raised, the difference was billed as a supplementary invoice rather than
  collected by card — so it was not lost, but it was chased on paper instead of
  taken at the time. With Xero off, or before the original invoice had been
  raised, nothing asked for it at all. Both now go to the card, which is what
  the other three editing paths already did.

  Nothing about **how** the amount is worked out has changed. What changes for
  some bookings is which way it is collected, and the figure can differ in one
  case: where a member already had an unpaid amount outstanding from an earlier
  change, the card request now covers both together rather than only the new
  difference.
