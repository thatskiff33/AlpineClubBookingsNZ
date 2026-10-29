- **A treasurer can now pull a change made in Xero into the club system straight
  away, instead of waiting for the next scheduled run (#4432).** A member's page,
  a booking's page and the Xero Sync page each have a "Sync from Xero now"
  button for officers with finance edit access; view-only officers see it
  disabled. The member and booking buttons re-read just that member's or
  booking's invoices and credit notes and repair them the same way the scheduled
  run would; the Xero Sync page's button runs the whole scheduled reconcile on
  demand. Each reports what it changed, or "Already in step". The buttons are
  rate-limited, and each sync is recorded in the audit log under the existing
  `xero` category, so the same Support and Finance readers see it and nobody's
  readership changes.

  The scheduled inbound sync and the whole-club button now share one run claim
  held by the database, so the two can never run at once: whichever starts
  second reports "A sync is already running". If the server running a sync
  stops, the database frees the claim straight away.
- **The Xero Sync page now shows when the last Xero webhook arrived, and warns
  when none has arrived for too long (#4432).** While Xero is connected and
  nothing has arrived for longer than the club's threshold (24 hours unless the
  club changes it on that page), a warning appears there and in Needs Attention
  and Stuck States. Changing the threshold is recorded in the audit log.
