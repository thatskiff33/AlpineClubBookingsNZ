- **The database connection ceiling can be raised from `.env` (fork,
  booking-fixes).** A routine blue/green handover on a live host was measured
  at 39 open client connections, with one app container holding 18 against
  a configured limit of 10, so the deploy's pre-cutover warm-up found every
  public page failing with "too many database connections opened" and refused
  to switch, even though the previous release kept serving.

  `POSTGRES_MAX_CONNECTIONS` in `.env` now sets Postgres's `max_connections`
  for the compose database service. The default stays at 40, so nothing
  changes for an installation that does not set it; a host that sees that
  error raises it, for example to 80, and the next deploy recreates the
  database container with the new ceiling. The deployment guide's
  "Connection pool sizing" section records the measurement and why raising
  the ceiling, not shrinking a pool, is the right response until the
  app's multiple-pool behaviour is pinned and fixed.
