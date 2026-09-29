- **A late card payment refunded through the Xero repair tool no longer
  records a refund of money Xero never received (#3635).** When the repair
  tool refunded a card payment that went through after its booking was
  cancelled, it raised a refund credit note against the booking's original
  invoice. That invoice had already been cleared at the cancellation, so Xero
  showed money leaving the Stripe account that had never come in. The tool now
  records the refund the same way the automatic refund does, and raises a
  refund note only when the payment itself was recorded in Xero. Otherwise its
  result says to reconcile the Stripe bank lines by hand. The refund-note link
  repair script (`scripts/xero-refund-note-link-repair.ts`) now uses the same
  figures as the rest of the app. It no longer re-links a note for a refund of
  that kind, and it counts notes an officer resolved in Xero, so it stops
  reporting gaps that are not there.
- **An Internet Banking group is kept on check-in day, the same as a single
  booking's hold (#3635).** If the group settlement runs out of time while the
  group's combined invoice cannot be read, the group now keeps its beds for up
  to seven days past the deadline, the same as a single booking's hold. Once
  check-in arrives, the group is kept rather than released, whether Xero
  shows the invoice unpaid, no longer has it, or cannot be read, and the
  treasurer gets one email. The organiser may already have paid by bank
  transfer. Before this change the group was released at check-in and its
  joiners were cancelled.
- **Held bookings whose stay has started no longer use up the Xero read
  allowance (#3635).** The Internet Banking hold job now leaves a stay that has
  started alone before it reads Xero, so a few such holds can no longer use up
  the day's reads and hold other expired bookings' beds for up to a day.
- **Treasurer alerts nobody can receive are retried once a day, not every 15
  minutes (#3635).** This covers a "hold needs attention" email that reached
  nobody, for example because every admin address is suppressed or the site is
  a staging copy. It is now tried again a day later, and the same goes for one
  owed after the hold was released. Before, it was re-sent and audited on
  every run. The alert that Stripe holds a card payment this system never
  recorded now follows the same rule. It used to be lost for good if its one
  send failed or reached nobody.
