- **The switch for unnamed adults on school booking requests now actually reaches
  the app (#3964).** The two settings that turn on #3413's pending school-adult
  places, `PENDING_SCHOOL_ADULTS_ENABLED` and
  `BLUE_GREEN_OLD_APP_AND_WORKERS_STOPPED`, were never passed into the app
  containers, so setting them in `.env` as the upgrade runbook says changed
  nothing and the feature stayed off. `docker-compose.yml` now passes both
  through, empty by default.

  Nothing changes until you set them: empty keeps the feature off, exactly as
  before. Set them only when the runbook's #3413 section says to.
