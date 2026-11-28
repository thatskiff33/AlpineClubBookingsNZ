- Older activity records that were kept for ever can now be given the
  seven-year expiry new records get, counted from the day each was recorded
  (owner decision, 20 Nov 2026, #5265). Nothing changes until the owner runs
  `pnpm run audit:expiry-backfill`: its census and dry run only read, and its
  apply asks for the total and for how many records the next nightly clean-up
  would then delete for good. The eight member-deletion, member-archive and
  family-suggestion record kinds held for a decision stay under Admin, which
  members cannot see, by the same decision. See
  [the audit retention runbook](../docs/AUDIT_RETENTION_ARCHIVE_RUNBOOK.md#older-entries-with-no-expiry-5265).
