- **Repeated wrong passwords on one account are now slowed down, however many
  internet addresses they come from (#4609).** Until now the only brake on
  password guessing was per internet address, so someone guessing an officer's
  password from many addresses at once was never slowed. Now, after five
  unsuccessful password attempts on one account, each further attempt on that
  account waits: 30 seconds, then doubling up to 15 minutes. An hour with no
  attempt forgets the count, and a correct password after the wait signs in as
  usual and clears it — so does a completed password reset.

  The wait looks exactly the same whether or not the account exists, so it
  cannot be used to find out who has an account, and no email address is
  stored: the count is kept against a scrambled key. Emailed sign-in links,
  Google sign-in and the two-factor step are unaffected, and the sign-in page
  points members at them when the club has them switched on. Members signing in
  normally see no change. One limit to know: someone who keeps guessing can keep
  an account's password sign-in waiting, so a club whose officers rely on
  password sign-in alone may want emailed sign-in links switched on.
