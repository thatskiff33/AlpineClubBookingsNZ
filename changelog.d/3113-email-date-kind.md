- **Dates in emails no longer shift when a club edits a template's wording, and
  a lodge night is now the night itself wherever the club is (#3113).** Every
  message this system sends can be rendered two ways: from the built-in wording,
  or — once anyone has saved an edit to that template — from the values the
  sender prepared. Those two paths disagreed about dates, so the same booking
  could reach one member with one date and another member with a different one,
  purely according to whether their club had ever reworded that email.

  Fixing it needed the two kinds of date in these messages to be told apart,
  because they need opposite treatment. A **lodge night, roster date or season
  date is a calendar day** — 1 August is 1 August — so no timezone should be
  consulted at all; it is now rendered without one. A **deadline or a timestamp
  is a moment**, so it is now always shown in the club's own timezone, on both
  paths. 273 places across the email surface were reclassified this way.

  For a club in New Zealand nothing visibly changes: every date reads exactly as
  it did. The messages that were wrong were those sent by a club whose timezone
  is behind Greenwich, where a lodge night could be named a day early — and a
  club running its own server in one zone while set to another could see a
  payment deadline out by half a day. Both are corrected.

  Nothing stored was rewritten and no booking, night or deadline was changed —
  only the wording of what a member is told.

  One admin alert is also fixed on the way through. The alert that warns
  officers a payment needs attention by hand is sometimes raised for a money
  event whose booking cannot be looked up — a group settlement that has been
  superseded, for instance. It used to fill the two stay dates in with the
  current date and time; once a lodge night was correctly no longer allowed to
  be a time of day, that stopped the alert being sent at all, and nothing
  reported it because the send is deliberately non-blocking. Those dates now
  read "Unknown" and the alert arrives.
