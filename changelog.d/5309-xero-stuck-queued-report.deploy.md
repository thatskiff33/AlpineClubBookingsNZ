## Who

owner

## What to do

Once, after the deploy, run `pnpm run xero:stuck-queued-report` against
production. It only reads. If it lists rows, review them, then run it again with
`--release`. `docs/MAINTENANCE.md`, "Release Xero outbox rows stuck without a
queued request (#5228)", explains each row.

## How to check it worked

Another read-only run lists no rows.
