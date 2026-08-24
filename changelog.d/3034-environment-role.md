- **This site now knows whether it is the club's live site or a copy of it, and
  it never guesses (#3034).** A copy restored from the live database holds the
  club's real members and their real email addresses, so anything that leaves the
  app — a booking confirmation, a reminder, an invoice into the club's Xero
  organisation — needs to know which installation it is running on first.

  Each deployment now states it outright, in one setting on the server:
  `APP_ENVIRONMENT_ROLE=production` for the club's live site, or
  `non-production` for a staging site, a rehearsal copy or a developer's
  machine. Nothing is inferred from the hostname, the branch, the database it is
  pointed at, or the `NODE_ENV` build mode — every one of those looks identical
  on a copy of the live site, which is exactly the case that matters.

  Where nothing has said, the answer is **"not configured"** rather than either
  one, and that is deliberate: it is not treated as the live site, and it is not
  treated as a copy either. A new **Production Or Non-Production** step on the
  setup checklist reports it, and start-up logs it.

  A Full Administrator can also force any installation to be treated as a copy,
  at **Admin → Setup & Configuration → Environment Safety**. That switch can only
  ever make the answer safer — there is no setting anywhere in the app that can
  declare an installation to be the live site, which is what stops a restored
  copy of the live database from claiming to be one. Turning it off hands the
  decision back to the deployment's own setting rather than promoting the copy.
  Both directions are Full-Administrator-only, need an explicit confirmation, and
  are recorded in the audit log with who did it and the value before and after.

  **Existing live deployments must add `APP_ENVIRONMENT_ROLE=production` before
  upgrading.** The production deploy script refuses to run without it, at step 3
  of 20 — before the database migration and long before any traffic moves — so an
  undeclared upgrade stops with the previous release still serving and nothing
  changed, rather than succeeding and quietly holding back member email.

  It refuses the opposite mistake too, and that one is easier to make: the deploy
  script deploys the club's live site and nothing else, so it also refuses a
  `.env` that says `non-production`. The sample file ships `non-production`
  because it is a local-development template, and it is also the file people diff
  against their real settings when upgrading — so copying that value across would
  otherwise have produced a live site quietly behaving as a copy. Watch out for
  the near-miss as well: this is `APP_ENVIRONMENT_ROLE`, not the
  `APP_RUNTIME_ROLE` already beside it, which names the container slot and is
  never read for this. After the deploy, check the **Production Or
  Non-Production** step on Admin → Setup actually reads *production*: a
  non-production installation shows a green tick too, so it is the message that
  carries the answer, not the tick.
  `docs/guides/environment-role.md` is the full walkthrough, and
  `docs/UPGRADING.md` has the upgrade step.

  **One more audit entry is readable at support level.** Switching the safer
  override on or off records an `ENVIRONMENT_SAFETY_OVERRIDE_UPDATED` entry filed
  under the **admin** category, which admins holding support access can read
  without membership access. The entry holds the value of that one switch before
  and after, and who changed it — no member details, no settings values and
  nothing about the database. It is filed as admin rather than security because it
  records a change to what this installation *does*, not to who may sign in or
  what they may reach.

  **The deploy also asks each container what it actually received.** Validating
  the settings file and validating what the containers were given turn out to be
  different questions: Docker Compose prefers a value set in the shell the deploy
  was started from over the one in the file, and reads the last of any duplicate
  assignments rather than the first. So the deploy now refuses a duplicated entry
  — in any of the shapes a settings file normally carries, including an indented
  or `export `-prefixed line — and refuses a shell value that disagrees with the
  file. Then, with the new release started and the previous one still serving
  every request, it asks each container which answer the application itself read,
  stopping before the switch-over if any of them says anything other than
  production. It asks the app rather than re-reading the container's settings so
  there is only ever one implementation of the rule.

  **Fewer deploys refused for no good reason.** An `export ` prefix, spaces around
  the `=`, or quotes round the value used to abort the deploy — the first two
  reported as a missing entry for a setting plainly present in the file. All three
  are now read the way Docker Compose reads them.

  **A copy says so in its own start-up log.** An installation that comes up as a
  copy now records one line saying so, and which of the two sources decided it, so
  somebody reading the log of a site brought up by hand can tell that a live club
  has been declared a copy by mistake. Alongside it, the Environment Safety page
  and the setup checklist have a place for how much application email has been
  held back — shown whenever delivery is being held back, whether the installation
  is a declared copy or has not been declared at all. That number is what tells a
  busy live club apart from an idle test copy. Nothing counts it yet, and the page
  says so in those words rather than showing a zero, because "none held back" and
  "not counted yet" mean opposite things. The counting arrives with #3035.

  This release records and reports the answer; the parts that act on it — holding
  back email to members, and keeping a copy's invoices out of the club's real
  accounting — follow in #3035 and #3036, so do not yet treat a copy as safe to
  run against real member data.
