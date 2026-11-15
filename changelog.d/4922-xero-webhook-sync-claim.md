- **A Xero change no longer starts a second full sync while one is already
  running (#4922).** When Xero tells the club a contact, invoice or payment
  changed, the catch-up the app starts now waits its turn behind the
  15-minute scheduled sync and the treasurer's "Sync from Xero now" button.

  If another sync is running, the catch-up still applies the changes Xero just
  sent, straight away, and leaves the rest to the sync already running. This
  avoids doubling the club's Xero calls, which could hit Xero's rate limit and
  delay contact and membership updates. Webhook catch-ups do not appear in the
  admin cron health list. Nothing about balances or bookings changes.
