- **Stay dietary and allergy notes are now cleared automatically after the
  stay (#4916).** Each guest's dietary note on a booking used to stay in the
  database forever, and non-member guests, including children, had no
  automatic way for it to be removed. A new nightly job now clears the note
  once the stay ended more than a set number of days ago, for every guest and
  every booking status. Names, nights, prices, the booking and a member's own
  profile note are not touched, and the audit log records only how many
  notes were cleared.

  **This ships switched on, with a 30-day period.** The first nightly run
  after upgrading (03:30 club time) clears every stay note whose stay ended
  more than 30 days ago, and cleared notes can only be recovered from a backup
  taken before that run. To keep them, open **Admin → Privacy retention**
  straight after deploying and untick **Enable after-stay dietary clearing**,
  or choose a different period (1 to 365 days). That page also shows how many
  notes the next run would clear. Changing these settings needs both support
  and bookings edit access. The other three retention jobs still ship off.
