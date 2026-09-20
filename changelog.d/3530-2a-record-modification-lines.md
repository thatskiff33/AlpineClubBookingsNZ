- **A booking change now records exactly what its price difference is made
  of, and the booking's history says so (#3530, stage 1 of 3).** Until now an
  edit that changed the price left one number behind — "+$80.00" — and anyone
  asking why had to work it out again from the booking. Each money-moving edit
  now stores the lines behind that number: which guests, at which rate, for
  which nights, and any change to a promotion, each with its own amount and all
  adding up to the difference. The admin booking page's history and the edit's
  audit entry list them in dollars, for example
  "1 x Non-member Adult added - 1 night - 14 Aug 2026 - 15 Aug 2026 (+$80.00)".

  Nothing sent to Xero changes in this release; the next stage puts the same
  lines on the supplementary invoice and credit note. An edit whose money is
  held for a person to price, or whose stored night prices are not exact
  enough to itemise, records no lines and reads exactly as before.
