- **The events calendar now shows club time to everyone, wherever they are
  reading it from (#2870).** The month calendar at `/calendar` and
  `/admin/calendar` worked out what day it was, which day each event belonged
  to, and what time each event started, from the **reader's own computer**. For
  a club whose members are all in one country that was invisible; for anyone
  looking at the calendar from overseas — or for a club running this software
  outside New Zealand — it was wrong.

  What a member or an officer will notice:

  - the month heading over the grid is the club's current month. It could
    previously be the **previous month** for any club west of Greenwich,
    because of how the heading was worked out;
  - the highlighted "today" ring is on the club's today, and the "Today"
    button jumps to the club's current month;
  - an evening event stays on the evening it happens at the lodge, instead of
    sliding onto the neighbouring day's square for a reader in another
    timezone;
  - the times shown on the coloured event chips, in the day list and in an
    event's own detail panel are the club's times;
  - when an officer opens an existing event to edit it, the date and time boxes
    are filled in with the club's date and time. Saving a 7pm event from
    overseas used to store 7pm in the **officer's** timezone, quietly moving
    the event for everybody else. It now stores 7pm at the club;
  - a new event opens on the club's today rather than the reader's;
  - the "Repeat" wording ("Weekly on Tuesday", "Monthly on the 3rd Tuesday")
    describes the day that was actually picked, and can no longer contradict
    itself for an overseas reader.

  For repeating events, the whole series is now generated on the club's
  calendar and keeps the club's wall-clock time. That matters twice a year: a
  7pm series stays a 7pm series across a daylight-saving change instead of
  becoming 6pm or 8pm, and a rule anchored on "the third Tuesday" stays on the
  third Tuesday of the club's month. Which timezone the club is in is the one
  recorded in the admin Club Time settings, so an operator who changes it no
  longer has to have the server reconfigured for the calendar to follow.

  Nothing about existing events changes on disk, and no event is moved: the
  stored moment was always the right moment, and it was only the reading of it
  that was taken from the wrong clock. An operator has nothing to do.
