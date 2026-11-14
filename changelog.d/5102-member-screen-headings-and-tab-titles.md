- **Member screens now have their own tab title and a real main heading, so
  screen-reader users can tell tabs apart and jump to the page's heading
  (#4951).** The payment link, reset and change password, verify email, confirm
  email change, email sign-in link, family invite, membership cancellation,
  lodge maintenance report, nomination, notice, school attendee confirmation,
  guest consent and booking-request screens now expose one level-1 heading in
  every state (loading, invalid link, success, error). Those screens, plus
  login, dashboard, my bookings and a single booking, get a fixed tab title
  such as `Reset your password | <Club>`, never a name, amount or token. The
  cards on the dashboard and on a single booking sit under that heading as
  level-2 headings. A census test stops a card title under the member-facing
  pages, or in the member cards it lists, from leaving its heading level
  unclassified, and holds the other titles (admin, finance and the member
  components shared across page types) at a falling baseline (`INV-PUB-005`).
  Nothing looks different, except that an H1 an admin puts inside a notice now
  renders as a level-2 heading, so a notice keeps one main heading.
