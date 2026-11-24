- **A member's booking confirmation after paying by card is no longer lost if
  the app is interrupted (#5433).** When a card payment was saved and the app
  stopped before the confirmation email went, the member was never sent it:
  Stripe's repeat notice, a retried payment page and the next scheduled run all
  found the booking already paid and sent nothing. The confirmation is now
  recorded as owed with the payment itself, and the email retry job (every 30
  minutes) sends any that did not go, so it can arrive late, usually within an
  hour. A member never receives it twice. This covers a card payment on the
  booking page, one confirmed by Stripe's notice, and the scheduled charge of a
  saved card; the other ways a booking is confirmed are unchanged for now.

  What members notice, by owner decision: a late confirmation is built from the
  booking as it is when it goes (its dates, guests, lodge and door code then,
  and any price rise since that is not yet paid, shown as still owing), and it
  is not sent at all for a booking cancelled, refunded or deleted in the
  meantime.

  What officers notice: a new alert, "Booking confirmation not sent", sent once
  per paid booking when its confirmation could not be sent by the end of the
  check-in day (or within seven days of the payment), or did not reach the
  owner: the send failed, the address bounced or is on the suppression list,
  or the owner has no address that can be emailed. It names the owner and the
  booking so an officer can send a fresh confirmation or contact them, and it
  goes to officers who receive "Booking review required" alerts.
