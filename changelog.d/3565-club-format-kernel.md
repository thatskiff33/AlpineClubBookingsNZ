- **The currency and locale you set in the admin panel now reach the first
  screens (#3565).** Since the previous release a club has been able to record
  its currency and the way it formats numbers under Admin, but nothing read
  that setting: every amount on every screen was still rendered from the value
  frozen into the server image when it was built. That is the defect this
  programme exists to fix, and it is fixed a group of screens at a time.

  This release moves the shared money formatter itself and the first group of
  screens: the admin bookings list, the admin dashboard, the member dashboard,
  the member profile, the booking detail page and its payment, cancellation,
  status and guest sections, the additional-payment panel, and the mark-paid,
  refund-request and refund-approval responses. Each of those now renders in the
  currency your club recorded.

  **What a club on the shipped New Zealand defaults will notice: nothing.** Every
  amount is rendered byte-for-byte as before, which is checked by test against
  the formatter that was retired.

  **What a club that has changed its currency will notice, until the remaining
  groups land:** the screens above show the currency you recorded, and the
  screens not yet moved still show the one from the server's own settings. If
  those two differ today, the difference will be visible in the meantime. Nothing
  about how money is calculated, charged or refunded changes — this is entirely
  about how an amount is written out.
