- **Two August data backfills now have safety ledger entries, and one of them
  needs a maintenance window (#3933).** The deploy safety ledger had no entry
  for `20260810010000_backfill_booking_request_guest_nights` (#2739) or
  `20260810020000_backfill_bed_allocation_audit_category` (#2751), so an
  operator looking them up before a deploy found no answer.

  If your deployment has **not yet applied** `20260810010000`, the next upgrade
  must now use the windowed deploy sequence: remove traffic, stop the old app
  and every old worker, then migrate with the windowed acknowledgements set. The
  deploy gate now asks for them. The reason: while the old version keeps
  running, approving a booking request at a different quote option leaves the
  new per-night rows describing the old dates and total, and invoices are built
  from those rows. The migration ships a `rollback.sql` that changes nothing on
  purpose. On the way back the rows are kept, and booking-request approvals and
  quoting stay paused.

  `20260810020000` needs no window, and the post-cutover re-run in the upgrade
  runbook still applies. A deployment that applied both migrations long ago has
  nothing to do.
