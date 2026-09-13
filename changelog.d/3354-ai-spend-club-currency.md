- **AI spend caps are now counted in the club's own currency (#3354).** The
  AI help assistant and AI Diagnostics price their usage in New Zealand dollars.
  For a club configured for another currency, the monthly caps read as the
  club's money but were compared against a New Zealand-dollar figure, so they
  were off by the exchange rate, and the module descriptions said "NZ$10" and
  "NZ$0" whatever the club's currency.

  Both AI settings pages gain a **Currency for AI spend** card: an administrator
  with support-edit access enters how many units of the club's currency one New
  Zealand dollar buys, and the card shows the rate and when it was last set, so a
  stale rate is visible rather than silent. Every estimate is converted through
  that one shared rate (rounded up, so the caps still trip early rather than
  late) before it counts against a cap, and the caps and spend figures render in
  the configured currency. Until a rate is set, spend is counted as if one New
  Zealand dollar were one unit of the club's currency, which is exactly how it
  was counted before, so nothing changes for a club that does not act. A New
  Zealand club sees a one-sentence note that no conversion applies and nothing
  to set. Past usage is not re-priced. One new settings table; the rate, like
  the caps, does not travel in a config-transfer bundle. A change to the rate is
  recorded in the audit log under the `admin` category, exactly as changes to
  the two AI spend caps already are, so it is readable with the same
  support-view access.
