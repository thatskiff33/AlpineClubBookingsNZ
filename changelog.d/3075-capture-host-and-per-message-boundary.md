- **A test copy pointed at a real mail relay can no longer email your members
  while reporting that it did not (#3071).** Declaring a capture mailbox
  (`USE_LOCAL_CAPTURE=true`) tells the site that `EMAIL_SERVER_HOST` is a sink
  that forwards mail nowhere, which is what lets a copy send at all. The two
  settings were read as one pair with nothing checking them against each other,
  so an installation that already had a working relay and simply flipped the flag
  kept its live relay host: mail went to real members, and the log recorded that
  the message had reached nobody. That combination is now refused, the held-back
  mail says which setting to fix, and it goes out by itself once the host points
  at the capture.

  **If you run a copy that uses a capture mailbox, check its `EMAIL_SERVER_HOST`
  when you upgrade** — `docs/UPGRADING.md` has the two-setting walkthrough. A
  container name, `localhost` or any private address needs nothing further. A
  genuine sink that only has a public name can be declared with
  `EMAIL_CAPTURE_ALLOW_PUBLIC_HOST=true`, which is deliberately a decision
  somebody makes rather than something the site guesses. The club's live site is
  unaffected and could never reach this state.

- **Switching the safer override on now stops mail immediately, including a batch
  already in progress (#3071).** The switch that makes an installation behave as a
  copy took effect on the next message for ordinary email, but the retry job — the
  one that re-sends previously failed messages — asked once per run and then worked
  through up to fifty of them. So an administrator who realised a copy was about to
  email real members, and switched the override on, could still have several dozen
  messages go out. The job now re-checks before every message, stops cleanly, and
  leaves every remaining message untouched so it is not lost.

- **A settlement invoice can no longer be emailed on the strength of a permission
  check made before a long wait (#3071).** Group settlement invoices checked
  whether the installation was allowed to send, then queued for an exclusive
  database lock behind every other invoice run, then asked the accounting system to
  email the invoice. The wait has no fixed length, so an override switched on
  during it was not noticed. The check is now repeated inside that lock,
  immediately before the invoice is sent.

- **Clearer wording, and one honest limit stated (#3071).** Repair messages that
  told an operator to declare a capture mailbox now also name
  `EMAIL_SERVER_HOST`, because following the old advice on an installation that
  already had a relay was how the problem above was reached. Where the site
  records that a message went into a capture, it no longer claims the message
  "can reach nobody" — it says what the deployment declared and what cannot be
  verified, because a mail server on a private address can still relay outward
  and no check can see that. `docs/guides/environment-role.md` also now says
  which three places report an undeclared installation, and why there is
  deliberately no warning anywhere else, and warns that restoring a copy's
  database backup into the live site brings the copy's safer override with it.

  Every item in this release note came from an external reviewer running the only
  real staging deployment of this application; the first needed an existing relay
  configuration to upgrade from, which no fresh install reproduces.
