- **A refund of a replaced payment is announced again when a stalled attempt
  made it (#4690).** When a member pays a payment request the club had already
  replaced, the payment recovery queue refunds it and tells the member and the
  admins. If that refund attempt stalled long enough for the queue to hand the
  job back, the refund still went through but nobody was told: not the member,
  and not the admins.

  The notice now belongs to the refund itself. It goes out exactly once
  whichever attempt makes the refund, including one that stalled, and the next
  attempt sends it if the first stopped before it could. A refund some other
  part of the system made is never announced as this one. The member's email
  now goes out through the email retry job, so it can arrive about 15 minutes
  after the refund.
