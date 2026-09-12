- **Every night now records what a promotion took off it (#3276).** When a
  booking is made, repriced, or has a guest added or removed, the system stores
  beside each guest-night exactly how much the promo code reduced that night by
  — or, for a fixed-amount code, how much it took off that guest — using the
  pricing engine's own figures. The rows are checked against the promotion's
  recorded totals every time they are written, and a booking that cannot be
  reconciled is refused before anything is written rather than recorded wrongly.

  Nothing anyone is charged changes, and no screen changes yet: this is the
  second stage of making a night's money knowable, and the figures are recorded
  so that a later stage can read them instead of working them out again.
  Whether a booking's recorded build-up can be trusted is worked out from the
  rows themselves each time it is asked — a booking with no promotion had
  nothing taken off, one whose rows add up to its promotion's totals is known,
  and anything else is not known — so nothing is stored that could go stale.
  Account credit is not recorded here; it stays in the member's credit ledger.
