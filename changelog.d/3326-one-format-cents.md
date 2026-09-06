- **Integer-cent money has one formatter (#3302).** `formatCents` (an integer
  cent amount to a dollar string) was defined eight times beneath the shared
  `formatSignedCents` (#3264): the admin payments and refund-requests pages,
  the member account-credit section, and the audit log description builder had
  all quietly copied the pre-#3264 bug pattern — a hard-coded `$`, no
  thousands grouping, the club's configured currency ignored. Those four
  screens, plus the booking-cancellation dialog's own copy of the same
  pattern, now read the shared helper and format larger amounts with the
  club's configured currency and grouping, exactly as #3264 already did for
  the signed-delta screens. The amounts themselves are unchanged.

  Two genuinely different renderings stay distinct callers rather than
  becoming a ninth copy, both now expressed as one option
  (`formatCents(cents, { style: "plain" })`) instead of their own
  `(cents / 100).toFixed(2)`: the AI assistant and AI Diagnostics monthly
  spend-cap editors, which show a bare two-decimal number for an editable
  input, and the Xero refund-note repair report, which renders a bare decimal
  delta (and "unknown" for an amount not yet known) rather than a currency
  string. Both are pinned by existing test fixtures and are byte-identical to
  before.

  Two report-only formatters were left as they were, deliberately, because
  changing them is a rendering *decision* rather than a mechanical fold and
  neither is pinned by a fixture: the Xero invoice rounding audit's compound
  "$1.50 (+150c)" line (now composed from the shared formatter plus its own
  raw-cents suffix, so the dollar part can never drift from every other
  screen) and the Internet Banking hold-clearing audit's hard-coded "NZ$"
  prefix, which matches this codebase's existing tested convention for
  IB-specific messages elsewhere and is left unchanged pending confirmation
  it should join the club-configured-currency formatter rather than stay
  NZ-specific. See the pull request description for the full comparison.
