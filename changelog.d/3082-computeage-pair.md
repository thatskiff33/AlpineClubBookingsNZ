### Fixed

- **A member's age band no longer depends on where the site is running (#3082).**
  Working out how old a member is at the start of the season read their date of
  birth using the server's own calendar, and a date of birth is stored as a plain
  calendar day with no timezone. For a server anywhere west of Greenwich the two
  disagreed and the stored day was read one day early — which makes a member look
  a day *older*, because their birthday appears to have already gone.

  **Who it affected, exactly.** The member born on the day *after* the season
  starts — 2 April on a club using the default 31 March financial year-end. Checked
  against every date of birth in a full year and every timezone the platform
  knows: 161 of 418 timezones, all of them west of Greenwich, moved that one day
  of birthdays and moved it by a whole year. Nothing else moved. **A club whose
  server sits in New Zealand — or anywhere else east of Greenwich — was already
  getting the right answer**, so no club running this software today has been
  affected.

  **What it would have cost a club that was affected.** An age band decides a
  price, so a 17-year-old born on 2 April would have been quoted the adult
  subscription for a season they should have been charged the youth rate for. The
  same one-day shift crosses the infant and child boundaries too, at ages 4 and 9.
  The overnight job that gives a member their own login when they come of age
  would also have invited that member a season early.

  **No stored information has been changed, and no member's recorded age band has
  been altered.** This corrects how the age is worked out from now on; a band
  already recorded against a member stays exactly as recorded. An affected club
  would want to re-check members born on the day after its season start — the
  release notes for this change explain how — but for this deployment there is
  nothing to review.

  **The season start moved with it, because the two could not be separated.** The
  first day of the membership season was also being built from the server's
  calendar, and correcting either one on its own would have introduced the same
  off-by-one from the other direction. Both are now held as plain calendar days,
  so the two sides of the comparison read the same thing on any machine anywhere.

- **A stored date of birth that carries a time of day is now refused rather than
  rounded down.** A birthday is a calendar day, so a value that also carries a
  time is not a birthday — it is a moment something happened, and rounding one down
  gives an answer that is right for a club east of Greenwich and wrong for the
  rest, which is harder to notice than being wrong everywhere. The database itself
  can no longer hold such a value in these columns, so this catches a mistake made
  in code before it can reach a price. It immediately found seventeen test fixtures
  that were describing an age-band price boundary with a value no part of the
  running system ever produces.
