- **Old audit entries with no severity now age out instead of being kept
  forever by accident (#3524).** The nightly audit prune deletes an
  unclassified entry once its expiry date passes, unless it is critical. An
  entry whose severity was never set used to be kept indefinitely, because the
  database treats "is this not critical?" as unanswerable when the value is
  empty. It is now treated as not critical, as the project decided (#3524).

  The first nightly run after upgrading deletes, once, every such entry already
  past its expiry. They are not archived first, so the deletion is permanent.
  Before upgrading, count them on a restored copy of your database with the
  read-only query in `docs/AUDIT_RETENTION_ARCHIVE_RUNBOOK.md` ("Unclassified
  rows with no severity"). Entries recorded with no expiry date are not
  affected and are still kept.
