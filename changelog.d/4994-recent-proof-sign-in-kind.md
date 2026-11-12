- **An emailed link, Google, or a recovery code no longer counts as confirming
  who you are (#4994).** The five-minute confirmation clock now starts for a
  password only when no authenticator app is still owed, and for an
  authenticator-app code. An emailed second factor does not count as still
  owed, so that password starts the clock and the later emailed code leaves
  it where it is. Signing in from an emailed link or with Google, or finishing
  with a recovery code, leaves the clock unset, so the first protected action
  asks for a password. Nothing asks for that confirmation yet.
