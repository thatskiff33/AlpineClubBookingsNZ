- **The date and time helpers this product had been writing out by hand now
  exist once, and screens that had kept their own copy use the shared one
  (#2870).** Nothing an administrator or a member sees changes: every label,
  filter and stored date is byte-for-byte what it was. What changes is how many
  places could go wrong the next time somebody edits one.

  Six things had been quietly duplicated. Reading a stay date back out of the
  data a page is sent was spelled two different ways in fifteen files. Working
  out "the last moment of today" had been typed out separately in four places,
  each doing its own arithmetic. Turning "today at the club" into the form a
  date column stores cost every one of fifteen server routes two lines instead
  of one. And three screens — the booking calendar, the booking editor and the
  per-guest night grid — each kept a private date formatter with a comment
  saying the shared set was missing the shape it needed. Four shapes were
  missing; all four now exist, so those three screens use the shared one.

  Two of the duplicates mattered more than tidiness. The screen-reader label on
  every day of the booking calendar and the two headline dates a member checks
  before agreeing to a booking change were both produced by a formatter that
  only that one file knew about, so a correction made anywhere else would not
  have reached them.

- **A guard that had been unable to see thirty-two date reads can now see
  them.** The check that stops a real timestamp being mistaken for a calendar
  day works by recognising the helpers that do the converting. A wrapper six
  files had each written privately was not on its list, so every date read
  through it was invisible to the check — not wrong today, but unprotected. The
  wrapper is now shared and listed, along with the pricing engine's stricter
  version of it, so a future edit that pointed either at a real timestamp would
  be caught rather than shipped.

- **The rule for which of two time-zone readers a shared module should use is
  now written down in one place**, with how to check rather than guess. One
  service had been paying an extra database read per request for a hazard it
  does not actually have, and the answer had been a per-file judgement call.

- One long-standing comment in the time-zone code explained a rule as the exact
  opposite of what the rule says. It had already been copied into four other
  files. The original is corrected, with a note saying not to cite that rule for
  that purpose, which is what stops it coming back.
