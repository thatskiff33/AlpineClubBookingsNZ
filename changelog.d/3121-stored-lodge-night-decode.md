- **Lodge nights are now read as the calendar days they are, so a club west of
  Greenwich sees the right nights and the right beds (#3107).** The code that
  turns a stored booking date into a lodge night was reading it through the
  server's timezone instead of simply taking the day the database holds. For a
  club at or ahead of Greenwich — which is every club running this software
  today, New Zealand included — those two answers are identical, so nothing
  visible changes here. For a club behind Greenwich every derived night was one
  day early.

  The most serious consequence was on the capacity check that decides whether a
  booking or a policy-exception proposal has the beds. Because a proposal carries
  its nights as plain dates while a saved booking carries them as database dates,
  the two were being read in different ways, and the check could count no beds at
  all on nights the party had actually asked for. A booking or proposal that
  should have been refused for want of beds could be admitted.

  Making a new booking was affected the same way, and it also stored the wrong
  days. The stay range a booking is saved with is worked out from the nights its
  guests are staying, and that calculation read the server's timezone too. On the
  ordinary booking form the timezone was applied twice over, so the dates written
  on the booking were **two** days early, and the bed check then ran over that
  same wrong range. For a three-night stay the check looked at four nights, none
  of them the last one asked for, and found nobody in two of them. The nights
  recorded against each guest were written correctly, so the booking disagreed
  with its own guest nights.

  That also produced the one failure a member would have seen directly. Because
  the booking's start date had been moved two days into the past, the check that
  stops anyone booking a stay that has already begun refused it — so a member
  trying to book a stay starting on the club's current day, or the day after it,
  was turned away with "Cannot book in the past". Only a stay starting two or
  more days out could be booked at all.

  The same mismatch made the occupancy, whole-lodge-hold and shared-bed windows
  each land a day out, and on a booking edited while the stay was already under
  way it could store the guest's nights a day early.

  Copying a booking onto new dates has been corrected too, and this one is worth
  describing because it was hiding. The copy reads four dates from the original
  and shifts them all by the same number of days. All four were read through the
  server's timezone, and the errors happened to cancel each other out, so the
  copy came out right — by luck. That luck runs out in a place with a timezone
  that sits behind Greenwich in winter and level with it in summer, where the
  four dates are not all moved by the same amount: a booking copied across that
  changeover lost a night, and its guests lost a night with it. All four dates
  now read the stored day, which is both correct everywhere and no longer
  dependent on two mistakes agreeing.

  All of it now reads the stored day directly and consults no timezone, so the
  answer cannot be moved by where the club, the server or the viewer happens to
  be. Nothing stored is rewritten, and no club running this software today is
  affected — the fix removes a hazard for anyone deploying it elsewhere.
