- **A booking change that priced correctly could still be refused when saved,
  and an officer's date shift could record the wrong nights, for any club whose
  timezone is behind Greenwich (#3088).** A lodge night is a calendar day, and
  this part of the booking-change flow was reading those days through a timezone
  before using them — which moved them a day earlier for a club west of
  Greenwich, and made no difference at all for a club in New Zealand.

  **For a member changing their own booking.** The "what will this cost?"
  preview and the save that follows are meant to apply the same rule about which
  dates a member may still move themselves. They had drifted a day apart, so a
  member could be quoted a change on the earliest date the rules allow and then
  told "today and earlier are locked" when they tried to save it. Both halves now
  read the requested day as the day it is, so they decide identically.

  **For a booking officer shifting a booking's dates.** The shift itself moved
  the stay by the right number of nights, and the beds it allocated were correct
  — those are worked out from the booking's new dates after the move. But
  everything recorded *about* the change was built from a start date a day early:
  the change history and audit entry named the wrong original dates, the email to
  the member said the booking had moved from the wrong night, and the nights
  offered back to the waitlist were the night before the ones the booking had
  actually given up.

  **Two things an officer could see go wrong on the dates themselves.** Moving a
  booking exactly one day earlier was refused with "The booking already has these
  dates", because the day-early reading of the old dates happened to match what
  was being asked for. That move is now possible. In the other direction,
  re-submitting a booking's own dates was *not* recognised as "no change", so a
  booking that moved nowhere still wrote a change record, emailed the member and
  offered its nights to the waitlist. That is now refused, as it always should
  have been — including when two identical shift requests arrive at once, where
  the second one now correctly does nothing.

  Behind the scenes the same correction moves the internal lock a date shift
  takes over the chore roster onto the days the stay really occupies, so a
  concurrent whole-roster save can no longer slip a departure-morning chore row
  past a change that has already decided to clear it.

  Nothing changes for a club in New Zealand, and no stored booking, change
  record or audit entry is rewritten by this — it corrects what is written from
  here on.
