- **A test or staging copy of the club's site no longer emails the club's real
  members (#3035).** A copy is normally restored from the live database, so it
  holds every member's real address. Until now the only thing standing between
  such a copy and the club's inbox was remembering to change the mail settings,
  and every send path had its own idea of when to send: the ordinary mailer, the
  job that retries failed mail, and the three places the accounting system is
  asked to email an invoice.

  All five now ask one question first — *is this installation the club's live
  site?* — and that question is answered by the single explicit declaration
  introduced in the previous release, never guessed from a hostname, a branch or a
  build mode.

  What an operator will notice, on each kind of installation:

  - **The club's live site behaves exactly as before.**
  - **A copy sends nothing**, and says so. Each held-back message is recorded
    against its own reason, kept separate from the per-booking "No emails" switch,
    so nobody reading the log later mistakes one for the other.
  - **An installation nobody has declared sends nothing either**, and this one is
    treated as a fault rather than as a decision: the message is queued, and most
    messages go out by themselves as soon as the role is declared.

    There is one honest exception, and the operator is told which case they are
    looking at. Messages carrying something that must not be stored — a sign-in
    link, a door code, a payment link — keep no copy of themselves, so nothing can
    replay them. Those are listed for review under **Admin -> Email** and have to
    be re-sent by hand once the role is declared, and each one says so in as many
    words instead of promising it will sort itself out.
  - **A site declared as both the live site and a mail capture is refused.** That
    combination would accept every message and deliver none of them, which is a
    silent mail outage, so it is stopped and named rather than allowed to run.

  Admin → Environment now shows **how much email this installation has held
  back, and when the most recent one was**. That number is what tells a live club
  that has been wrongly declared a copy apart from an ordinary staging copy — a
  real club withholds a steady, recent stream, while an unused copy withholds
  almost nothing. It reports "not available" rather than a reassuring zero if it
  cannot read the figure. **It also appears on the live site in the one case where
  the live site really is holding mail back** — a deployment that says it is both
  the club's live site and a mail capture — with its own wording and its own
  repair, because there the answer is not "your declaration is wrong" but "your
  two mail settings contradict each other".

  **Three things that used to be recorded as having happened when they had not**,
  each of which cost a member a message they were waiting for:

  - the pre-arrival note, which carries the lodge's door code, marked the booking
    as reminded before it sent — so a held-back note was never re-tried and the
    member arrived at a locked lodge;
  - the quote-expiry reminder wrote a "reminder sent" record, and an audit entry
    saying so, for a reminder nobody received, on a quote about to expire;
  - the scheduled coming-of-age job turned a young member into an adult with a
    login and then swallowed the fact that the invitation had not gone out, so
    nobody ever told them.

  All three now check whether the message actually went, and put the booking,
  quote or membership back as it was if it did not. A copy that cannot send stops
  before it claims anything at all, so an idle staging site no longer looks like a
  club whose mail is being held back.

  **And a member is no longer told their email address is undeliverable when it is
  not.** Sending a split-payment link from an installation nobody has declared
  used to answer with exactly that; it now says the club could not send it just
  now and to try again.

  A test installation that needs to *see* its own mail can declare a capture
  mailbox (`USE_LOCAL_CAPTURE=true`) pointed at a local sink that forwards
  nothing; a copy is then allowed to transmit into it. This is a deliberate
  declaration and never a guess, the live site refuses it, and it does not cover
  invoice emails — the accounting system sends those from its own servers to the
  member's real address, so a copy does not ask for one at all.

  One thing to check on upgrade: a deployment that sets none of `USE_AWS_SES`,
  `USE_SMTP_RELAY` or `USE_LOCAL_CAPTURE` used to fall back to live AWS SES
  silently. The club's live site keeps that fallback; anything else now refuses to
  open a mail connection until one of the flags is set explicitly, so a copy
  cannot reach the club's mail provider by default.

  A note for anyone running this on their own machine: with the values shipped in
  `.env.example` every send is held back, so the familiar "Email sent (dev mode)"
  line no longer appears. Run a capture mailbox, point the `EMAIL_SERVER_*`
  settings at it and set `USE_LOCAL_CAPTURE=true` to get local mail flowing again.

  Three settings that were documented but never actually reached the application
  on a Docker deployment now do: the two Xero optional-behaviour switches and the
  temporary legacy-SNS-signature override, along with the currency, locale,
  audit-archive, cron-status and DR-bootstrap settings beside them. Nothing changes
  for an existing deployment — every one of them already behaved as though unset —
  but setting one now works.
