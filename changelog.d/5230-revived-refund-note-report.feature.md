- **A read-only report finds refund credit notes Xero voided that the app still
  counts (#4336).** Before #4341, an older reading from Xero could undo the
  app's record that a refund note had been voided, so the app could count a
  refund as documented while Xero credits nothing. Nothing local can find these.

  Run `pnpm run xero:revived-refund-note-report --list` once after upgrading
  from v0.13.2 or earlier. It asks Xero about every refund note the app has an
  active link to and lists each one Xero reports voided or deleted, with its
  payment, booking and the amount the app counts, and totals per payment
  source. It changes no record, and its output names members' payments, so
  keep it private. For each line, use **Sync from Xero now** on the booking.
  The steps are in `docs/MAINTENANCE.md`.
