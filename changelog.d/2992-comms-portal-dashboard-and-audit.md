- **The dashboard has a Message Board tile and a Lodge Kiosk tile (epic #2992).**
  The message board tile says how many posts have been made in the last seven
  days and opens the board; the kiosk tile opens the lodge view of who is
  arriving and leaving. Each appears only when its module is on. The recent-posts
  feed that used to sit near the top of the dashboard now sits at the bottom,
  below your bookings.

- **Message board moderation is recorded in the audit log under
  `communication`.** Hiding, showing, editing and removing a post, changing the
  retention period, and running a cleanup by hand are all recorded against the
  administrator who did them. `communication` records are readable by
  administrators with membership and support access, the same as the other
  member-visible communication records — no existing record changed category and
  nobody's access widened.
