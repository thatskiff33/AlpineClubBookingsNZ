## Who

operator

## What to do

If you run the app without Docker Compose, set `ADMIN_ALERT_SPOOL_DIR` to a
directory that survives restarts, is owned by the user the app runs as, and is
the same for every app process. Docker Compose installs need nothing: the
release adds and mounts the `admin_alert_spool` volume itself.

## How to check it worked

The directory exists and the app user can write to it; it stays empty unless
the database has been unreachable. On Docker, `docker volume ls` lists a volume
ending in `admin_alert_spool`.
