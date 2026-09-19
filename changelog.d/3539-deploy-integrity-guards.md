- **The production deploy script now refuses to ship a release nobody else has,
  keeps the previous release recoverable, and leaves a written record when it
  fails part-way (#3539).** Four changes to
  `scripts/run-production-blue-green-deploy.sh`, each one prompted by something
  that really happened on a live deployment rather than by tidiness. They only
  affect clubs that self-host with the blue/green deploy script; nothing changes
  for anyone using the site.

  **A commit that exists on no remote is refused.** Production once ran code
  built by hand on the deploy host from a branch that was never pushed. It could
  not be rebuilt, could not be reviewed, and silently invalidated the next
  release's preparation — the list of pending database changes, the safety
  ledger and the upgrade notes are all worked out against the commit the
  repository has, not the one running. The deploy now checks before it starts
  and stops if the commit is nowhere but that disk. Building from a local branch
  is still allowed during a registry outage; it just has to be a decision
  somebody wrote down, so it takes both a switch and a written reason and the
  reason goes into the deploy log.

  **The previous release can still be rolled back to.** Rolling back means
  pointing the web server at the colour that was serving before, and that needs
  its images still on the host — but the deploy's own disk cleanup was deleting
  them. It removes the old colour's container near the end, which leaves the old
  image used by nothing, and then prunes it. The deploy reported success while
  the rollback it documents had quietly become impossible. The deploy now pins
  those images before it cleans anything, and pins them by image identity rather
  than by name, because in a locally-built deploy the *name* is moved onto the
  new image half way through.

  **A deploy that dies after changing the database leaves a record.** From that
  point the database may match neither the old release nor the new one, and the
  only account of what happened was whatever was still on the operator's screen.
  Any failure from that step onward now writes a file naming the step it died
  on, the release attempted, whether traffic had moved, and — most importantly —
  which database changes had *started*, including any that began and did not
  finish. If the database could not be reached at all, the record says that,
  rather than reporting "nothing happened" in the one situation where that would
  be the most misleading thing it could say.

  **Images built on the host now carry the release identifier.** Building by
  hand skipped the details the automated build supplies, so the resulting image
  could not say which release it was. That left the pre-cutover page-warming
  check unable to confirm it had warmed the right release, and the public
  website's security header falling back to a per-build value. There is now a
  supported `--build-and-push-images` mode that passes the same details, and it
  starts the image it just built and reads the identifier back out before
  pushing anything. It also fixes a latent fault on the same path, where the
  build step tried to read the commit from a copy of the code that deliberately
  has no version history, and the deploy aborted with no explanation.
