- **A lost card refund that fails late no longer wipes out a card refund
  shortfall the treasurer already paid back by bank (#4488).** Example: a
  $300 booking paid $200 by card (charge A) and $100 by internet banking
  (charge B) is cancelled. The $200 card refund is lost, so the treasurer
  closes it "Paid another way" and pays back the $100 the card could not carry.
  If Stripe later records that lost card refund and then reports it failed,
  charge A used to drop to $100 and the payment to show $200 refunded while
  $300 went back, offering $100 that could be refunded a second time. It now
  stays at $200, and the payment at $300. The same holds for a capacity race's
  shortfall paid back by bank. An ordinary bank hand-back on another charge is
  still not counted. Payments already left short are not repaired: the
  read-only `pnpm run payments:audit-refunded-total` now counts this bank cash
  and lists any such payment for a person to correct.
