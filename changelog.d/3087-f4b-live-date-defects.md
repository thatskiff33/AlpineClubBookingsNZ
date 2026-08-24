- **Three date faults fixed for any club whose timezone is behind Greenwich: a
  guest with no dates of their own was booked a night early, members were told
  the wrong nights were clashing, and a booking change could be quoted and then
  refused (#2870).** All three came out of the Club Time work and share one
  cause: a lodge night is a calendar day, and the system was reading some of
  those days through a timezone before using them. For a club east of Greenwich
  — including New Zealand — that made no difference, which is why none of it had
  been noticed. For a club to the west it moved the day back by one.

  **The guest who supplied no dates.** When somebody is added to a booking
  without being given their own arrival and departure dates — which is what the
  booking form sends unless the member deliberately opens the per-guest date
  option — that guest is meant to take the booking's own dates. They were
  instead taking those dates shifted a night earlier. The consequences ran all
  the way through: the stay was priced for the wrong night, beds were checked
  and held for the wrong night, a booking officer reviewing a policy-exception
  request saw the wrong night, and the booking that was finally created was for
  the wrong night. The party's overall arrival date also stretched a day early
  to cover both answers at once. It is now the booking's own dates, exactly as
  stored. Adding a guest to an existing booking was affected in the same way and
  had been recorded as unaffected; it was not, and it is fixed by the same
  change.

  **"You are already booked on these nights."** When a member is already on
  another booking for a night they are trying to book again, the system refuses
  and names the nights. It was naming the night before each one. That is the one
  message whose whole purpose is to say which nights are the problem, so a
  member was being refused with dates they had never chosen. It now names the
  nights they actually picked.

  **A change that priced and then would not save.** The "what will this cost?"
  preview on a booking change and the save that follows it are meant to apply
  the same rules about which dates a member may still move themselves. They had
  drifted a day apart, so a member could be shown a valid quote for a change and
  then be told "today and earlier are locked" when they tried to save it — or,
  at the other boundary, be refused a shortening of their stay that the rules
  actually allow. The two now decide identically.

  Nothing changes for a club in New Zealand, and no stored booking is altered by
  any of this. One case is worth knowing about for a club that is moving
  timezones: a request to change an existing booking that was submitted before
  this update, includes a guest added without their own dates, and is approved
  after it, will be refused once and need resubmitting. That is deliberate — the
  request describes a stay a night earlier than the member meant, so refusing it
  is better than applying it. The wording of that particular refusal talks about
  the booking having changed, which is not what happened; that is recorded as
  follow-up work rather than being guessed at here.
