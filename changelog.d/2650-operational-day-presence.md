- **Every lodge screen now agrees on who is in the lodge on a given day
  (#2631).** A guest is present on a day if they slept there the night before
  or are sleeping there that night, so a checkout morning is a real day at the
  lodge on the kiosk, the roster setup wizard, the weekly view, the roster
  calendar, the admin dashboard count and the printed roster sheet.
  "Departing" means "leaves today" everywhere — the roster setup wizard used
  to mean "leaves tomorrow", so two lodge screens could disagree about the
  same person.

  The weekly kiosk view can no longer report guests and "no guests to roster"
  in the same breath: the guest count, the departing count and the roster
  colour all come from one list. The roster calendar no longer counts guests
  the roster itself excludes, in either of the two ways it used to: a day
  whose guests are all still awaiting consent, or whose only booking is held
  for admin review, no longer reads "needs a roster" and then opens empty. A
  departure on the first day of the displayed month or week is no longer
  dropped from the calendar or the dashboard count, and the dashboard headline
  now counts days rather than nights.

  On a stay with a gap in it, each leg's departure morning now shows on the
  lodge screens (previously only the final one did), and the kiosk no longer
  offers a check-out the server would refuse: the Mark Departed button appears
  only on the final departure morning, which is the one the check-out accepts.
