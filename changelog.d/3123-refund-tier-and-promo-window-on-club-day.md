- **Cancellation refunds are now tiered on the club's own calendar, and clubs
  west of Greenwich were being short-changed by a day (#3123).** A cancellation
  policy pays back a percentage that depends on how many days remain before the
  stay — "cancel 32 or more days ahead for a full refund", for example. Working
  out that number involved two different kinds of value: the stay's first night,
  which is a plain calendar date, and "today", which is a moment in time. Both
  were being converted using the timezone of the server the site runs on, and for
  a club west of Greenwich those two conversions did not cancel out — they
  compounded, and the answer came out one day short.

  The practical effect was that a member cancelling exactly on a tier boundary
  was paid the tier below the one their club's published policy promises. The
  same one-day error also reached the late-notice change fee and the refund a
  member is offered when they shorten a booking or remove a guest. The stay's
  first night is now read as the calendar date it is, with no timezone involved
  at all, and "today" comes from the timezone saved on the club's own settings
  page.

  Clubs at or ahead of Greenwich — which is every club today, New Zealand
  included — were never affected and see no change. No stored figure changes, and
  no past refund is recalculated.

- **A promotion's start and end dates are now judged by the club's calendar
  (#3123).** Whether a promo code is "not yet valid" or "expired" was decided
  against the server's date rather than the club's. For a club whose saved
  timezone differs from its server's, that could refuse a discount on the first
  day of a promotion the club had already opened, or honour one it had already
  closed — by up to a day at each end of the window. The window is now read on
  the club's own day.

- **Every remaining date decision in the application now comes from the club's
  saved timezone (#3123).** This completes the changeover: the count of places
  that could still fall back to the server's timezone for a date a member or an
  officer sees is now zero, and a test refuses to let it grow again.
