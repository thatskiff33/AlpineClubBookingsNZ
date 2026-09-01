- **The lodge kiosk now shows which bookings are travelling together, without
  telling everybody in the room whose booking is covering whose (#3040).**
  Several separate bookings can be one travelling party — a Group Trip — and the
  day list has always shown them as unrelated cards.

  Each card that shares a trip with another card on the same day now carries a
  small **Group trip 1** chip. Cards with the same number are one party. The
  number is only a label for the list on screen — it is counted from the top of
  that day, it changes from day to day, and it is not the group's own reference.
  A card gets no chip unless another card in front of you belongs to the same
  trip, because a lone chip would link to nothing.

  For an ordinary staying guest that chip is the whole of it. Who organised the
  trip, which booking or adult is providing the required adult cover, and the
  trip's join code are not shown to them and are not sent to their device at all
  — so there is nothing to uncover by tapping, hovering or reading the page
  source.

  A hut leader signed in with their PIN, and a full admin, see two more lines on
  the cards that belong to a Group Trip: who organises the trip (a name, and
  which card is theirs — no email or phone number), and where the adult cover
  comes from. Cover is decided night by night, so that line reads like "2 of 3
  nights covered" and names the kind of booking supplying it, along with what a
  Booking Officer has decided about it where they have looked at it. Those two
  are separate permissions, so a club can be given one without the other later.
  A shared lodge wall device signed in as the kiosk account sees neither —
  though bear in mind that the same tablet is showing a hut leader's view for as
  long as their PIN session is open on it, so sign out when you walk away.

  The cover line is deliberately cautious. It reports what the club's adult-cover
  rule last worked out, and where that answer cannot be trusted it says *needs
  re-checking* or *last check could not be read* rather than claiming cover.
  Cover that comes from another booking in the same trip is reported as *needs
  re-checking* for now: until the Group Trip re-checking work is finished the
  kiosk cannot tell whether that other booking has changed, and it will not claim
  supervision it cannot stand behind. Most cards say a quiet *no issue recorded*,
  which is the normal state and is deliberately not dressed up as a warning —
  a warning on every card is a warning nobody reads.

  The chip is not tied to the Group Trip adult cover setting: any club that uses
  group bookings gets it, because it says only that these cards arrived together.
  That is a deliberate decision — group bookings came first, and a roster label
  should not depend on an unrelated supervision setting — so a club that has never
  enabled adult cover will see this new chip after upgrading. Nothing else about
  their kiosk changes, and the chip costs their day list no extra database work
  except on a day that has a split booking on it, where it costs one.

  The cover line is the part that does depend on a setting: it appears only where
  the club's adult member hosting requirement is switched on. Clubs that do not
  use that requirement see no cover line at all, rather than a row of notes about
  a rule they never turned on.

  If the database hiccups while the day list is being built, the roster still
  appears — it simply comes back without the Group Trip extras rather than
  failing altogether.
