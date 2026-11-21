- **Older passwords are brought up to the current hashing strength when the
  member next signs in (#5261).** Passwords set before v0.14.0 were stored at a
  lower bcrypt cost, so for those members a wrong password was answered faster
  than an email with no account, which could reveal that the account exists.
  A wrong password against an older stored password now takes as long as an
  unknown email. After a successful password sign-in or password step-up, the
  password is stored again at the current cost. Members notice nothing and stay
  signed in, and a password changed at the same moment is never overwritten.

  A member's first password sign-in after upgrading takes a fraction of a
  second longer, once. Accounts that only use passkeys, Google or email links
  keep the older stored cost until their next password sign-in; their sign-in
  timing already matches an unknown email. Older releases running alongside
  during an upgrade can still read the new passwords.
