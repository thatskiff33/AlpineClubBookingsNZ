- **The database connection ceiling can be raised from `.env` (#4275).** A
  routine blue/green handover on a live host was measured at 39 open client
  connections, with one app container holding 18 against
  a configured limit of 10, so the deploy's pre-cutover warm-up found every
  public page failing with "too many database connections opened" and refused
  to switch, even though the previous release kept serving.

  `POSTGRES_MAX_CONNECTIONS` in `.env` now sets Postgres's `max_connections`
  for the compose database service. The default stays at 40, so nothing
  changes for an installation that does not set it; a host that sees that
  error raises it, for example to 80, and the next deploy recreates the
  database container with the new ceiling. The deploy refuses a value that is
  not a whole number above the connection pools the configuration can open
  together, or that is above 1000, before it touches the database container.
  The deployment guide's "Connection pool sizing" section records the
  measurement and why raising the ceiling, not shrinking a pool, is the right
  response.

  `POSTGRES_MEM_LIMIT` (default `768m`, unchanged) lets a host raise the
  database container's memory in step with the ceiling. The cause of the
  measurement, one app container holding more connections than its pool
  allows, was fixed at its source in #4269.
