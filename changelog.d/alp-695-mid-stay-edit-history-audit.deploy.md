## Who

owner

## What to do

Run the mid-stay edit audit against production with
`pnpm run --silent bookings:audit-mid-stay-edits --summary` and post its output
on https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/5242.

The summary holds counts and money only. The full list (without `--summary`)
carries booking and member ids, so keep it off the public issue. If this install
began running the #2743 and #2744 fixes at a different time from the cut-off the
header prints, re-run with `--before` set to that moment. All zeros closes
#5242; otherwise a follow-up decision issue is filed with the counts and money,
and nothing is adjusted without that decision. The runbook is the "Audit
mid-stay edits made before the #2743 and #2744 fixes" section of
`docs/MAINTENANCE.md`.

## How to check it worked

The audit's summary is posted as a comment on #5242.
