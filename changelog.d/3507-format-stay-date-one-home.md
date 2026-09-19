- **Stay dates are now formatted by one shared helper instead of fourteen
  hand-written copies (#3507).** A booking's check-in and check-out are stored
  as calendar days; read the wrong way, a club west of Greenwich would see every
  stay a day early - a mistake that shipped once before (#2870). Fourteen
  screens and the Xero activity narrative each carried their own copy of the
  correct two-step recipe. They now all call `formatStayDate` from the club-time
  kernel, a test proves that helper shows the booked night whatever zone the
  club or the viewer is in, and a census test refuses the next hand-written copy.
  Nothing a member or an officer sees changes.
