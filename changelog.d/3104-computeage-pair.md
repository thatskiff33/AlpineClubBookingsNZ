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
  already recorded against a member stays exactly as recorded. Rewriting them was
  deliberately not attempted: an age band on a member's record also carries
  administrator overrides and the "not applicable" setting organisations and
  schools use, so a blanket recalculation would erase decisions somebody made on
  purpose.

  **For this deployment there is nothing to review** — its server is east of
  Greenwich, so every band already recorded was worked out correctly.

  **A club whose server is west of Greenwich should check one small group**, and it
  will not correct itself: look at members whose birthday is the day *after* the
  club's season starts (2 April on the default financial year) and who are now 5,
  10 or 18 — the ages just past a band boundary. Any of them may have been moved
  up a band one season early, and any who were moved to Adult early will also have
  been sent their own login early. Open each member in **Admin → Members**, check
  the age band shown against the age, and re-save the record if it is wrong —
  saving recalculates the band from the date of birth using the corrected rule.
  Nothing else needs doing, and members outside that group cannot have been
  affected.

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
  in code before it can reach a price. It immediately found fourteen places in this
  project's own tests that were describing an age-band price boundary with a value
  no part of the running system ever produces.
