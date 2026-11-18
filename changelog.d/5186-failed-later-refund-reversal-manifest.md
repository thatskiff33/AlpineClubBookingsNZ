- **The Xero invoice that returns a failed card refund's money to the Stripe
  account is now checked against the booking's own ledger.** When the app
  raises that invoice at a "Paid another way" close, it records whether the
  invoice matches the failed refund the ledger reversed, or why not. What is
  sent to Xero, and when, is unchanged. Clubs need to do nothing.
