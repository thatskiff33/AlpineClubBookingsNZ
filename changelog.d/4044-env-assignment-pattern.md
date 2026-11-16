- **The deploy now catches a second `APP_ENVIRONMENT_ROLE` line written with
  a colon (#4026).** Docker Compose reads `KEY: value` in a `.env` file as well
  as `KEY=value`. The production deploy's check for a duplicated
  `APP_ENVIRONMENT_ROLE` only recognised the `=` form, so a second line such as
  `APP_ENVIRONMENT_ROLE: non-production` further down the file slipped past it,
  and Compose then handed that value to every container.

  The check now counts every shape Compose accepts — indented, `export `-prefixed,
  spaces around the separator, and `=` or `:` — and refuses the deploy at step 3
  when the key appears more than once. A single line in any of those shapes is
  still accepted. The rule lives in one function, `env_assignment_pattern`, in
  `scripts/lib/compose-env-file.sh` (moved there from the deploy script by
  #4980). A fork's own deploy checks can source that library directly, which
  has no side effects, instead of keeping a hand-made copy. Do not source
  `scripts/run-production-blue-green-deploy.sh` to reach it: that starts a
  production deploy.
