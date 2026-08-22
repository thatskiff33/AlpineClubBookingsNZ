- **Dates and times are now worked out in one place, and a whole family of
  daylight-saving mistakes is fixed with them (#2990).** Nothing looks different
  for a New Zealand club — the dates and times on every screen are unchanged, and
  that was checked day by day across three years rather than assumed.

  What changed underneath is that the platform now treats three things as
  genuinely different: a **calendar date** like a lodge night or a birthday, which
  is simply a day and belongs to no time zone; a **moment**, like when a payment
  settled; and a **club-local time**, like an overnight job at 8am club time.
  Confusing those three is the single most repeated source of "why does this say
  yesterday?" in this product's history.

  The fix that matters for any club outside New Zealand: asking for "the start of
  a day" used to give the **wrong day entirely** in eleven time zones — Havana,
  Santiago, São Paulo and eight others — because in those places the clocks jump
  forward at midnight and that midnight simply never happens. In one more, Amman,
  the start of a day quietly lost its own first hour. Both are fixed, and the
  behaviour was checked against every one of the 418 time zones the platform
  knows, on every clock-change day from 2015 to 2036.

  One result of that survey is worth recording: **midday never goes missing in any
  time zone a club runs in today**, which is why lodge stays run midday to midday
  rather than midnight to midnight, and why that choice is safe for a club in any
  country. It is not a law of nature — a country moving across the date line
  skips a whole day, midday included, as Samoa did on 30 December 2011 — and the
  platform now handles that case rather than assuming it cannot happen.
