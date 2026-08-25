- **Lodge nights are now read as the calendar days they are, so a club west of
  Greenwich sees the right nights and the right beds (#3107).** The code that
  turns a stored booking date into a lodge night was reading it through the
  server's timezone instead of simply taking the day the database holds. For a
  club at or ahead of Greenwich — which is every club running this software
  today, New Zealand included — those two answers are identical, so nothing
  visible changes here. For a club behind Greenwich every derived night was one
  day early.

  The most serious consequence was on the capacity check that decides whether a
  policy-exception proposal has the beds. Because a proposal carries its nights
  as plain dates while a saved booking carries them as database dates, the two
  were being read in different ways, and the check could count no beds at all on
  nights the party had actually asked for. A proposal that should have been
  refused for want of beds could be admitted. The same mismatch made the
  occupancy, whole-lodge-hold and shared-bed windows each land a day out, and on
  a booking edited while the stay was already under way it could store the
  guest's nights a day early.

  All of it now reads the stored day directly and consults no timezone, so the
  answer cannot be moved by where the club, the server or the viewer happens to
  be. Nothing stored is rewritten, and no club running this software today is
  affected — the fix removes a hazard for anyone deploying it elsewhere.
