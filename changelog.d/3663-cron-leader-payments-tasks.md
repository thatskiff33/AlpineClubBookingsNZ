- **Expired Internet Banking holds are now released, and stale waiting Xero
  invoices settled, on the standard deployment** (#3663). The app's built-in
  scheduler ran only Stripe payment recovery every 15 minutes; releasing an
  Internet Banking booking whose payment deadline had passed, and the clean-up
  of a booking change's waiting Xero invoice, ran only when something outside
  the app called the payments cron address, which the standard Docker Compose
  deployment never does. Both now run every 15 minutes alongside payment
  recovery, through the same code the cron address uses, and each shows as its
  own job on the admin cron-health page, so one that stops running is visible.
  One job failing no longer hides or stops the others. **On the first run after
  upgrading, every hold that expired while nothing ran is released.**
