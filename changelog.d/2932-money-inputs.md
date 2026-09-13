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
- **The refund review screen no longer offers a refund it cannot pay.** The
  "Max refundable" figure was worked out on the screen instead of by the rule
  the approve step actually applies, so a booking whose payment never went
  through still showed an amount, and opening a review for a booking with no
  payment left the previous member's amount sitting in the box. Both now come
  from the one rule, and the box is empty when there is nothing to refund.
- **Four more dollar boxes now say so the same way as the rest** — the AI
  assistant's monthly cap and all three gross-amount filters on the payments
  screen. They already behaved correctly; they spelled it by hand, which is how
  the other seven were missed. Nothing about them changes on screen.
- **A new test stops this returning.** It reads every numeric box in the admin
  tree, works out from the field itself whether it holds money, and fails the
  build if a money one is a browser number input — while deliberately leaving
  the 73 legitimate count, percentage and duration boxes alone. It is checked
  against the tree as it was BEFORE this change too, so it is proved to catch
  all seven of the boxes fixed here rather than only to be quiet today.
