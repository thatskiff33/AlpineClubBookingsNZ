- **When one booking's change leaves another booking in the same group trip
  without its required adult, the change now goes through and the club is told
  (#3039).** This only affects clubs that have switched on the optional setting
  letting separate bookings in one group trip share adult cover; every other club
  sees nothing different.

  Before this, the sharing worked but nothing watched it. If the person whose
  adult was covering the group removed that adult, moved their dates, changed
  lodge or cancelled, the other bookings quietly stayed marked as compliant. No
  Booking Officer was told, the affected members were not told, and the problem
  only surfaced if somebody happened to look.

  Now the person making the change is still allowed to make it — they are never
  blocked because of somebody else's booking, and they are never shown anything
  about that other booking, not its reference, not whose it is, and not whether
  it is compliant. Blocking them would let one member control another member's
  booking, and even the refusal message would give away that somebody else was
  relying on them. Instead the affected bookings are re-checked straight after
  the change, and anything genuinely left without cover is raised for Booking
  Officers through the same urgent-compliance list and owner email that already
  handle this on a single account. Officers see the real problem; the person who
  made the change sees only their own booking.

  Cancelling a booking counts, and so does a payment or settlement step that
  quietly un-confirms one. Closing or reopening a group to new joiners does not,
  and should not: closing a group stops new people joining it, it does not take
  an adult away from anybody already going.

  For anyone working on the code: group trips get their own database lock, taken
  before the per-account one, and the sibling bookings are re-read while it is
  held — without that, two people editing two bookings in the same trip at the
  same moment could each act on a picture the other had already invalidated. The
  re-check work is recorded durably with the change itself, one bounded item per
  affected booking, so a crash or a failed email delays it rather than losing it.
  `docs/CONCURRENCY_AND_LOCKING.md` and `INV-HOST-045` carry the detail.
