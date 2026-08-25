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

  **The overnight job that gives a member their own login when they come of age
  was NOT affected** — an earlier draft of this note said it was, and that was
  wrong. That job asks the database for candidates before it works anybody's age
  out, and the cut-off it asks on excludes precisely the one day of birthdays this
  bug moved. Checked across every timezone the platform knows, over 27 638 160
  candidates: not one member was promoted or skipped differently, and the list of
  candidates the job asks for is identical to the character. So no club, anywhere,
  has had a member invited to log in a season early by this.

  **No stored information has been changed, and no member's recorded age band has
  been altered.** This corrects how the age is worked out from now on; a band
  already recorded against a member stays exactly as recorded. Rewriting them was
  deliberately not attempted: an age band on a member's record also carries
  administrator overrides and the "not applicable" setting organisations and
  schools use, so a blanket recalculation would erase decisions somebody made on
  purpose.

  **For this deployment there is nothing to review** — its server is east of
  Greenwich, so every band already recorded was worked out correctly. **And most
  adopters were never exposed either**, which is narrower than "any club west of
  Greenwich". What this bug read was the *server's own* clock, and the shipped
  container sets that to New Zealand time — which is east of Greenwich and
  therefore already correct. The timezone a club records in the app is a separate
  setting that this calculation never looked at. So a club had to have overridden
  the container's own timezone to a place west of Greenwich to be affected at
  all.

  **A club whose server is west of Greenwich should check one small group.** Look
  at members whose birthday is the day *after* the club's season starts (2 April on
  the default financial year) and who are now 5, 10 or 18 — the ages just past a
  band boundary. Any of them may have had a band recorded against them one season
  early. Open each in **Admin → Members**, check the age band shown against the
  age, and re-save the record if it is wrong — saving recalculates the band from
  the date of birth using the corrected rule. Members outside that group cannot
  have been affected.

  **For an age-based subscription the price corrects itself; the band on the
  record does not.** Where a membership type charges by age band, the subscription
  run works the band out afresh from the date of birth every time it runs, so the
  next run charges the right amount whether or not anybody re-saves the record.
  Every other kind of membership type charges by the band stored on the record, and
  so does hosting eligibility and everything shown on screen — which is what
  re-saving fixes.

  **One thing worth a glance while you are there.** Creating a member through the
  API without saying whether they may log in makes that decision from their age
  band, so a member created on this bug with a birthday on that one day may hold a
  login they should not have had until the following season. The club's own admin
  screens always state the choice explicitly, so this can only have happened
  through a direct API call.

  **The season start moved with it, because the two could not be separated.** The
  first day of the membership season was also being built from the server's
  calendar, and correcting either one on its own would have introduced the same
  off-by-one from the other direction. Both are now held as plain calendar days,
  so the two sides of the comparison read the same thing on any machine anywhere.

- **A date of birth that is not a real date is now refused when it is entered,
  instead of quietly becoming the wrong band (#3082).** The membership application
  form checked only that a date of birth *looked* like a date, so `1990-13-01` and
  `1990-02-31` were both accepted and stored — the first meaning nothing at all,
  the second silently becoming 3 March. A dependent's date was stored in a form the
  database does not check, so nothing downstream caught it either, and the age band
  worked out from it fell back to Adult: the wrong price, with nothing to show
  anybody that a value had been misread.

  Applications now refuse such a date as you submit them, for the applicant and
  for every dependent, saying which one is wrong. An application already in the
  queue carrying one of these dates cannot be approved — the committee is told
  which person's date is unreadable and can reject it and ask for a fresh
  application, rather than getting an unexplained failure every time they try. The
  same check was added to the admin member screens, the member-creation API and the
  joining-fee preview, all of which had the same gap.

- **A stored date of birth that carries a time of day is now refused rather than
  rounded down.** A birthday is a calendar day, so a value that also carries a
  time is not a birthday — it is a moment something happened, and rounding one down
  gives an answer that is right for a club east of Greenwich and wrong for the
  rest, which is harder to notice than being wrong everywhere. The database itself
  can no longer hold such a value in these columns, so this catches a mistake made
  in code before it can reach a price. It immediately found fourteen places in this
  project's own tests that were describing an age-band price boundary with a value
  no part of the running system ever produces.
