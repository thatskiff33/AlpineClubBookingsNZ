- **The database container's health check now waits for the real server (#5407).**
  On a brand-new database volume, the check could report the container ready a moment before the database finished its first start, which rarely made a start-up step fail with "the database system is shutting down". The check now connects over the network port, which only the real server opens, and allows a 60-second start-up period before failures count.
  No operator action is needed. Existing databases and running sites are unaffected.
