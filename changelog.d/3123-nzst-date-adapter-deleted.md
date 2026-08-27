- **There is now exactly one place in the application that turns a date or a
  time into words (#3123).** The club has always had a house style for dates —
  "16 Apr 2026", "16 April 2026", "Thu, 16 Apr 2026" — but until now there were
  two sets of helpers that produced it. The older set read the timezone from
  whatever the server container happened to be configured with, rather than from
  the timezone the club has saved on its own settings page.

  Every screen, email, report and PDF had already been moved across to read the
  club's saved timezone, so nothing a member or an officer sees changes here —
  the dates are formatted identically, character for character. What changes is
  that the older, environment-driven helpers have been deleted outright rather
  than left in place, so a future change cannot reach for them by accident and
  quietly start dating something from the server's timezone again.

  Clubs whose saved timezone and server timezone agree — which is every club
  today — see no difference at all. Nothing needs to be configured or checked.
