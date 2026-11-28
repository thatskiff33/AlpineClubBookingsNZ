## Who

owner

## What to do

Before or during the deploy, run the read-only census
`pnpm run bookings:edit-review-cleanup` against the live database and read its
open edit review count. An install upgrading from v0.13.2 has none. If it
reports any, settle them with the clean-up in `docs/MAINTENANCE.md` as the first
thing once the new release alone serves, before anyone edits those bookings:
this release no longer stops a booking with an open review being edited, and an
edit that lands first changes the prices the clean-up settles from.

## How to check it worked

The census reports 0 open edit reviews.
