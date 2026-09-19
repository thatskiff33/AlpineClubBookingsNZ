- **Stored booking totals now say whether their recorded parts reconcile
  (#3278).** Officers see a clear Money review mark on affected bookings, and
  finance reports and exports carry the same complete reasons instead of
  silently presenting a mismatched total as trusted.

  The mark is for officers only: members see their amounts exactly as they did
  before, with nothing added to them and nothing added to their data export.

  This check is read-only. It never guesses unknown historical prices, changes
  a member's amount, moves money, or alters Xero invoice lines.
