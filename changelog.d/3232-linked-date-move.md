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
- A booking left without adult supervision because the member was asked about
  their other booking and chose not to move it now says so. The reason beside a
  booking officer's queue entry used to read "qualification changed" for every
  booking that lost its cover without an officer overriding anything - an
  administrative cancellation, a lifecycle change, a data correction and a
  member's deliberate choice all wore the same wording, and that wording was
  true of none of them. It now reads "cover removed by a later change", the
  booking's history records the member's decision in words, and the two officer
  screens that had drifted into two different wordings for the same fact read
  from one place (#3232, `INV-HOST-052`, `INV-SSOT-001`).
- The queue entry will name a declined offer as its own reason from the release
  after this one. The label has to be added to the database one release before
  anything writes it, because the version of the site still running while a new
  one is being put in place cannot read a label it has never heard of (#3232,
  `INV-HOST-052`).
