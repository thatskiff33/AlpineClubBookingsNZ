## Who

owner

## What to do

Once this release alone serves, run `pnpm run audit:expiry-backfill` (it only
reads) and read the counts by kind, then `-- --dry-run`, which prints the exact
apply command. Run that command, `--apply --actor <your member id>
--confirm-total <n> [--allow-delete <n>]`, with `DATABASE_URL` naming the
operator connection. Entries already past seven years are deleted for good at
the next nightly clean-up, so read the counts first. The steps are in
`docs/AUDIT_RETENTION_ARCHIVE_RUNBOOK.md`, "Older entries with no expiry (#5265)".

## How to check it worked

Running the census again reports 0 older entries with no retention class and no
expiry, and the activity log has one "AUDIT_EXPIRY_BACKFILLED" entry, filed under
Admin, for each batch the apply reported.
