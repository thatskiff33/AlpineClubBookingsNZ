- **Signed money amounts are formatted by one shared helper (#3264).** The
  "+$25.00" / "-$120.00" style used for promo adjustments, booking-history
  deltas and finance report changes was written out seven times, and the
  copies had started to differ: three showed a zero adjustment as "-$0.00",
  and the promo-code box on the booking form dropped the thousands separator
  ("-$1234.56") and ignored the club's configured currency. All seven screens
  now share the club's standard money formatter, so a zero shows as "$0.00" and
  larger amounts read "-$1,234.56" everywhere.

  The same tidy-up reaches every amount on two screens, which is worth saying
  plainly: the member's booking review step and the admin booking page each
  carried their own copy of the plain money formatter as well, so their totals,
  per-guest prices, applied credit, remaining-to-pay and account-credit balance
  now read "$1,234.56" in the club's configured currency where they previously
  read "$1234.56" with a hard-coded dollar sign. The amounts themselves are
  unchanged. The finance-manager access check
  is likewise imported from its single defining module, and the finance
  dashboard's chart value types and badge tones are typed from the components
  that render them, so a new option cannot be added on one side and silently
  missed on the other.
