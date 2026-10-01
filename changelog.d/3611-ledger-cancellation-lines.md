- **The booking ledger now records cancellations (#3611).** When a booking is
  cancelled — by the member, by an officer, when an internet banking hold
  expires unpaid, when a payment arrives after the lodge has filled, when an
  unpaid hold runs out, or with a group organiser's cancellation — its nights,
  promotion and any agreed adjustments are taken back off the ledger, and what
  the club keeps under the cancellation policy is recorded as its own
  "Cancellation fee retained" line. Once the refund, account credit or
  hand-back that follows is recorded, the booking's ledger balance is zero. A
  database update adds the new line type; it changes nothing existing. Nothing
  reads the ledger yet (#3584), so no figure anyone sees changes.
