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
  the stay by the right number of nights, but everything recorded *about* it was
  built from a start date a day early: the change history and audit entry named
  the wrong original dates, the email to the member said the booking had moved
  from the wrong night, the beds released for the old stay and the nights offered
  back to the waitlist were the night before the real ones, and re-submitting a
  booking's own dates was not recognised as "no change" — so a booking that moved
  nowhere still created a change record, emailed the member and released a night
  it had never occupied. All of those now use the stay's stored dates.

  Nothing changes for a club in New Zealand, and no stored booking, change
  record or audit entry is rewritten by this — it corrects what is written from
  here on.
