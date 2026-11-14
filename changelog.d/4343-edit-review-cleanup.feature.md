- **Old edit reviews can no longer be put back on the finance queue, and a one-off clean-up settles any that are still open (#4343).**
  Reopening a dismissed edit review used to put it back on the queue, which blocked later changes to that booking and brought back the old settle screens. That button is gone for an edit review. Every other money task can still be put back.

  After this is the only version serving, run `pnpm run bookings:edit-review-cleanup` against a copy of the database, read the dry-run, then apply it with `--actor`. It prices any review still open through the normal refund, credit or charge. It also re-sets a booking total that an old review froze to the sum of its guests, and that re-set moves no money. Run it again only to confirm it has nothing left to do.
