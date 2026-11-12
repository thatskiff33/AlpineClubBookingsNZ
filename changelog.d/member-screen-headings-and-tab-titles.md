- **Member screens now have their own tab title and a real main heading, so
  screen-reader users can tell tabs apart and jump to the page's heading
  (#4951).** The payment link, reset and change password, verify email, confirm
  email change, family invite, membership cancellation, lodge maintenance
  report, nomination and booking-request screens now expose their card title as
  a level-1 heading in every state (loading, invalid link, success, error).
  Those screens, plus login, dashboard, my bookings, a single booking and a
  single notice, get a fixed tab title such as "Reset your password | <Club>"
  — never a name, amount or token. Nothing looks different. A new census test
  stops any member-facing card title from leaving its heading level
  unclassified, and holds the remaining admin titles at a falling baseline
  (`INV-PUB-004`).
