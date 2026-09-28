- **A Xero operation marked "resolved in Xero" is now treated as done, and
  nothing re-runs it (#3635).** On the Xero operations panel an officer can
  mark a failed operation resolved once they have fixed it by hand in Xero.
  Until now most of the system ignored that mark. The repair tool could still
  retry the operation automatically, a retry queued earlier still ran, and a
  stale browser tab could still send one. Any of those could apply the same
  fix twice in Xero, for example a second credit note. Now every retry path
  refuses a resolved operation. The Retry and Requeue actions answer that it is
  already resolved, a queued retry is skipped rather than run, and the repair
  tool neither retries it nor raises a new document beside the one the officer
  made. A resolved operation also stops holding up the Stripe refund-note link
  repair. A newer failure on the same document is no longer hidden behind an
  older resolved one.

  Two admin links also led nowhere and are fixed. The "Open the booking" link
  on the waitlist page and the booking link in a promo code's redemptions list
  both pointed at a page that does not exist. They now open the booking. Three
  admin actions (marking a booking paid, and closing or reopening a money task)
  now refresh that booking page, as they were meant to.
