# File-size allowance for #4904 — database-role readiness step

The new "Database role" check lives in its own module,
`src/lib/setup-readiness-database-role.ts`, and its server read in
`src/lib/setup-readiness-db.ts`. What is left in the report builder is only the
wiring every step needs there.

file: src/lib/setup-readiness.ts
lines: 2294
reason: Seven lines of wiring for one new readiness step: its import, its id in
  `SETUP_STEP_IDS`, the `databaseRole` field on `SetupDatabaseSnapshot`, one
  `applyProgress` call in the report, and `DATA_ENCRYPTION_KEYS` added (with its
  one-line reason) to the wizard's reminder list. Each has to sit beside its
  siblings in this file: the step list, the snapshot type and the report are the
  single definitions every step joins. Splitting the 2,300-line builder is a
  separate refactor, not part of a docs-and-one-warning change.
