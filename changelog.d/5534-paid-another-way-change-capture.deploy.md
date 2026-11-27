## Who

operator

## What to do

After cutover, once all old workers have stopped, run `pnpm run xero:booking-repair --dry-run`. While both colours ran, an old worker may have cancelled a Xero receipt queued by the new "Paid another way" close of a late booking-change payment. The dry run lists each one as `KEPT_LATE_CAPTURE_NOT_RECORDED_IN_XERO`. Review those bookings with the treasurer, checking that no one entered the receipt by hand. For each missing receipt, run `pnpm run xero:booking-repair --booking <bookingId> --apply --apply-action '<exact-action-key>'` with the key from the dry run.

## How to check it worked

Repeat the dry run for the affected bookings. The missing receipt should no longer be listed; check that the receipt and its bank refund note reach Xero once each.
