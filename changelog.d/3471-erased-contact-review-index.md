- **The erased-member Xero contact review opens faster as a club's history
  grows (#3471).** The Finance screen that lists Xero contacts left behind by an
  erased member used to read through most of the Xero link ledger and throw
  most of it away each time it was opened, a cost that grew for the life of the
  installation. The database now has an index matching exactly what that screen
  asks for.

  Nothing visible changes: the counts and the rows listed are identical before
  and after. The update runs as part of the normal deploy with no maintenance
  window.
