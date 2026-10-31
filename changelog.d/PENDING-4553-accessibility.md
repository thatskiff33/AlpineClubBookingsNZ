- **Error messages are readable in dark mode, and faded text and doubled
  buttons are gone (#4553).** In dark mode, red error text and the red error
  boxes used a dark red that was very hard to read on the dark background. They
  now use the lighter red the status labels already use. Light mode and printed
  pages look the same as before.

  The short descriptions under the Card and Internet Banking payment choices
  (group bookings, joining a group, and admin booking for a member) and the
  times in the calendar's event lists were faded below a readable contrast.
  They now use their normal text colour.

  Fourteen buttons that go to another page, such as "New Booking", "Back
  to sign in" and "View in Xero", were a button inside a link, so keyboard and
  screen-reader users met two controls for one action. Each is now one link
  that looks the same as before. A lint rule now stops a link and a button
  from being nested again.
