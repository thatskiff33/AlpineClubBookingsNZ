- **Two one-off upgrade tools for clubs that ran version 0.9.0 or earlier are
  gone from this release (#5404).** `xero:audit-invoice-rounding` replayed the
  club's own booking data to flag invoices issued before the fix that might
  carry a one or two cent rounding drift, and
  `payments:backfill-cancel-flattened` tidied the stored status of payments
  that cancellations on those early versions had marked as failed. Neither
  changes how bookings, payments or invoices work today.

  Only a club that ran version 0.9.0 or earlier and never ran them would still
  want them. They remain available in the `v0.14.0` release tag, with their
  instructions in that tag's documentation, but they were not tested against
  any later database schema, so run them against a copy of your database.

  The upgrade guide now says how long a one-off upgrade tool stays: two minor
  releases, so a tool for the upgrade to 0.14.0 ships in every 0.14.x and
  0.15.x release and is gone from 0.16.0. Patch releases do not count, and a
  club that skips a release still finds the tool. It also says plainly that
  the deploy script checks that you are deploying a published release, not
  that it is the next one after yours.
