- **Bookings, the waitlist, Xero and the nightly jobs now always place a date
  in the season the club's financial year-end gives it (#5259).** The server
  used to fall back to a March year-end whenever it worked out a season before
  it had read the club's setting, for example just after a restart. For a club
  whose year ends in June, a stay on 15 June 2026 could then be priced and
  checked against the 2026 season instead of 2025, the season it is in. Every
  booking, quote, waitlist offer, Xero reconcile and nightly job now reads the
  club's year-end first and uses it, so the answer no longer depends on what
  the server happened to have loaded. The age-up job also dates the start of
  the season from that same setting.

  For a club whose year ends in December, the "membership subscription not
  paid" refusal now names a one-year season as "2026" rather than
  "2026/2027", matching the season names elsewhere.

  Clubs whose year ends in March, which is every club running today, see no
  change.
