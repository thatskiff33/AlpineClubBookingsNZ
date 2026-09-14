- **Video meeting settings move into the admin area, where a committee can
  change them (#2940).** Calendar events marked as a meeting carry a Join link
  to the club's own MiroTalk server. Until now every part of that — which server,
  whether the link opens the meeting straight away, how long it stays usable,
  and the sign-in it uses — was set in the server's environment file, so
  changing any of it meant asking whoever runs the server and waiting for a
  restart. There is now a **Video meetings** page under **Admin → Integrations**
  that a Full Admin can set them on directly, and a change takes effect the next
  time somebody opens a meeting.

  **An installation that was set up before this page existed carries on exactly
  as it is.** Every box starts empty, and empty means "keep using what the
  server environment already says" — which the page states next to each setting,
  naming the variable it is reading and reminding you that changing that one
  still needs a restart. Nothing is copied across on its own: a value moves into
  the club's own settings only when an administrator types it and saves. Clearing
  a box hands that one setting back to the environment again.

  The three sign-in values — the signing key and the host username and password —
  are stored encrypted, the same way the Xero, Stripe and Google credentials
  are, and are never shown again once saved. The page tells you whether each one
  is set and where it is coming from, never what it is. If two administrators
  have the page open at once, the second one to save is told that somebody
  changed it first rather than quietly overwriting them — which matters most for
  the Clear button, where the alternative is deleting a key the other person had
  just told the meeting server about.

  **What stays with whoever runs the server**, and is deliberately not on this
  page: the reverse-proxy settings that decide which address the meeting server
  answers on and how the app reaches it. Those are part of how the machine is
  set up rather than a choice the club makes.

  Two smaller things come with it. The warning about a weak signing key — one
  that is short, repetitive, or the example value MiroTalk ships — now reaches
  the person who just typed it instead of only the server log; it is still
  advice rather than a refusal, because a meeting link that silently stops
  working is worse for a club than a guessable one. And a meeting server address
  saved on this page has to be a real public https address with no sign-in
  embedded in it, because that is where a freshly signed join link gets sent.
