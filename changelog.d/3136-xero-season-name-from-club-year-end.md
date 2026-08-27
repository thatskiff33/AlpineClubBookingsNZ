- **Membership invoices and credit notes now name the season the same way the
  rest of the system does, and correctly for a club whose financial year does
  not end in March (#3116).** The season on a Xero invoice line used to be
  written as two calendar years — `2026/2027` — no matter how the club's
  financial year was set up. For a club whose year ends in December that was
  simply wrong: its season starts in January and finishes in the same calendar
  year, so the line said `2026/2027` about a season that sits entirely inside
  2026, contradicting the season shown beside it.

  Four places were affected: the membership subscription invoice line, the line
  rebuilt for older charges created before the system stored line text, the
  membership cancellation credit note, and the season shown on the admin Xero
  activity panel. All four now take the season name from the club's configured
  financial year-end, which is the same source every other screen in the system
  already used.

  **What an administrator will notice.** On a club with a March financial year —
  which is every club running today — new invoice and credit-note lines read
  `2026 - 2027` where they previously read `2026/2027`. It is the same season,
  spelled the way the member portal, the admin screens and the season picker
  have always spelled it. Invoices already in Xero are not touched and no amount
  changes anywhere.

  One thing to be aware of on the day of the update: a subscription billing
  preview left open on screen from before the update will not confirm, because
  the invoice wording it was showing is no longer the wording that would be
  sent. The screen says "Billing configuration changed after preview. Review the
  refreshed preview before confirming." Refreshing the preview is all that is
  needed, and nothing is charged in the meantime.

  A club whose financial year ends in a month other than March gets the correct
  single-year or two-year season name from now on, on invoices as well as on
  screen.
