- Booking screens and the booking API now use the day a stay is actually
  stored against, instead of shifting it into the club's time zone and back.
  For a club west of Greenwich that was showing and using the wrong day in
  several places: the arrival-time editor refused edits a day early,
  re-submitting an unchanged check-in was recorded as a date change, the
  frozen proposal an officer approves for a policy exception described a
  stay one night earlier than the one actually held, and every season badge
  on the availability grid was a night out — so the last night of a season
  lost its badge.
- A member who changed nothing about their booking could be quoted a
  date-change charge, because the quote compared two versions of the stay
  that were a night apart.
- Questions like "what day is it?" — how far back a booking may be
  backdated, when a lodge instruction becomes current, whether a child's
  join request is in time — now ask the club's calendar rather than the
  server's.
