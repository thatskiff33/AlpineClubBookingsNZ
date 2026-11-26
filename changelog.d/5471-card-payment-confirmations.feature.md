- **A member's booking confirmation after paying by card is no longer lost if
  the app is interrupted (#5433).** When a card payment was saved and the app
  stopped before the confirmation email went, the member was never sent it:
  Stripe's repeat notice, a retried payment page and the next scheduled run all
  found the booking already paid and sent nothing. The confirmation is now
  recorded as owed with the payment itself, and the email retry job (every 30
  minutes) sends any that did not go, so it can arrive late, usually within an
  hour. This version never sends a member it twice; while a server still runs
  the previous version during the upgrade, that server's scheduled job can
  send a second copy. This covers a card payment on the booking page, one
  confirmed by Stripe's notice, and the scheduled charge of a saved card; the
  other ways a booking is confirmed are unchanged for now.

  What members notice, by owner decision: a late confirmation is built from the
  booking as it is when it goes (its dates, guests, lodge and door code then,
  and any price rise since that is not yet paid, shown as still owing). It is
  not sent once the booking is cancelled (with or without a refund), deleted,
  or its payment reversed; a partial refund that leaves the booking paid does
  not stop it. Late retries go on until the end of the check-in day, or for
  seven days after the payment if that comes first; a payment recorded after
  the check-in day still gets its confirmation straight away, as before. The
  scheduled saved-card charge's confirmation now matches the booking page's: it
  explains non-member guests charged separately and shows an unpaid extra as
  still owing, and it no longer sends a second confirmation when Stripe's
  notice settled the same charge first.

  What officers notice: a new alert, "Booking confirmation not sent", sent once
  per paid booking when its confirmation could not be sent in time, or did not
  reach the owner: the send failed, the address bounced or is on the
  suppression list, or the owner has no address that can be emailed (a walk-in
  with a placeholder address, or an organisation with none). It names the owner
  and the booking so an officer can contact them, or send a fresh confirmation
  while the booking is not yet completed, and it goes to officers who receive
  "Booking review required" alerts.
