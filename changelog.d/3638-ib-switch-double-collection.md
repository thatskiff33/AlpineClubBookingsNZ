- **Switching a card booking to internet banking can no longer charge the
  member twice without anyone knowing (#3638).** A member could press "Pay by
  internet banking instead" while their card payment was already going through.
  The switch tried to cancel the card payment but ignored whether it worked, so
  the card payment could still land and mark the booking paid while the member
  was also emailed a Xero invoice for the full amount. If they paid that invoice
  too, the club held the price twice and nothing flagged it.
  The switch now refuses unless the card payment is really cancelled. If the
  card payment has already gone through, the member is told so and asked to
  refresh the page; if the cancel could not be confirmed, they are asked to try
  again in a few minutes. No invoice is raised either way. A card payment that
  the club had already refunded does not count, so a booking repriced after a
  refund can still switch.
  Once a booking has switched, neither the card payment page (even one left
  open in another tab) nor an emailed payment link will take a card payment
  for it; the page says the booking is being paid by internet banking.
  And if a booking that a card payment has already settled is later paid by
  bank transfer as well, the Xero sync now alerts the admins and records the
  conflict on the booking instead of passing over it. Nothing is refunded
  automatically. The alert, "Booking may have been paid twice — card and
  Xero", cannot be switched off; it links the booking and the Xero invoice and
  explains how to check whether it is really a second payment, and deciding
  which payment to return is left to the treasurer and the member. The
  conflict also shows on the booking's history for staff. The same alert
  covers a card-paid booking that was cancelled before the bank transfer
  arrived, which used to be passed over in the same way. A repayment by bank
  transfer after an earlier card refund is not flagged.
  A repeated Xero notice for a completed internet-banking booking no longer
  turns it back into "paid" or re-sends the booking confirmation.
