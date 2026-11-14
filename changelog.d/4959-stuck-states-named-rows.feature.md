- **Stuck States now names the bookings behind eight more signals (#4959).**
  Cancelled bookings with a refund not recorded, the three payment recovery
  signals, the two stale group settlements, undelivered bank transfer amount
  alerts and bookings with unnamed guests used to show only a count, so you had
  to hunt for the bookings yourself. Each now lists the bookings under the
  signal, with the owner, what is stuck and a link to the booking. At most 50
  show, with how many more there are.

  The payment lists name members and show money, so they appear only to admins
  with both Finance view and Membership view; the unnamed-guest list needs
  Membership view. Everyone else still sees the same signal and count. Each
  signal's **Open** link now goes to its list on the page, or to Background Jobs
  for payment steps the app is still retrying.
