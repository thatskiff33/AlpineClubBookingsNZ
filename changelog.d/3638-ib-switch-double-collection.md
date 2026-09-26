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
  again in a few minutes. No invoice is raised either way.
  And if a booking that a card payment has already settled is later paid by
  bank transfer as well, the Xero sync now alerts the admins and records the
  conflict on the booking instead of passing over it. Nothing is refunded
  automatically: the admin alert explains how to check whether it is really
  a second payment, and deciding which payment to return is left to the
  treasurer and the member.
