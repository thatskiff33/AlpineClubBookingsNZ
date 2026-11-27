- **A read-only audit now counts the bookings the old mid-stay edit pricing may
  have got wrong.** Before v0.14.0, editing a booking after its stay had started
  could bill a guest again for nights after their stay ended (#2743), or credit
  nights back at the rates and membership standing of the day rather than the
  rate the member paid (#2744). Those bookings were left as they were, and nobody had counted them.
  `pnpm run bookings:audit-mid-stay-edits` lists each such edit made before this
  install took the fixes, with the amount at stake and whether the history shows
  it for certain or a person needs to check; `--summary` prints the counts
  alone. It changes nothing. Whether to credit or refund anyone is decided on
  [#5242](https://github.com/thatskiff33/AlpineClubBookingsNZ/issues/5242);
  `docs/MAINTENANCE.md` has the runbook.
