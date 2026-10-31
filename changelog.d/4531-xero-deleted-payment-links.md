- **A payment deleted in Xero no longer stays as a live payment in the app
  (#4531).** When the treasurer deleted a payment in Xero, often to re-enter it
  by hand during bank reconciliation, the app kept its own record of that
  payment active for good, so the booking looked paid twice and the "recorded
  in Xero" totals were overstated.

  Now, when the app next reads the invoice or credit note, it asks Xero about
  any payment that has disappeared from it. Only a payment Xero confirms as
  deleted is retired; the hand-entered replacement stays as it is. If Xero
  cannot be asked (for example, the day's Xero allowance is nearly used up),
  nothing changes and it tries again on a later read.

  Payments deleted before this release are not retired by themselves. Run
  `pnpm run xero:deleted-payment-link-backfill` to see them (it changes
  nothing), then run it again with `--apply` to retire the ones Xero confirms
  deleted. `docs/MAINTENANCE.md` has the steps.
