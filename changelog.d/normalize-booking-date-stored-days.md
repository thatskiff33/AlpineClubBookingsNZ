### Fixed

- **The pricing engine now works from the day a stay is actually stored
  against, rather than shifting it into the server's time zone first.** For a
  club west of Greenwich that shift moved every night of every stay one day
  early, and because the whole per-night surface is built on the same helper it
  moved together: the season a night was priced in, the weekday a minimum-stay
  rule triggered on, and — the most serious of them — the night list a booking
  policy exception freezes for the officer, re-checks beds for, and then
  actually books. An officer could review, and the club could commit, a party
  arriving the night before the member had asked for. A club in New Zealand was
  never affected, because a zone ahead of Greenwich cannot move the stored day.
- A knock-on of the same shift: the first night of a season could fail to price
  at all, because the night and the season's start date ended up being read a
  different number of times and so landed on different days. A member quoting a
  stay that began on the day a season started was told no rate covered it.
- The suites that cover this now pin a club zone behind Greenwich instead of
  taking one from whatever machine they run on, so they can actually tell a
  correct answer from the old one; several fixtures that happened to cancel the
  old shift out have been written as plain calendar days.
