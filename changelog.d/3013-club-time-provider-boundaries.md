- Dates that come from Xero are now read correctly whichever of the four
  shapes Xero sends them in. One of those shapes carries no timezone at all,
  and it was being read as if it were the server's local time — which stored
  a member's joining date a day early, could make a paid member look unpaid
  if their subscription invoice fell on the first day of a season, marked an
  invoice overdue halfway through the day it was actually due, and quietly
  dropped invoices with that shape out of the aged-receivables report.
- The nightly jobs, the emails, the finance exports and every date sent to
  Xero now use the club's recorded time zone rather than whatever time zone
  the server happens to be set to. Cron health pages no longer tell clubs
  outside New Zealand that their jobs run at "2:20 AM NZST".
- The club time zone screen now says what actually happens when you change
  it: the nightly jobs keep the old zone until the application is restarted,
  and the system health page tells you while that restart is outstanding.
