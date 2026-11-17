- **A read-only report finds refund credit notes Xero voided that the app still
  counts (#4336).** Before #4341, an older reading from Xero could undo the
  app's record that a refund note had been voided, so the app could count a
  refund as documented while Xero credits nothing. Nothing local can find these.

  Run `pnpm run xero:revived-refund-note-report --list` once after upgrading
  from v0.13.2 or earlier. It asks Xero about every refund note the app has an
  active link to and lists each one Xero reports voided or deleted, with its
  payment, booking and the amount the app counts, then totals per payment
  source. A club with more refund notes than one day's share of Xero calls
  carries on the next day with the `--resume-from` id the run prints.

  It changes no booking, payment, credit, link or Xero record. It can write
  API-usage rows and, if the Xero token needs refreshing, the new token, its
  refresh lease and a credential audit row; a failed refresh alerts the admins,
  as it would for the app. Its output names members' payments, so keep it
  private. For each line, use **Sync from Xero now** on the booking. The steps
  are in `docs/MAINTENANCE.md`.
