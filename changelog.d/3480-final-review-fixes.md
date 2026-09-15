- **A school booking no longer trips the hosting rule's safety fence, so
  recording a teacher's membership payment or standing works again (#3480).**
  Since schools became bookings owned by the school itself rather than by an
  invented member, the adult-member hosting rule had two different ideas of
  which bookings it should re-check when a member's standing changes. One half
  correctly left the school's booking out; the other half still put it in. When
  a club member was a guest on a school's booking at a lodge running the rule,
  the disagreement looked like a concurrent edit, and recording that member's
  manual subscription payment, deactivating them, or syncing their standing
  from Xero failed with "this booking or member changed, reload before trying
  again" — every time, with nothing to reload. Approving a school booking
  request at such a lodge failed the same way, as did a school's Xero invoice
  being marked paid. There is now one answer to "is this booking part of the
  hosting rule's re-check?", asked by both halves, and a school's booking is
  simply not one: its hosting review is still recorded for an officer to see,
  but nothing about a member's account is queued for it.

- **Copying a school booking now says so (#3480).** An officer pressing Copy on
  a booking owned by a school was told "The booking member is inactive". The
  refusal now says that the booking belongs to a school rather than to a member
  and cannot be copied, and points to approving a new school booking request
  instead.

- **Admin lists no longer link a school to a member page that does not exist
  (#3480).** On the bookings, payments and waitlist lists and the Xero health
  panel, a school-owned booking's name was a link to `/admin/members/undefined`.
  The school's name is now plain text there, as it already was on the booking
  change-requests panel.
