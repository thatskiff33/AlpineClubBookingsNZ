- **A waitlist offer's emails are no longer lost if the job is interrupted,
  and a late offer email gets a full window (#5433).** When a place opened up
  and the job stopped between saving the offer and sending its emails, the
  member could hold an offer they were never told about until it expired, and
  nothing noticed. The member's offer email, the officers' waitlist offer
  alert, and the member's "offer expired" email are now recorded as owed when
  the change is saved, and the email retry job (every 30 minutes) sends any
  that did not go. A member never receives any of them twice.

  What members notice, by owner decision: when an offer email goes out late
  like this, the offer gets a full window from when it is sent, up to the
  start of the check-in date, and the email states that new deadline. If an
  offer lapses before its email could be sent at all, the member is not sent
  an "offer expired" email for an offer they never knew about. The place is
  held a little longer in these rare cases, so the next person may wait longer.

  What officers notice: a new alert, "Waitlist email not sent", sent once when
  one of these member emails could not be sent in time, so an officer can
  contact the member. It goes to officers who receive waitlist offer alerts.
  The member's booking page already showed a live offer and its deadline; it
  now shows the restarted deadline too.
