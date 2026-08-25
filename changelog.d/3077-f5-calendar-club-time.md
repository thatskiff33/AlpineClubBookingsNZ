- **The events calendar now shows club time to everyone, wherever they are
  reading it from (#2870).** The month calendar at `/calendar` and
  `/admin/calendar` worked out what day it was, and which day each event
  belonged to, from the **reader's own computer**. For a club whose members are
  all in one country that was invisible; for anyone looking at the calendar from
  overseas it was wrong. The times of day were a separate problem with the same
  cause: they were correct for the club, but they came from a timezone fixed
  when the software was built rather than from the one recorded in the admin
  Club Time settings, so changing that setting could not move them.

  What a member or an officer will notice:

  - the month heading over the grid is the club's current month. It could
    previously be the **previous month** for any club west of Greenwich,
    because of how the heading was worked out;
  - the highlighted "today" ring is on the club's today, and the "Today"
    button jumps to the club's current month;
  - an evening event stays on the evening it happens at the lodge, instead of
    sliding onto the neighbouring day's square for a reader in another
    timezone;
  - the times on the coloured event chips, in the day list and in an event's own
    detail panel follow the club timezone recorded in the admin settings. They
    were already the club's times rather than the reader's, so most clubs will
    see no change here — what changes is that an operator who moves the setting
    is now followed without the server being reconfigured;
  - when an officer opens an existing event to edit it, the date and time boxes
    are filled in with the club's date and time. Saving a 7pm event from
    overseas used to store 7pm in the **officer's** timezone, quietly moving
    the event for everybody else. It now stores 7pm at the club;
  - a new event opens on the club's today rather than the reader's;
  - the "Repeat" wording ("Weekly on Tuesday", "Monthly on the 3rd Tuesday")
    describes the day that was actually picked. An officer working from overseas
    could previously be offered "Weekly on Monday" for a date they had selected
    as a Tuesday.

  For repeating events, the whole series is now generated on the club's
  calendar and keeps the club's wall-clock time. That matters twice a year: a
  7pm series stays a 7pm series across a daylight-saving change instead of
  becoming 6pm or 8pm, and a rule anchored on "the third Tuesday" stays on the
  third Tuesday of the club's month. Which timezone the club is in is the one
  recorded in the admin Club Time settings, so an operator who changes it no
  longer has to have the server reconfigured for the calendar to follow.

  Nothing already stored is changed or moved, and there is nothing for an
  operator to do. One class of NEW event is written differently, and it is worth
  knowing about even though it is rare: on the spring morning when the clocks go
  forward there is an hour that does not happen, and an event created for a time
  inside it is now stored at the moment the clocks jumped to — 3:00 am where it
  would previously have been recorded as 3:30 am. That is the intended answer
  for a time that never existed, and it affects one hour of one day a year.
