- **The club's currency and its number and date format are now settings a Full
  Administrator can change, instead of values only somebody with access to the
  server could set (#3563).** They live at **Admin → Setup & Configuration →
  Club Currency & Locale**, and the operator guide is
  `docs/guides/club-format.md`.

  Nothing changes for an existing club on upgrade. On the first start after
  upgrading, the values the installation was already using are copied into the
  new setting, so a club running in New Zealand dollars stays in New Zealand
  dollars and nobody has to do anything. From then on the recorded setting is
  the authority for the setting: changing `CURRENCY` or `LOCALE` on the server
  no longer changes what the page shows. **Keep those server settings in
  place, and keep them matching this page.** Every **amount** the site writes
  is still worked out from them, and removing them would leave the site
  writing New Zealand dollars while the page shows your club's real choice.

  **This entry is the setting; #3564's entry below is the screens.** On its
  own this change only records the club's choice — which is why it is worth
  reading #3564's entry in this release before you decide what to expect,
  because that is where the screens are moved onto it and where the ones that
  have not moved are named. No amount already recorded is rewritten or
  re-converted by either — an amount of 8450 cents is still 8450 cents, and
  this setting only ever decides how one is written.

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
