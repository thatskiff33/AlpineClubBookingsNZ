- **One database pool per container, not one per server bundle (#4269).**
  Next builds the application's database client into several server bundles, and
  each one opened its own connection pool: a container set to 10 connections was
  measured holding 22 under load, which is what ran Postgres out of connections
  during a blue/green handover. The client is now shared across the bundles, and
  the same measurement reads 10. No behaviour changes.
