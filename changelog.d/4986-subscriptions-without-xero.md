- **Subscriptions now say plainly when invoicing needs Xero, and no longer queue
  invoices that would go out late (#4986).** A club that does not use Xero used
  to see only a missing Xero account-mapping exception on the Subscriptions page,
  pointing at a screen it cannot open. With the Xero integration module off, the
  page now explains that subscription invoicing needs Xero, still previews what
  is owed, and points to **Mark as paid (manual)** for members listed for the
  season. **Confirm and queue annual batch** and
  **Retry** are disabled.

  With Xero off, no subscription or joining-fee invoice work is written at all.
  Previously it waited, unseen, and went out the day Xero was switched back on.
  Approving a membership application still succeeds, and warns that the new
  member was not invoiced. Charges queued before Xero was switched off are
  counted on the page, with what to check before switching it back on.
  The Modules guide now lists every feature that needs Xero and the manual
  alternative for each.

  Report downloads on the reports page and the Finance dashboard are now named
  after the club's short name instead of `tac-report`.
