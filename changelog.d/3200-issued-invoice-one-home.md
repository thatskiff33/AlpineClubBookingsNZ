- **Every booking-edit screen now agrees on whether the club has already sent
  the invoice (#3200).** Whether a change that adds money to a booking is billed
  as a follow-up invoice, or is simply rolled into an invoice that has not gone
  out yet, depends on one question: has this booking's main Xero invoice already
  been raised? Four screens can ask it, and one of them — adding a guest to an
  existing booking — worked it out its own way and got a different answer for a
  booking whose stay had already finished.

  All four now read the same answer from the same place, so the question cannot
  be answered two ways again. A test refuses any booking screen that works the
  answer out for itself, and reports any new screen that starts taking payment
  decisions so it can be checked too.

  Nothing an administrator does today behaves differently: the add-a-guest
  screen already refuses a booking whose stay has finished, so the disagreement
  was never reachable. It was found by reading the code, not by anything going
  wrong, and it is fixed before it could be.
