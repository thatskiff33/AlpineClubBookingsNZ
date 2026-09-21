- **The club's currency and its number and date format are now settings a Full
  Administrator can change, instead of values only somebody with access to the
  server could set (#3563).** They live at **Admin → Setup & Configuration →
  Club Currency & Locale**, and the operator guide is
  `docs/guides/club-format.md`.

  Nothing changes for an existing club on upgrade. On the first start after
  upgrading, the values the installation was already using are copied into the
  new setting, so a club running in New Zealand dollars stays in New Zealand
  dollars and nobody has to do anything. From then on the recorded setting is
  the only authority: **changing `CURRENCY` or `LOCALE` on the server will no
  longer do anything**, which is the whole point — one place answers the
  question, so nobody has to work out which of two is winning.

  **No screen looks any different yet, and that is deliberate.** This change
  records the club's choice; the pages that display money and dates are moved
  onto it in the changes that follow. The screen says so plainly rather than
  letting an operator save a new currency and wonder why nothing moved. No
  amount already recorded is rewritten or re-converted either — an amount of
  8450 cents is still 8450 cents, and this setting only ever decides how one is
  written.

  Changing either value needs an explicit confirmation and is written to the
  audit log with who did it and what it was before. Only a Full Administrator
  can see or change the page; an administrator holding every other permission
  at edit cannot. An invalid currency code or language tag is refused with a
  message saying what a valid one looks like.

- **Card payment code no longer guesses the currency (#3563).** The two places
  that create a card charge used to fall back to the server's currency setting
  when a caller did not say which currency to use. Every caller now states it,
  so the answer is visible where the charge is made rather than hidden in a
  default. No charge is taken in a different currency than before, and nothing
  about how any amount is calculated changed.
