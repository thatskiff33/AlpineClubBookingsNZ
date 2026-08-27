- **A payment link now really does expire at the end of the check-in day in the
  club's own time, which is what the page and the email have been saying (#2870).**

  When the club emails a secure pay link, the email and the pay page both tell
  the payer exactly when it stops working — "This payment link expires on
  17 Apr 2026, 11:59 pm". That sentence was made accurate earlier in this work.
  What was still wrong was the deadline itself: it was worked out from the
  server's own timezone rather than from the timezone the club has set. For a
  club whose site runs on a machine set to somewhere else, those are different
  moments, and the link died at a time nobody had been told.

  The same deadline decides three other things, and one of them holds a bed.
  Once the check-in day has passed, an unpaid booking made through a booking
  request is automatically cancelled and its beds are released to the next person
  on the waitlist. That decision, the matching one for an unpaid guest portion of
  a split booking, and the refusal to issue a link that would be born expired all
  now read the boundary from the same single place as the link itself, so they
  cannot drift apart. Previously each worked it out separately, with a note
  beside them saying they agreed.

  For a club whose configured timezone matches its server's, nothing changes at
  all — the old answer and the new one are the same instant. What changes is a
  club that has set its timezone to somewhere other than where its machine is,
  and **which way it changes depends on which of the two is ahead**. A club whose
  own timezone is *ahead* of its server's — a New Zealand club on a machine set
  to UTC, which is the common case — reaches the end of its check-in day sooner
  in real terms, so its links now have a **shorter** life than before and beds
  come back to the waitlist **earlier**, not later. A club whose timezone is
  *behind* its server's gets the opposite: a longer link and beds held longer. In
  both directions the link now dies when the club's own day ends, which is what
  the page and the email have been telling payers; the point is that this is not
  uniformly "beds held longer", and an operator on the common setup should expect
  slightly shorter holds.

  **Links already sent keep the expiry they were issued with.** Nothing stored is
  rewritten, which is the same promise the club timezone setting itself makes:
  changing it moves no recorded moment. One consequence is worth knowing, and it
  is the direction above again: for a club whose timezone is ahead of its
  server's, the overnight job now works the club's day out afresh, so it can
  cancel an unpaid request and revoke its link **before** the moment that link's
  own email stated. That affects only requests approved and still unpaid at the
  moment this ships, it is at most about a day, and it clears itself as those are
  paid or lapse. A club that wants any existing link moved onto the new boundary
  can simply re-issue it — the "email me a new link" button and the club's own
  re-send both mint a fresh one, and a fresh link and the overnight job then agree
  exactly.

- **A club that has edited the wording of a payment-link email now gets the same
  deadline in it as a club that has not (#2870).**

  The two emails that carry a secure pay link — the one sent when a booking
  request is approved, and the one asking a member to pay for their non-member
  guests — both state when the link stops working. If the club had opened
  **Admin → Email Messages** and saved its own wording for either of them, that
  sentence was being worked out from the server's timezone instead of the club's,
  while the unedited version used the club's. On a club whose server is set to
  somewhere else the two named different times of day, and in one direction a
  different date — so simply having reworded the email could tell a payer the
  wrong deadline. Both now use the club's timezone, so editing the wording cannot
  move the deadline.
