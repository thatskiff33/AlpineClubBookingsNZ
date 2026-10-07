- **A database upgrade that cannot get a lock now stops the deploy cleanly
  instead of freezing the site (#3377).** When a release changes the shape of a
  table, it needs exclusive use of that table for a moment. If something else is
  still using it — a long report, a session somebody left open — the change has
  to wait, and while it waits everything else that wants to read that table
  queues up behind it. Bookings, members and payments are exactly the tables
  involved.

  Until now that wait had no limit, so the only thing that ended it was somebody
  noticing. The deploy notes have been promising a time limit for months; there
  wasn't one. There is now: five seconds, measured rather than guessed. A change
  that cannot get its lock in that time stops, having altered nothing, and the
  deploy halts with the previous release still serving members normally.

  Nothing is left half-finished when this happens, and the upgrade runbook now
  walks an operator through it: find out what was holding the table, clear the
  stopped change, and run the deploy again in a quieter moment. Repeated
  timeouts are deliberately not retried away — they mean something is holding
  onto a busy table during an upgrade, which is worth knowing about.

  Operators who need a different limit can set `MIGRATION_LOCK_TIMEOUT_MS`; the
  deploy refuses a value that would switch the protection off or set it so high
  it could never help in time.
