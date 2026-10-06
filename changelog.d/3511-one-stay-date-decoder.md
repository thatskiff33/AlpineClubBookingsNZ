- **Stay dates are now read the same way on every screen.** A booking or season
  date that arrives in an unusual form, an offset-less timestamp such as
  `2026-07-04T13:45:00`, used to show a dash on some admin screens, and nothing
  on a few member pages. It now shows the day it names, "4 Jul 2026", everywhere.
  Every other date, and every other fallback for a value that is not a date at
  all, renders exactly as before. Behind it, one decoder (`formatStayDate` and
  `formatStayDateOrNull`) now replaces about thirty copies, and a check fails the
  build if a new one appears.
