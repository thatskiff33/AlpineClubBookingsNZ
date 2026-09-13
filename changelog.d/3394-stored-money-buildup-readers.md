- **Stored booking price history is now checked before four money decisions
  (#3277).** Guest removals, financial-review re-pricing, stored account-credit
  elections, and booking-level Xero promotion lines now compare the recorded
  price build-up with the amount the system already calculates.

  A matching stored result is used directly. Missing or differing history keeps
  the existing amount and records why, so no member-visible charge, credit,
  refund, or Xero line changes in this stage. Unknown individual-night history
  still goes to financial review and is never treated as zero.
