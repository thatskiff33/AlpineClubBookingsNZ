- **Xero repair messages show readable currency amounts (#3589).** Officer-facing
  error and recovery text, including legacy applied-credit repair errors and
  the rate-derived night-price backfill report, now renders the club's currency
  instead of raw cent numbers. Booking cancellation, edit, and cron repair paths
  only pass that display setting through; integer-cent accounting fields,
  provider behavior, and booking outcomes are unchanged.
