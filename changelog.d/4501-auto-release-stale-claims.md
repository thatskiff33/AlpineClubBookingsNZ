- **Inactive work reservations are now released automatically (#4452).** A
  reservation with no checkpoint or branch push for 72 hours is released
  without waiting for the owner (owner decision, 28 Oct 2026), and
  `pnpm run lanes:stale` prints the release to post. The Sekreton orchestrator
  now reads the whole board on every pass and keeps three units moving across
  all open issues.
