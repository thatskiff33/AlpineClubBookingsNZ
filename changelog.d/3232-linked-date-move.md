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
  true of none of them. It now reads "no longer covered after a later change",
  which is also true of the two cases "cover removed" was not - a club that
  tightened its own rule removed nothing, and an officer confirming pending
  guests added people the existing cover no longer stretches to. Open the
  booking and its history records the member's decision in words, under "Adult
  member cover flagged", which only staff see because the same entry can carry
  an officer's private reason. The two officer screens that had drifted into two
  different wordings for the same fact now read from one place (#3232,
  `INV-HOST-052`, `INV-SSOT-001`).
- The queue entry will name a declined offer as its own reason from the release
  after this one. The label has to be added to the database one release before
  anything writes it, because the version of the site still running while a new
  one is being put in place cannot read a label it has never heard of (#3232,
  `INV-HOST-052`).
- A full lodge no longer refuses the member outright. "There are not beds for
  both" was decided by looking for two refusals that only ever reach an
  administrator, so on a member's own move it was never recognised: they got a
  bare message about beds on a booking they had not asked to move, with no offer
  and no way to go ahead with just the one. The refusal a member really gets is
  now the one the offer looks for (#3232, `INV-HOST-051`).
- Only the member whose bookings they are can answer the offer. A booking officer
  could send the member's answer back with the token from their own refusal and
  have the change go through with no reason recorded, no officer named, and the
  booking's history saying the member had been asked - about a booking that was
  not theirs. An officer who means to leave a booking without supervision still
  has to confirm it and say why (#3232, `INV-HOST-050`).
- Where moving both bookings brings money back on the second one, you are asked
  where it should go. Before, that case ended in "choose a refund or account
  credit before saving" with nothing on the page to choose, and neither booking
  could be moved (#3232, `INV-HOST-051`).
- Shortening a stay is no longer offered a move that cannot help. Cutting a
  booking short at the departure end leaves the other booking exactly where it
  is, so shifting it changes nothing - the offer was being made and then failing.
  That case now gets the ordinary refusal straight away, whose remedies really
  are open (#3232, `INV-HOST-050`).
- If something else is being changed on the same bookings at that moment, the
  answer is "nothing was changed, try again in a moment" rather than an
  unexplained failure - and the two-booking move is given the time it needs
  before that can happen at all (#3232, `INV-LOCK-002`).
- Both bookings' follow-up work - the card refund or charge, the accounting
  entry, the email - is now kept separate, so a hiccup on one cannot silently
  cancel the other's. It also no longer reports a change that really happened as
  a failure (#3232, `INV-HOST-051`).
- Where moving both bookings costs money on one and refunds money on the other,
  you are now told both figures. Before, you were shown only the refund, and
  charged the rest with nothing on the page naming it: the two are worked out per
  booking, so one going up while the other goes down leaves both totals real, and
  the screen only had room in its wording for one of them. It now says both, and
  says they do not cancel each other out - each booking settles on its own
  (#3232).
- Money on the linked-move offer is now written the same way as money everywhere
  else on the page, so a five-figure total keeps its thousands separator, and a
  club whose currency is not dollars is no longer shown a dollar sign on the one
  figure it legally accepts (#3232, `INV-CONFIG-001`, `INV-SSOT-001`).
- The offer now counts the bookings it is talking about. It was written for
  exactly one other booking throughout, and a member with one adult and two
  parties of guests is an ordinary family shape - so they read "2 other bookings
  ... is relying on this booking", were invited to "Move both bookings" over a
  list of three, and, on the option that leaves bookings uncovered, were told
  "the booking above" would be left without supervision when the list showed
  two (#3232).
- Save now stays disabled until you choose one of the two options, which is what
  the screen already said would happen. Before, pressing Save put a message at
  the bottom of the panel, below the button, while the choices sat above it - and
  that message was not announced to anyone using a screen reader (#3232).
- A change fee the club has waived is now recorded as waived rather than left as
  a plain zero, so "no fee was due" and "we waived it because our own supervision
  rule compelled this move" are no longer the same thing in the booking's history
  and the accounting entry (#3232).
- The email sent when a booking loses its adult cover no longer says "a change
  elsewhere means" it happened. That was written for the case where somebody else
  caused it, and it was also being sent to the member who had just deliberately
  chosen to leave the booking uncovered (#3232).
- Smaller corrections in the same area: the reason stored against a flagged
  booking no longer carries a GitHub issue number or wording out of the codebase,
  since for one release it is the only explanation an officer reads; the refusal a
  member can still hit tells them how to reach a Booking Officer again rather
  than only that one exists, and counts the bookings it names; and the officer
  guide no longer says the full-lodge option is hidden when it is shown greyed
  out with the reason on it (#3232).
