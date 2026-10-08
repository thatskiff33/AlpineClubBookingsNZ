- **Two August data backfills now have safety ledger entries, and one of them
  needs a maintenance window (#3933).** The deploy safety ledger had no entry
  for `20260810010000_backfill_booking_request_guest_nights` (#2739) or
  `20260810020000_backfill_bed_allocation_audit_category` (#2751), so an
  operator looking them up before a deploy found no answer.

  If your deployment has **not yet applied** `20260810010000`, the next upgrade
  must now use the windowed deploy sequence: build and validate the new images,
  remove traffic, stop the old app and every old worker, take a fresh verified
  backup, then migrate with the windowed acknowledgements set. The deploy gate
  now asks for them. The reason: while the old version keeps running, a
  requester accepting a booking-request quote leaves the new per-night rows
  carrying the hold's prices instead of the accepted ones, and invoices are
  built from those rows. Requester acceptance cannot be paused in the app, so
  the window is the way to avoid it. The migration ships a `rollback.sql` that
  changes no data on purpose; it holds a read-only query that finds any guest
  whose night prices no longer add up.

  `20260810020000` needs no window, and the post-cutover re-run in the upgrade
  runbook still applies. A deployment that applied both migrations long ago has
  nothing to do, **unless** booking requests were approved between migrate and
  cutover on that deploy. If so, run the query in that `rollback.sql`, and for
  each guest it lists first record the nights' prices with **Record what these
  nights sold for** on the booking's Admin tools card, then refresh the
  booking's invoice.
