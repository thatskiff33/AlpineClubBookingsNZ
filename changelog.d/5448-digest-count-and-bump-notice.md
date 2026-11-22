- **The officers' Daily digest counts every alert, not every subject line
  (#5407).** The digest used to count alerts with the same subject as one, so
  two members' card payments failing on the same night showed as one payment
  failure, and two Xero sync errors in a day showed as one. It now counts each
  alert once, however many officers received a copy.

  Expect the Payment failures and Xero errors numbers in particular to go up:
  those alerts always have the same subject, so they were the most
  undercounted. A subject your club saved for an alert does not change any
  count while the officers receiving that alert stay the same.

  One thing about when alerts are sent did change. An officer alert that no
  officer received, because every copy failed before the app could record it
  (for example when writing the email log failed and then sending failed
  too), used to be treated as waiting for the email retry job, which had
  nothing to send. Alerts that are sent once only are now tried again a day
  later, as they already were when nobody could receive them; a few that
  retry on their own schedule try again on it, up to their usual limit.
- **A bumped member and the officers are told even if the job is interrupted
  (#5407).** When the pending-booking job releases a booking because its dates
  filled up, it emails the member and alerts the officers. If the job was
  stopped at the wrong moment, for example by a restart, between releasing the
  booking and sending those notices, nobody was told. The job now records the
  notices as owed when it releases the booking, and a later run sends any that
  did not go out.

  A recovered notice arrives a few hours late. The officers' alert is also
  sent again later if it could not be recorded for any of them. The member
  never receives it twice. Very rarely the officers may receive their alert
  twice: when the interruption falls just after it was sent, or when sending
  it takes longer than an hour.
