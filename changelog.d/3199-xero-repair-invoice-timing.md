- **The one-click Xero repair no longer offers to raise a supplementary invoice
  that would bill the same money twice (#3199).** When a booking edit adds
  money, the club normally raises a small extra Xero invoice for the difference.
  Whether that is right depends on a question the repair tool could not
  previously ask: had the booking's main invoice already gone out when the edit
  happened?

  If it had, the extra invoice is correct — the main invoice bills the old
  total, and the difference is genuinely unbilled. That is the ordinary case,
  because the main invoice is raised as soon as a booking is confirmed, and
  nothing about it changes.

  If it had **not** — a Xero outage, or simply the short window between the card
  clearing and the queue running — the main invoice is raised later and bills
  the booking as it then stands, so it already includes the edit. Adding an
  extra invoice on top billed the club's books for money nobody owed: on a $550
  booking made of a $500 payment and a $50 guest added, $600 of income and a $50
  phantom receivable. The repair tool could not tell the two apart, so it
  offered the same confident one-click fix for both.

  It now works the answer out from the club's own Xero operation history, and
  offers the click only where that history says plainly that the main invoice
  came first. Where it says the main invoice came second, or where it cannot
  answer at all — an invoice raised before this system kept that history, or
  entered into Xero by hand — the booking is **reported for an officer to check
  by hand** instead. It is listed in the report as needing manual review, it
  carries the reason and the date the main invoice was raised, and `--apply`
  will not touch it. Nothing is skipped silently.

  Two things for an operator to know. Findings of this kind will appear in
  reports that previously showed a one-click fix, and that is the change working
  — check the invoice in Xero and bill only what is genuinely still owed. And the
  question is asked about any edit that **added a guest**, even one whose amount
  was parked for a financial review and whose own recorded difference is
  therefore zero: a main invoice bills the booking's guests, so an added guest is
  on it if it went out after the edit. The rest of what a financial review prices
  is unaffected — that money is never a line on a main invoice — and those
  findings keep their one-click repair.
