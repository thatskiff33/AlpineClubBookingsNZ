- **The membership season picker now names its months from the club's own
  financial year-end instead of assuming April (#2870).** The Subscriptions page
  labelled each season `2026 - 2027 (Apr-Mar)`, with both halves written out as
  fixed text. April is not the rule — a club's season starts the month after its
  financial year-end, so a club with a June year-end runs July to June and a
  club with a December year-end runs January to December, all within one calendar
  year. Both halves of the label are now worked out from that setting, so they
  cannot drift away from it, and a December year-end is named as the single year
  it is rather than as a span.

  **Nothing on the page looks different today.** The year-end month is read on
  the server and does not yet reach this screen, so every club still sees
  `2026 - 2027 (Apr-Mar)` exactly as before. This closes the last of three
  hard-coded date assumptions the page was carrying — the other two were fixed
  earlier in the same work — so that when the setting does reach the screen the
  label follows it instead of quietly contradicting it.
