- **Upgrading to v0.14.0 must stop incompatible old copies before starting
  the new release (#5270, #4682).** v0.14.0 is the first public release that
  both reads and mints the new saved-card charge keys (`_v2`). The v0.14.0
  changelog's #4646 entry said minting would wait for a later release; its
  #4682 entry describes what actually shipped. This corrects that earlier
  promise without changing the released code.

  No rolling or blue/green overlap with v0.13.2 or earlier is safe. Once
  v0.14.0 has run, do not roll back below v0.14.0: an older copy could retry
  an unresolved charge under a different key and charge twice. The
  upgrade guide (`docs/UPGRADING.md`) and production runbook now explain
  the boundary and how to check local attempts and Stripe records if it was
  crossed.

  The stopped-runtime procedure now covers the old colour, cron leader and
  workers before deployment, and keeps them stopped after a failed cutover.
  Incident checks also locate v0.13.2's unstored shared key in Stripe request
  logs.
