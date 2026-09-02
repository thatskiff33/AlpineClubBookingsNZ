- Moving one booking's dates no longer silently leaves another of your own
  bookings without the adult supervision it was relying on. Where a club requires
  a qualifying adult and lets an adult on one of your bookings cover another,
  moving the booking carrying that adult used to take the cover away with no
  warning, no notice and nothing in the booking officer's queue - the second
  booking stayed marked as fine, indefinitely, because nothing looked at it again.
  It is now noticed, and both the member and the officer are told (#3232,
  `INV-HOST-049`).
- When changing your dates would leave another of your own bookings without adult
  supervision, you are now asked whether to move that booking too. Say yes and
  both move together on one combined figure you accept once; say no and only the
  booking you were editing moves, you are told plainly that the other will be left
  without supervision, and a booking officer is told as well. Where there are not
  beds free for both on the new nights, that is said plainly rather than failing
  (#3232, `INV-HOST-050`).
- The refusal a member could already hit told them to "update the affected booking
  first", which the same rule refuses from the other end - so the product was
  instructing people to do something the code forbids. Every action the new wording
  names is one they can actually take (#3232).
- A club setting for whether the second booking's change fee is charged,
  defaulting to charging both. Both bookings really move, so both attract their
  fee - but clubs will differ on whether that is fair when the club's own
  supervision rule is what compelled the second move (#3232, `INV-CONFIG-001`,
  `INV-HOST-051`). A club that turns it off really is not charged it: the waiver
  reaches the price, not only the sentence beside it.
- The same offer is made on the other way into a date change, `modify-dates`, and
  not only on the booking-edit panel. That route already noticed the booking a
  move leaves behind, so without the offer it would have started refusing moves
  that used to work, with nowhere for the member to go (#3232, `INV-HOST-050`).
- Where there are not beds for both, the offer now says which booking will be left
  without adult supervision and on which nights, and the "move only this one" path
  is really available. It was being dropped before it reached the screen, so a full
  lodge left the member with a refusal and no way forward - the opposite of what
  that arm is for (#3232).
