- **Old bookings' nightly prices can now be re-derived from the rate table,
  where the rate table agrees with what was sold (#3531, stage 2 of 3).**
  Bookings imported before per-night prices existed had each guest's total
  divided evenly across their nights — numbers that add up but were never
  what any single night sold for, so an edit that moves such a night goes to
  a person to price. A new operator-run script (dry run by default) prices
  each such booking's party as it was sold against the club's rate table and
  rewrites a guest's nights only when the result adds up to that guest's
  stored total to the cent, marking them `RATE_DERIVED`; every other guest is
  listed with the reason, never priced. No guest total, booking total or
  figure a member sees changes. It must be run after a deploy has fully cut
  over, never during one — the runbook in `docs/MAINTENANCE.md` says how.
