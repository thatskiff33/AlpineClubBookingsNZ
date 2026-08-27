- **The admin sidebar's "Unpaid Finished Stays" link now uses the club's own day,
  and keeps using the right one when the tab is left open (#3123).**

  That link in the Needs Attention list opens the bookings list filtered to stays
  that have already ended and are still unpaid, and the number in the badge
  beside it counts exactly the same thing. The filter's cut-off date was being
  worked out from the timezone of the machine the site runs on, while the count
  was worked out from the timezone the club has saved on its own settings page.
  For a club whose two do not match, the link and the number beside it were
  describing different days — so the list could open a booking short, or one long,
  of what the badge had promised. The same link is offered in the Ctrl-K search
  palette, which had the same cut-off and therefore the same discrepancy.

  Separately, and in every timezone, that cut-off was worked out **once** when the
  page was first loaded and never again. An administrator who left the admin panel
  open overnight came back to yesterday's filter sitting next to a count that had
  been refreshed for today. Both the link and the palette now work the date out
  each time they are drawn, from one shared place, so the two can no longer
  disagree with each other and neither goes stale.

  Nothing needs configuring. A club whose saved timezone matches its server's —
  which is every club today — sees only the second fix: the link keeps up with the
  date, instead of being frozen at whenever the page was opened.

- **The bed board's default seven-night window now starts on the club's own day
  (#3123).**

  Opening **Admin → Bed Allocation** without picking dates shows the next seven
  nights starting today. "Today" was read from the server's timezone rather than
  the club's, and the same default was used by the board's **Auto-allocate** and
  **Approve** actions when they are run without an explicit date range — so for a
  club whose saved timezone is behind its server's, those two could allocate and
  approve over a window starting a day early. All three now start from the club's
  own day, worked out once per request.

  For a club whose saved timezone matches its server's the window is unchanged.
  For any other, the board opens on the club's date and the two write actions act
  on the same nights the board is showing.
