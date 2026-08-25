# File-size allowances for CT-4 group F4a (#2870)

One entry. The sweep's other twenty-odd files all got SHORTER — deleting a local
`Intl.DateTimeFormat` and its explanation costs more lines than the kernel call
that replaces it — and five already-merged allowances in this epic had their
`lines:` refreshed downwards for exactly that reason. This is the one file where
the note left behind is longer than the code it replaces.

file: src/lib/finance-dashboard-page.ts
lines: 1710
reason: three lines on a 1,707-line file, and all three are the note. The five
  lines of local `Intl.DateTimeFormat` are gone — the day-and-month export label
  is now the kernel's `dayMonth` shape — but that formatter was still pinned to
  `APP_TIME_ZONE` over a `yyyy-MM-dd` metric key, so every occupancy and
  forward-demand trend point named the previous day for any club behind Greenwich.
  A reader who finds only the swap learns nothing about which of this module's
  dates are calendar days and which are moments, and this file renders both three
  lines apart. Splitting a 1,710-line page-model builder is a separate job with
  its own review, and it would not shrink this hunk.
