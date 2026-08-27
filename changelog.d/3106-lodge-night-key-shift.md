- **The day before and the day after a lodge night are now counted on the
  calendar (#3100).** The site works out "who is arriving and who is leaving
  today" from that one piece of arithmetic, and it used to do it by adding
  twenty-four hours to a moment in time and then reading the answer back in the
  club's time zone. For a club in New Zealand — every club running this site
  today — those two steps cancel out, so the answer has always been correct and
  nothing about this release changes it.

  For a club west of Greenwich they did not cancel out, on every reading rather
  than only at a month or daylight-saving boundary: "the next night" came back
  as the same night and "the previous night" skipped a day. Three things broke
  outright as a result. No check-out could be recorded at all. A guest was shown
  as absent on the morning they leave and present the day after. And the step
  that turns a stay into a list of nights never finished — it ran until it
  exhausted the server's memory, so the page did not load at all rather than
  loading something wrong. Those are the arrivals and departures list, the
  check-in and check-out buttons on the kiosk, the chore roster and the lodge
  display.

  The step is now counted on the calendar itself, with no moment in time and no
  time zone involved, so a twenty-five hour day cannot lose it in either
  hemisphere.

  **What this does not finish.** For a club west of Greenwich this fixes the
  step, not the whole answer. The same file still reads a stored lodge night
  through the club's time zone in a second place, so the actual dates those
  lists are labelled with are still a day out, and in one time zone — the
  Azores, whose clocks cross Greenwich twice a year — one day of departures
  would come out worse than before. That second half is a separate change
  (#3107), and it lands before any of this reaches a release, so no club will
  ever run the halfway state.

  There is nothing for an administrator to do and no stored booking data
  changes. A club in New Zealand will see no difference at all.
