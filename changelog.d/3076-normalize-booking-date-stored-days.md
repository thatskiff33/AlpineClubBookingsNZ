- **The pricing engine now works from the day a stay is actually stored
  against, rather than shifting it into the server's time zone first.** For a
  club west of Greenwich that shift moved every night of every stay one day
  early, and because the whole per-night surface is built on the same helper it
  moved together: the season a night was priced in, the weekday a minimum-stay
  rule triggered on, the date window that rule was in force for, and — the most
  serious of them — the night list a booking policy exception freezes for the
  officer, re-checks beds for, and then actually books. A club in New Zealand
  was never affected, because a zone ahead of Greenwich cannot move the stored
  day.

  **Half of the policy-exception problem is closed and half is not, so it is
  worth saying which.** When a member asks to change an existing booking, the
  officer, the bed re-check and the booking that is finally made now all name the
  nights the member asked for. When a member asks for a brand new booking and a
  guest is not given their own dates — which is what the form sends unless the
  member chooses separate date ranges per guest — that guest is still worked out
  from a shifted envelope, so a club west of Greenwich would still see them
  arriving the night before. The remaining half is a fix to a different helper
  and is tracked on #2870.

- **A stay crossing a season boundary could be charged the wrong amount, not
  only fail to price.** Where a club runs its seasons back to back — which is how
  a year is normally divided — the shift moved nights into the neighbouring
  season and the member was charged that season's rate. Measured for a club in
  Denver's time zone with a $65 winter and a $45 summer nightly rate: a
  29 September to 4 October stay came to $305 instead of $265, and 1 to
  4 October came to $175 instead of $135 — $40 over on each. Where a club leaves
  gaps between its seasons, the same shift instead pushed the first night of a
  season outside every season, and the member was told no rate covered their
  stay rather than being quoted a wrong one.

- **A night a member had already bought could lose its agreed price.** A booking
  being edited keeps the price of every night already paid for. That match was
  made by date, and the shift moved the two sides of it by different amounts, so
  the agreed prices landed on the wrong nights or were dropped. Measured in
  Denver's zone: two nights bought at $99.99 and $88.88 were re-quoted as
  $65.00 and $99.99 — one of them the current season rate for a night the member
  had already paid for.

- **A minimum-stay rule now starts and stops on the days it says it does.** The
  rule's own date window was compared against the shifted nights, so for a club
  west of Greenwich a window opening on the arrival day did not take effect, and
  one closing the day before arrival did.

- **The number of nights in a stay could itself change**, for a club whose time
  zone crosses Greenwich when its daylight saving changes — the Azores, for
  example. Measured there under the old behaviour: a four-night stay in late
  October counted three nights, a one-night stay on 25 October counted **none**
  and so was priced at nothing and claimed no beds, and a four-night stay in
  late March counted five. No club runs in such a zone today, but it means this
  correction can move a night count — and therefore an invoice total — and not
  only the day a night is named by.

- The pricing engine now also refuses a value that carries a time of day
  instead of quietly rounding it down to a date, so a future change that hands
  it a real timestamp fails loudly rather than moving somebody's stay by a day
  in silence.

- The suites that cover this now pin a club zone behind Greenwich instead of
  taking one from whatever machine they run on, so they can actually tell a
  correct answer from the old one; several fixtures that happened to cancel the
  old shift out have been written as plain calendar days.
