- **Integer-cent money has one formatter (#3302).** `formatCents` (an integer
  cent amount to a dollar string) had been copied at many call sites — the
  admin payments and refund-requests pages, the member account-credit
  section and its equivalent admin screen, the audit log description
  builder, the booking-cancellation dialog, several booking-cancellation and
  refund-appeal messages, and others a follow-up review found — all quietly
  repeating the pre-#3264 bug pattern: a hard-coded `$`, no thousands
  grouping, the club's configured currency ignored. Every one of those now
  reads the shared helper. Larger amounts (over $999) gain grouping, and a
  **negative amount's sign now sits before the `$`** (`-$25.00`, not the old
  `$-25.00`) — matching `formatSignedCents` (#3264) and the locale
  convention. That sign change reaches a few places a member or admin can
  see it directly: an audit log's price-difference line, the account-credit
  history on both the member's and the admin's screen, and an admin refund
  email whose remaining-balance line can be negative. See the pull request
  description for the exact list and reasoning.

  Two genuinely different renderings stay distinct rather than becoming more
  copies, both now a separate named function, `formatCentsPlain`, rather
  than an option on `formatCents` (so calling the wrong one is a different
  import, not a different argument): the AI assistant and AI Diagnostics
  monthly spend-cap editors, which show a bare two-decimal number for an
  editable input, and the Xero refund-note repair report, which renders a
  bare decimal delta (and "unknown" for an amount not yet known) rather than
  a currency string. Both are pinned by existing test fixtures and are
  byte-identical to before.

  One report-only formatter composes from the shared helper for its dollar
  arithmetic but keeps its own local decoration, because it is a genuine
  rendering difference no fixture pinned away: the Xero invoice rounding
  audit's compound `"$1.50 (+150c)"` line (the dollar half now groups
  thousands like every other screen; only the parenthesised raw-cents
  suffix is local). A club's configured currency now formats consistently
  everywhere this issue reached.

  **The instrument the issue asked for:** a new lint rule bans hand-rolling
  `(cents / 100).toFixed(n)` anywhere in `src/`, so a future twelfth copy of
  this formatter fails the build instead of quietly regrowing — the pattern
  three separate merges in this same epic have already shown regrows without
  one. A short, reasoned exemption list covers the genuinely different cases
  (an editable input's plain value and a raw numeric export cell).
