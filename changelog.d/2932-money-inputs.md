- **Every admin box you type a dollar amount into now keeps what you typed.**
  Seven money fields were still browser number inputs — the member credit
  adjustment, the refund-request approval amount, both joining-fee invoice
  overrides, the whole-lodge total price override, and the school booking
  request's quote total and per-guest-night rate. A browser number input throws
  away anything that is not a plain number before the page ever sees it, so
  `$45.00`, `1,000.00` or a slipped keystroke like `50abc` arrived as an empty
  box — indistinguishable from having cleared it deliberately, which is how a
  mistyped nightly rate could be saved as nothing at all. All seven are now
  ordinary text boxes with a decimal keypad on a phone, so a malformed amount is
  refused with a message instead of vanishing. Counts, percentages and durations
  are unchanged and still numeric. The refund approval screen's prefilled amount
  is also now worked out in whole cents rather than in dollars-and-fractions.
- **A new test stops this returning.** It reads every numeric box in the admin
  tree, works out from the field itself whether it holds money, and fails the
  build if a money one is a browser number input — while deliberately leaving
  the eighty-odd legitimate count, percentage and duration boxes alone.
