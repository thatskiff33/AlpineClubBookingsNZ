- **Booking officers are told again when a pending booking is bumped (#5403).**
  The **Bookings bumped** notification setting ("Alerts when a pending booking
  is bumped by another booking") had stopped doing anything: when the nightly
  pending-booking job released a booking because its dates had filled up, the
  member was emailed but officers were not. Officers who have the setting on
  (it is on by default) now get the
  **Admin Booking Bumped** email each time it happens, once per booking.

  The alert names the member, the stay dates and a short booking reference, and
  says why the booking was released, including when the member had asked for
  the whole booking to be cancelled if their guests could not come. It names
  the lodge when your club has more than one active lodge, or when the booking
  is at a lodge that has since been archived; a one-lodge club's alert leaves
  the lodge out. The Daily digest's "Bookings Bumped" line now counts these
  alerts instead of always reading zero.

  The template no longer has a "triggering member": the nightly job has no
  triggering booking to name. If your club saved its own wording for this
  email using that placeholder, the email editor shows a warning naming it;
  swap it for the placeholders now offered, or restore the default. A saved
  subject without the booking reference makes the digest count two bumps for
  the same member as one, and a club with more than one lodge that saved its
  own wording should add the lodge placeholder on a line of its own.
