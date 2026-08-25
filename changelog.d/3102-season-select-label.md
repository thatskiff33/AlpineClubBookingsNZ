- **Groundwork: the membership season picker now works its month names out from
  the club's financial year-end instead of assuming April — with no visible
  change yet (#2870).** Nothing on the Subscriptions page looks different on any
  deployment today, including a club whose financial year does not end in March.
  Every club still sees `2026 - 2027 (Apr-Mar)`, exactly as before.

  What was wrong is that the label was fixed text on both halves. April is not
  the rule: a club's season starts the month after its financial year-end, so a
  club with a June year-end runs July to June, and a club with a December
  year-end runs January to December — one calendar year, not two. Both halves are
  now worked out from that setting rather than written out, and a single-calendar-
  year season is named as the one year it is.

  The reason nothing moves yet is that the year-end month is read on the server
  and does not yet reach this screen — and neither does the season year the
  picker selects, which reads the same setting. Sending one without the other
  would leave the picker naming one season and selecting another, so the two are
  deliberately left to arrive together. This closes the last of three fixed date
  assumptions the page was carrying, so that when the setting does reach the
  screen the label follows it instead of quietly contradicting it.
