- **Every sign-in now ends after a fixed time, however busy it is (#4611).**
  Until now a session ended only after 8 hours without use, and every page load
  pushed that forward, so a browser in daily use, or a stolen session cookie,
  could stay signed in for ever.

  Each sign-in now also lasts at most a set time, counted from when the person
  signed in. Nothing extends it: not using the site, not a role change, not a
  two-factor check. When the time is up the next page sends the person to sign
  in again. The default is 7 days; a club can choose any whole number of hours
  from 8 to 720 (30 days) under **Admin → Login & Security → Password policy**
  ("Sign members out after (hours)"), and a change applies to people already
  signed in. The lodge kiosk account keeps its own 30 days, which the club
  setting does not change, so the lodge tablet must be signed in again once a
  month.

  On upgrade, anyone who signed in more than 7 days earlier (30 days for the
  lodge tablet) is asked to sign in again on their next page load.
