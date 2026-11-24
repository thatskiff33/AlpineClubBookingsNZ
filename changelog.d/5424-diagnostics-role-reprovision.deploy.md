## Who

operator

## What to do

If AI Diagnostics is turned on with its read-only database role
(`AI_DIAGNOSTICS_DATABASE_URL`), re-run `pnpm run diagnostics:provision-role`
once the new release is serving, from the live app's environment and with the
settings you used the first time: the password the role's connection string
already uses, and `AI_DIAGNOSTICS_DB_ROLE` and
`AI_DIAGNOSTICS_DB_PRESERVE_TEMP_ROLES` if you set them. Until then every
SQL-backed diagnostics tool refuses to run. Do it after cutover, not before:
the previous release still expects the old grant. `docs/UPGRADING.md`,
"Re-provision the AI Diagnostics role after the upgrade (#5402)", has the
command and the rollback.

## How to check it worked

Admin → AI Diagnostics no longer shows the database role as `over_privileged`,
or the deployment does not use AI Diagnostics with its read-only role.
