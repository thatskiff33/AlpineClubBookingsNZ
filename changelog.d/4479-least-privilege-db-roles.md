- **A club can now stop the booking system connecting to its database as the
  all-powerful administrator, so the system itself can no longer change the
  booking ledger or the audit log (#4453).** Until now every part of the
  system signed in to the database with the same superuser account, the one
  that can do anything. A fault, or a stolen copy of the system's password,
  could therefore change or delete any record, including the money ledger
  behind every booking and the audit trail of who did what.

  An operator can now split that one account into separate roles. A
  migration role owns the database structure and applies upgrades. The
  application role can add and read ledger lines and audit entries, but cannot
  change them by any route. A small audit-retention role, given only to the
  scheduled-jobs container, does the nightly clean-up of old audit entries and
  nothing else: it can clear an entry's IP address or browser details, but never
  write one. The administrator account is kept for people. A new command,
  `pnpm run db:provision-roles`, sets the roles up. It only shows what it would
  do unless it is run with `--apply`. It stops without changing anything if it
  would have to wait for a busy table, and it checks its own work and undoes
  everything if the result is wrong.

  One thing is deliberately unchanged: **deleting a booking still deletes that
  booking's ledger lines**, as it always has.

  Nothing about the roles changes until a club opts in. The new settings
  (`APP_DB_USER`, `MIGRATION_DB_USER`, their passwords and
  `AUDIT_RETENTION_DATABASE_URL`) are empty by default, and with them empty the
  system connects exactly as before. Switching over and back is an ordinary
  blue/green deploy, and the deploy refuses a half-finished switch.
  `DEPLOYMENT.md` ("Least-privilege database roles") and `docs/UPGRADING.md`
  give the steps.

  Every club gets three smaller changes:
  - The database now refuses any change to a booking's or a lodge's key, which
    a ledger line could be named by. Nothing in the system makes such a change,
    and the release deploys normally.
  - The nightly backup check, which restores each backup into a spare database,
    no longer needs an administrator account. It also now refuses a spare
    database that is really the live one under another name.
  - Once a club switches, restoring a backup over the live database from the
    Backups admin page is refused. An operator restores with the database tools
    instead.

  This replaces the July 2026 decision (#2240) to keep the single administrator
  account.
