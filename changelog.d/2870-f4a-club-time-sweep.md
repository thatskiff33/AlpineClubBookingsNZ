- **The finance dashboard's trend charts were labelling the wrong day and the
  wrong month for any club west of Greenwich (#2870).** Every point on the
  occupancy and forward-demand trends was named a day early, and every month tick
  on the revenue, cost, ratio and balance charts — plus the sync-health sentences
  that say which month is still provisional — was named a month early. On a
  January tick it lost the year as well, so "January 2026" was drawn as
  "Dec 2025".

  The dates themselves were always right; only the labels were wrong, so a total
  or a percentage was never affected. A club in New Zealand never saw this at all:
  the two labels were being converted through a timezone before being printed,
  and that conversion happens to change nothing for a club east of Greenwich.
  Both labels now print the day and the month they were given, with no timezone
  involved, which is the only correct answer for a calendar date.

- **Every screen that still kept its own private date formatter now uses the
  shared one (#2870).** Thirteen of them, across the kiosk, the chore sheet, both
  rosters, the two dashboards, the calendar, the finance charts and the school
  confirmation page. Nothing an administrator, a hut leader or a member sees
  changes on any of them: every one of those labels is byte-for-byte what it was.
  What changes is that a shape is now described in one place, so the next edit to
  it cannot leave twelve screens disagreeing.

  Two shared calculations went the same way. "What day of the week is this?" and
  "which month does this day belong to?" had each been written a second time
  inside the calendar code, with a note saying it belonged in the shared set; both
  copies are gone. Six more places that worked out a weekday by hand now ask the
  shared helper, which removes a particular slip — reading a stored date's weekday
  with the *server's* clock instead of the date's own — that this product has
  already had to fix twice.
