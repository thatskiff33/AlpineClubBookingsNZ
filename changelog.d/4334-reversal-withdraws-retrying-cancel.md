- **Reversing a payment recorded outside the app no longer leaves a stuck card
  cancellation that refunds the member's next card payment (#4320).** When an
  officer records a booking as paid outside the app (cash or bank transfer),
  the app cancels any card payment the member still had open. If Stripe was
  unreachable at that moment, the cancellation waited to retry. Reversing the
  payment used to leave that waiting cancellation behind. If the member then
  paid by card in the page they still had open, the payment was refunded and
  the booking stayed unpaid.

  The reversal now works out again, from the booking as it stands, which open
  card payments are out of date. It keeps cancelling those, including one an
  edit had already queued, and restarts a cancellation that had given up or
  was on its last try. It withdraws the cancellation of the one the booking
  can still be paid with, even one waiting to retry or one that has given up.
  A saved-card charge is judged against the booking's full value: the amount
  the app's automatic saved-card charge takes, and the amount it accepts a
  card payment at. A card request for an extra the reversal puts back to owing is
  found even when the cash settlement had hidden it, as long as it is still
  open and not one the reversal keeps cancelling. The booking points at it
  again, so when the member pays it the extra reads as paid and is no longer
  chased, and an officer can still withdraw it. A card payment the member makes while the reversal is
  running now waits for it, then pays the booking. The reversal's audit entry
  lists every cancellation it withdrew or restarted, every card payment still
  being cancelled, and the card request the extra points at again.
  Reversals made before this release may have left a cancellation behind, or
  a hidden card request with nothing cancelling it: `docs/UPGRADING.md` has
  read-only queries to find both and what to do.
