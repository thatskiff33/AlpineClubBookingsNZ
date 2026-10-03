- **An operator can now check, booking by booking, that the new booking ledger
  agrees with the money figures the app shows today (#3583).**
  `pnpm run booking-ledger:census` compares each booking's price, payments,
  applied credit, refunds, change fees and outstanding extra payment with the
  ledger lines that record them, and lists every booking where they differ,
  with both figures. Differences the club expects - a refund still on its way,
  a hand-back an officer has not yet made, a review charge the club kept - are
  named rather than reported as errors, but only when they explain the
  difference to the cent, and each still needs the owner's sign-off before
  the verdict is clean. It reads one snapshot, changes nothing, and ends with
  a verdict: the ledger is not used for anything a member or officer sees until
  that verdict is clean. Bookings the owner has already dealt with can be
  listed in a file the census reads, to the cent, so they stop holding it up;
  if a figure changes afterwards it is flagged again. The older
  internet-banking applied-credit report it replaces is now a section of its
  output, listing each booking.
