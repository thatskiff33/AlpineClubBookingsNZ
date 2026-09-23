- **The currency and locale you set in the admin panel now reach every amount
  the product writes (#3565).** Since the previous release a club has been able
  to record its currency and the way it formats numbers under Admin, but nothing
  read that setting: every amount on every screen, in every email and in every
  description sent to Xero was still rendered from the value frozen into the
  server image when it was built. That is the defect this programme exists to
  fix, and this release fixes it for money in one move.

  Every screen that shows an amount — the booking flow, the member dashboard and
  booking pages, the admin bookings, payments, refunds, promo codes, members,
  fees, subscriptions, reports, health and AI pages, the finance dashboard, the
  lobby display and the public booking-request and payment pages — every email
  that names an amount, and every line of text this product writes into Xero,
  now renders in the currency and number format your club recorded. There is no
  longer a way to write out an amount without saying which club's format it is
  in, so no future screen can quietly fall back to the server's own value.

  **What a club on the shipped New Zealand defaults will notice: nothing.** Every
  amount is rendered byte-for-byte as before, in screens, emails and Xero text
  alike, which is checked by test against the formatter that was retired.

  **What a club that has changed its currency will notice:** every amount, on
  every surface, now shows the currency you recorded. Dates and times still
  follow the server's `LOCALE` setting and move in a later release, so keep
  that one matching the format you recorded until then. Nothing about how money
  is calculated, charged or refunded changes — this is entirely about how an
  amount is written out.
