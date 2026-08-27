- Admin screens and reports now show dates using the club's own recorded
  time zone rather than whatever time zone the server happens to run in.
  For a club west of Greenwich this fixes several places that were showing
  the day before: lodge nights on the bookings calendar, the dates in a
  refund-request email sent to a member, and the day a guest was counted
  against in the overlapping-guests report. Nine admin actions that ask
  "what is today?" — approving a deletion request, force-confirming a
  booking, importing members, and others — now ask the club's calendar
  instead of the server's.
- Two admin report links that ended a date range at 31 December 9999
  returned a server error. They now return a plain "that date is not
  valid" response, the same as any other impossible date.
