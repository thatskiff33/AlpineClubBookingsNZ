# File-size allowances for CT-4 group F4a (#2870)

One entry. The sweep's other twenty-odd files all got SHORTER — deleting a local
`Intl.DateTimeFormat` and its explanation costs more lines than the kernel call
that replaces it — and five already-merged allowances in this epic had their
`lines:` refreshed downwards for exactly that reason. This is the one file where
the note left behind is longer than the code it replaces.

file: src/lib/finance-dashboard-page.ts
lines: 1756
reason: three lines on a 1,707-line file, and all three are the note. The five
  lines of local `Intl.DateTimeFormat` are gone — the day-and-month export label
  is now the kernel's `dayMonth` shape — but that formatter was still pinned to
  `APP_TIME_ZONE` over a `yyyy-MM-dd` metric key, so every occupancy and
  forward-demand trend point named the previous day for any club behind Greenwich.
  A reader who finds only the swap learns nothing about which of this module's
  dates are calendar days and which are moments, and this file renders both three
  lines apart. Splitting a 1,710-line page-model builder is a separate job with
  its own review, and it would not shrink this hunk.
  #3123 adds forty-six, and they make this file the finance dashboard's single
  zone boundary rather than one more reader among several. `formatDateTime`
  was still `formatNZDateTime`: the sync-health "last synced" stamp is a real
  INSTANT and was named in the container's zone, so a club west of Greenwich
  could be told its figures were synced on the wrong day. It becomes a
  function of the bound club time, with the docblock distinguishing it from
  the calendar-key formatter three functions below — the two-kinds-in-one-file
  shape this entry's original reason is about. Twenty-two of the lines are the
  block comment on the one `await clubTime()` this page now makes: it also
  supplies `today` to `finance-dashboard-ranges.ts`, which sits on the BROWSER
  graph and may read no zone at all, and it records that the `server-only`
  reader was verified against `cli-server-only-reach-census.test.ts` rather
  than assumed. The rest threads the binding through four builders. Splitting
  this 1,756-line page model is #2957, which is open, and it is still a
  separate job with its own review.
