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

  For a New Zealand club running on New Zealand time nothing changes at all —
  the old answer and the new one are the same instant. What changes is a club
  whose server is somewhere else, or which has set its timezone to a different
  place from the one the machine is in: those links now expire when the club
  says, and a booking's beds are held for the whole of the club's check-in day
  rather than being released early.

  **Links already sent keep the expiry they were issued with.** Nothing stored is
  rewritten, which is the same promise the club timezone setting itself makes:
  changing it moves no recorded moment. Every existing link stops working at the
  time its own email stated, and expires by itself within the booking's own dates.
  A club that wants an existing link moved onto the new boundary can simply
  re-issue it — the "email me a new link" button and the club's own re-send both
  mint a fresh one.
