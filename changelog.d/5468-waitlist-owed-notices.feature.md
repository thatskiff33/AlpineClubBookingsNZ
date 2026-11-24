- **A waitlist offer's emails are no longer lost if the job is interrupted,
  and a late offer email gets a full window (#5433).** When a place opened up
  and the job stopped between saving the offer and sending its emails, the
  member could hold an offer they were never told about until it expired, and
  nothing noticed. The member's offer email, the officers' waitlist offer
  alert, and the member's "offer expired" email are now recorded as owed when
  the change is saved, and the email retry job (every 30 minutes) sends any
  that did not go. A member never receives any of them twice.

  What members notice, by owner decision: when an offer email goes out late
  like this, the offer gets a full window from when it is sent (once per
  offer), up to the start of the check-in date in the club's time zone, and the
  email states that new deadline. If an offer lapses before its email reached
  the member (never sent, failed, bounced, or refused for a suppressed
  address), the member is not sent an "offer expired" email for an offer they
  never knew about; they keep their place in the queue, but others waiting for
  those nights are considered first for that place. A failed offer email still
  waiting to be retried when its offer ends is not sent: it moves to the
  email-failure review queue instead (a retry already under way at that moment
  still goes). For an offer made before the upgrade, whose email carries no
  offer key, a failed email is retried only while the booking holds an offer it
  could belong to (one made no later than the email, give or take two minutes),
  and moves to the review queue otherwise. The
  place is held a little longer in these rare cases, so the next person may
  wait longer.

  What officers notice: a new alert, "Waitlist email not sent", sent once when
  one of these member emails could not be sent in time or did not reach the
  member (for example a suppressed or placeholder address, where no window is
  restarted either), and once when an offer lapses before its email reached
  them, so a person can step in for the
  turn the member missed. Officers get it once per offer. It goes to officers
  who receive waitlist offer alerts (that preference mutes both), and the
  existing waitlist offer alert still goes for every offer, once it is known
  what became of the member's offer email; it says whether that email was sent,
  withheld or not delivered, and states the deadline in force rather than a
  fixed 48 hours.
  The member's booking page already showed a live offer and its deadline; it
  now shows the restarted deadline too.
