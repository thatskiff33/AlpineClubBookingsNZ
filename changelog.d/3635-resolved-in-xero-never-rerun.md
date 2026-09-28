- **A Xero operation marked "resolved in Xero" is now treated as done, and
  nothing re-runs it automatically (#3635).** On the Xero operations panel an
  officer can mark a failed operation resolved once they have fixed it by hand
  in Xero. Until now most of the system ignored that mark: the repair tool could
  retry it automatically, a retry queued earlier still ran, a stale browser tab
  could still send one, and the nightly refund check or "Queue all" on the
  missing-invoices list could raise the document again. Any of those could apply
  the same fix twice in Xero, for example a second credit note or a second
  invoice to the member.

  Now every retry path refuses a resolved operation, a queued retry is skipped
  rather than run, and nothing queues a new refund credit note or booking
  invoice beside the one the officer made. A refund credit note raised by hand
  counts for the amount it covered, so a later refund on the same payment still
  gets its own credit note for the rest. The one deliberate exception is a
  targeted force sync of a single booking's invoice, which still raises it and
  records in the audit log that it overrode the officer's mark. The repair tool
  and the booking page still show a resolved operation, as information only, so
  a wrong resolve can be caught. A resolved operation no longer holds up the
  Stripe refund-note link repair, and a newer failure is no longer hidden behind
  an older resolved one.

  Two things cannot be resolved: an operation while a retry of it is running or
  a new copy of it is queued (wait for it to finish), and an applied-credit
  allocation or deallocation,
  because a hand fix in Xero does not bring the club's own credit ledger back in
  line. Retry those instead.

  Two admin links also led nowhere and are fixed. The "Open the booking" link on
  the waitlist page and the booking link in a promo code's redemptions list both
  pointed at a page that does not exist; they now open the booking. Marking a
  booking paid, closing or reopening a money task, and correcting a booking's
  stored night prices now refresh that booking's page, and the two subscription
  payment actions refresh the member's admin page. Before, each asked to refresh
  a page address that matched nothing.
