- **Members can use a passkey as the second sign-in step (#4617).**
  On Profile, under Security, a member can add a passkey and remove one they
  no longer want. Adding or removing a passkey does not turn the authenticator
  app or email code on or off.

  The next sign-in is still the password, then the passkey when one is saved,
  shown beside the app or email code and the recovery code. Confirm-it's-you
  can use that same passkey. An emailed code still cannot confirm a session.
  The passkey is bound to this site's address (`NEXTAUTH_URL`).
