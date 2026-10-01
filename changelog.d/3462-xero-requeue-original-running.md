- **A failed Xero retry no longer leaves the original operation stuck
  "running" with no button that works (#3462).** Requeueing a failed booking
  invoice first marks the original operation as running. If the retry then
  failed early, for example because the booking's contact matched another
  member's Xero contact, the original stayed "running" for ever. The retry row
  said "not marked replayable" and nothing on the screen could clear it.

  The original now goes back to **Failed** with the new error, so once you
  have fixed the cause you can requeue it again. The retry row's error now
  names the original operation and tells you this.

  An operation that has been running for more than 15 minutes now has a
  **Mark failed** button on its own row in **Xero → Operations**, so you can
  clear one stuck operation without resetting all of them. It asks for a
  reason and is recorded in the audit log, and it keeps any earlier error on
  the operation so you can see what to fix. Admins whose finance access is
  view-only see the button greyed out.
