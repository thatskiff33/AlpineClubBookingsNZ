- **The last screens and services that worked out a date for themselves now ask
  the club's own calendar instead (#2870).** For a club in New Zealand nothing
  visible changes — every label, heading and filter is the same as before. For a
  club west of Greenwich, three of these were showing the wrong day, and the rest
  were one edit away from doing so.

  This is the sweep that finishes the club-time migration. Most of it is
  bookkeeping: forty-odd places had each written out their own copy of "which
  calendar day is this", "what is today at the club", or "how do we print this
  date", and they now share one answer. Where a screen was already printing the
  right day, it still prints exactly the same characters — the change is that
  there is now one place to correct rather than forty.

  Three were genuinely wrong rather than merely duplicated, all in finance and
  calendar surfaces that read a date through the server's timezone instead of
  the club's: a finance chart's month labels, a finance date-range picker, and
  the events calendar's own month heading. A club whose server sits behind
  Greenwich would have seen those name the previous day, and at the turn of a
  month, the previous month.

- **A rule in the developer documentation would have broken every scheduled job
  if somebody had followed it (#2870).** It said a module that nothing
  command-line-reachable touches should use the request-cached way of reading the
  club's timezone. Measured across the nine places that read it, only one is
  reachable that way — the other seven are the nightly jobs and the configuration
  transfer, and the check that decides "reachable" cannot see them by design,
  because the scheduler loads each job lazily at run time rather than importing
  it up front. Following the rule would have put a server-only guard on seven
  cron modules and broken each of them at its first tick. The rule now says so.
