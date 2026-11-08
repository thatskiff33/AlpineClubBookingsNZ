- **Moving stored secrets onto the data-encryption key, and switching the old
  key off (#4456).** A new command, `pnpm run data-keys:reencrypt`, moves every
  stored provider credential and authenticator-app secret that is still under
  `AUTH_SECRET`, or under an older data key, onto the current
  `DATA_ENCRYPTION_KEYS` key. Values and members' authenticator apps are
  unchanged. It is safe to run while the site serves traffic: a row that
  changes while it is being moved, such as a Xero token refresh, wins and is
  retried. `--dry-run` only counts. A run that writes needs
  `--expect-fingerprint`, copied from Admin → Setup → "Data Encryption Key",
  and refuses unless its own key matches, so a stale `.env` cannot move data
  under the wrong key. The report ends with what remains on old keys and never
  prints a key or a stored value. The setup step stays amber while anything is
  under an older key in the ring. Each move is recorded in the
  audit log under the `data-key-reencrypt` job.

  With `--retire-legacy-recovery-codes` it also retires the recovery codes
  issued before the key was set, so they stop working on every server, with or
  without the key. Members holding them keep seeing the notice asking them to
  generate a new set.

  A new optional setting, `DATA_ENCRYPTION_LEGACY_KEY=retired`, stops the site
  reading anything under `AUTH_SECRET` once the command reports nothing left on
  it. After that, the auth secret signs sessions and links and protects no
  stored data. Unset it to undo.

  **What to do:** nothing until you have set `DATA_ENCRYPTION_KEYS`. Then
  follow "Moving stored data to the current key" and "Retiring the legacy key"
  in `DEPLOYMENT.md`. Run the command only once every container has the key.
