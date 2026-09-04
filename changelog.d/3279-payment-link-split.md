- **The payment-link code is split into five smaller modules, with no change to
  what members or administrators see (#2956).** The single 1,349-line
  `payment-link.ts` held five separate jobs: looking a token up, building the
  public pay page, minting a fresh link for an expired one, taking a card
  payment through Stripe, and issuing the split-guest link. Each job now lives
  in its own file, named for it, so a future fix to one cannot quietly disturb
  the others and a reviewer can read one flow at a time.

  Nothing about payment links behaves differently: the same states are shown,
  the same links are refused in the same words, the same locks are taken and
  the same emails are sent. There is nothing for a club to decide or do.
