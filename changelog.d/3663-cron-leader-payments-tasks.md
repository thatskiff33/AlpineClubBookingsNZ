- **Expired Internet Banking holds are now released, and stale waiting Xero
  invoices settled, on the standard deployment** (#3663). The app's built-in
  scheduler ran only Stripe payment recovery every 15 minutes; releasing an
  Internet Banking booking whose payment deadline had passed, and the clean-up
  of a booking change's waiting Xero invoice, ran only when something outside
  the app called the payments cron address, which the standard Docker Compose
  deployment never does. Both now run every 15 minutes alongside payment
  recovery, through the same code the cron address uses, and each shows as its
  own job on the admin cron-health page, so one that stops running is visible.
  One job failing no longer hides or stops the others, and a hold that could
  not be released shows as a warning. A booking whose stay has already started
  is never cancelled this way: it is left alone and the treasurer is emailed
  once to reconcile it by hand. **On the first run after upgrading, every
  expired hold that has no money paid against it and whose stay has not
  started is released:** the booking is cancelled, the member is emailed, any
  account credit they used is restored and the unpaid invoice is cleared.
  Before upgrading, reconcile outstanding Internet Banking payments and count
  the expired holds (see the deploy note in `DEPLOYMENT.md`).
