- **Internet Banking messages now show amounts in the club's configured
  currency (#3325).** Four messages had `NZ$` written directly into their
  text rather than using the club's configured currency like every other
  amount in the product: the line added to a booking's cancellation story
  when applied account credit is returned, the matching line when an
  Internet Banking payment hold expires, the audit-log detail written when
  the orphaned-credit repair restores credit, and every amount in the
  Internet Banking hold-clearing audit report.

  All four now render through the shared money formatter. For a club
  configured for New Zealand dollars (the default) the text changes from
  `NZ$20.00` to `$20.00`, matching the rest of the product's screens and
  emails; a club configured for another currency reads its own. The
  hold-clearing report's amounts also gain thousands grouping (`$1,234.56`)
  and a negative amount's sign sits before the symbol (`-$5.00`), as they do
  everywhere else. No amount changes — only how it is written.
