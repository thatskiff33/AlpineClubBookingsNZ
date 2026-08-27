- **A member joining near a fee change is now quoted the fee that applies on the
  club's own day (#3123).** The joining fee and entrance fee are read from a
  schedule that changes on a set date. Deciding which side of that date today
  falls on used to be answered by the timezone of the server the site runs on,
  rather than the timezone the club has saved on its settings page. Where those
  two disagreed, a member could be quoted the new fee a day before it was due to
  start — measured on one schedule as $100 where the correct answer was $250.

  The same correction has been applied to the last of the club's date decisions
  that were still answered by the server: which day a booking may be edited or
  cancelled from, which day a bed is released, which reporting month a finance
  figure belongs to, and which day appears on a member's payment confirmation.

  **Nothing changes for a club whose saved timezone matches its server's**,
  which is every club running this today, and no stored value has been altered.
  A club that later moves its site to a server in a different country — or
  simply corrects its saved timezone — no longer has to think about whether the
  two agree, because only the saved one is consulted.

- **The application can no longer be written in a way that reads the server's
  timezone by accident (#3123).** Previously a developer who forgot to say which
  timezone they meant got the server's, silently and with no warning; that is
  how every one of the defects above was introduced. The helpers now require the
  timezone to be stated, so the mistake stops being possible rather than being
  something a reviewer has to notice.

  This is invisible to operators and members. It is recorded here because it is
  the reason the class of problem is closed rather than merely cleaned up.
