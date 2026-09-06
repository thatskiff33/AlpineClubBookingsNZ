- **The "Confirm pending guests" button works again after a failed automatic
  charge, and every charge of a saved card is tracked as its own attempt
  (#3267).** Three different parts of the system can charge the card saved on
  a pending booking: the scheduled charge at the hold deadline, an
  administrator's "Confirm pending guests" button, and the charge-saved-method
  endpoint. Until now all three asked Stripe using one shared reference for
  the booking, and Stripe insists that every request under one reference be
  word-for-word identical. The administrator's request was not — so whenever
  the scheduled charge had run recently, the button could only ever fail with
  a message about "idempotent requests" that said nothing about the real
  problem. In production that hid a dead card for a day. A member re-saving
  their card ran into the same wall.

  Each charge attempt now gets its own reference and its own line in the
  booking's payment history, written before Stripe is asked, under the same
  locks that already stop two parts of the system claiming a booking at once —
  so two attempts can never charge one booking twice, which is what the shared
  reference used to guarantee. If an earlier attempt is still unresolved
  (waiting on the cardholder, or Stripe never answered), the next attempt asks
  Stripe what happened to it rather than charging again. If the earlier
  attempt definitely failed, the next one starts fresh straight away: the
  button works, and a freshly saved card is charged at once instead of after a
  day. If the earlier attempt was on a card that has since been replaced, it is
  closed and its charge cancelled. When a charge does not complete, the
  administrator now sees Stripe's own words. The charge-saved-method endpoint
  also now holds the booking's places while it charges, exactly as the other
  two paths do. No operator action is needed.

  Three more cases are now handled rather than hoped about. If an earlier
  attempt's payment is still going through at the card network, the system
  waits for it instead of starting a second charge beside it — a card payment
  in that state cannot be cancelled, and the old code read that refusal as
  "nothing to do". If a charge was sent but Stripe's reply never arrived, the
  payment confirmation Stripe sends separately is now matched back to the
  attempt that made it, so the money is recorded; and if that has not happened
  within a day, the system refuses to re-send rather than risk charging twice,
  and alerts an administrator to check Stripe — repeating that alert on the
  same reducing schedule the other stuck-booking alerts use, instead of eight
  times a day. Finally, a charge that is still being attempted no longer
  clears the booking's payment link, which could leave a member with a payment
  page that would not go through.

  Three smaller corrections went in with the review of that work. The
  stuck-booking alert now starts counting from the moment the system can first
  see the problem rather than from when the payment record was last written:
  money captured against a booking days before its hold ran out used to slip
  past the first alert entirely, and could go nearly a fortnight unreported. If
  a booking is cancelled by somebody else while its card is being charged, that
  now shows up as a failed booking on the run rather than passing quietly — a
  booking already paid by then still does not, because that is the ordinary
  case. And when a charge does not go through, the alert to administrators
  quotes the amount that was actually asked for, which matters if the booking's
  price changed between the moment it was read and the moment it was charged.

  One more correction covers the changeover itself. A charge that was already
  under way when this release goes out was recorded in the old style, without
  the new per-attempt reference. If the member had since saved a different
  card, the system would not have recognised that older charge as this
  booking's money and could have charged the new card beside it. Such a charge
  is now recognised by what it was for, whichever card it names: it is closed
  and cancelled if it can be, and waited for if it is still going through at
  the card network. This applies to all three ways a saved card is charged, and
  it stops mattering once the charges that were open at the changeover have
  finished.
