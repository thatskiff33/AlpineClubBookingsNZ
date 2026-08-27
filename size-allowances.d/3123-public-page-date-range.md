# File-size allowances for #3123 (public page-content date ranges)

file: src/lib/public-page-content-tokens.ts
lines: 760
reason: fourteen lines, twelve of them one docblock, on a 746-line module that
  was already over budget and is not restructured here. `dateRange` — the
  season, booking-period and cancellation-period edges printed on the PUBLIC fee
  and policy pages — kept its own `Intl.DateTimeFormat` with `timeZone:
  "Pacific/Auckland"` written into it. Not `APP_TIME_ZONE`: one club's zone,
  hard-coded into every adopter's public page (`INV-CONFIG-001`), projecting
  values that are `@db.Date` stored calendar days and take no zone at all
  (`INV-DATE-026`). It reads as harmless because Auckland is ahead of Greenwich,
  where projecting a UTC-midnight encoding is the identity; make that literal
  configurable, or read it as a club behind Greenwich would, and every published
  season edge prints a day early. It moves onto the kernel's declared
  `HOUSE_SHAPES.date` through `formatClubDate`, whose output is byte-identical
  for `en-NZ` — measured across all 1,461 days of 2024-2027, and no test pinned
  the string, so the docblock is where that measurement lives. **Why splitting is
  worse here.** The seam is not missing so much as wrong for this: the four other
  `dateRange` callers in this file are token builders that each assemble one
  public view model, and the reason this formatter must not take a zone is a
  statement about the COLUMNS they read. Lifting five lines into a
  `public-date-range.ts` would put that reason in a module nobody reading a fee
  table would open, which is precisely how the hard-coded literal survived four
  club-time sweeps sitting three lines above the reads that #3123 migrated.
