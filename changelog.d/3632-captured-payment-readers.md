- **Payment readers now share their captured-status definitions (#3632).** Xero
  invoice handling, finance figures, admin reports, the modification-payment
  confirmation and the Stripe webhook's replay handling now use the aggregate
  `Payment` or the individual `PaymentTransaction` definition that matches the
  row being read. Current cash, invoice and replay results are unchanged; the
  two meanings can now move independently.

- **The Internet Banking applied-credit audit reads settlement evidence, not the
  payment mirror (#3632).** A row is reported as an already-realized double-pay
  only when a captured bank-transfer receipt names the payment's current Xero
  invoice, or the payment carries the manual-settlement stamp. Every other row
  is reported as UNVERIFIED for an officer to check, rather than as "pending":
  an inbound credit-note repair can make an unpaid bank-transfer payment's
  mirror read refunded. The `--json` keys `pending` / `pendingExposureCents`
  are now `unverified` / `unverifiedExposureCents`.
