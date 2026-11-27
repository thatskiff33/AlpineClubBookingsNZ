# Size allowances for the nightly booking money check (#4910, ALP-643)

file: src/instrumentation.node.ts
lines: 1725
reason: the new daily job's schedule block, written like its siblings with the
  running flag, Sentry check-in and recordCronRun; every scheduled job is
  registered in this one place, and moving the scheduler is its own refactor.

function: src/instrumentation.node.ts#register
lines: 1667
reason: the same schedule block, inside register beside the other daily jobs.

file: src/lib/admin-cron-health.ts
lines: 966
reason: one more daily job in the admin cron health list; the list stays the
  one place every cron job is declared.

function: src/lib/admin-cron-health.ts#getAdminCronJobDefinitions
lines: 555
reason: the same single entry, in the list of daily jobs.

file: src/lib/stuck-state-dashboard.ts
lines: 1099
reason: five lines of wiring only: the money-check items are built in their own
  module, stuck-state-money-signals.ts, and the dashboard imports them, extends
  its dependencies with theirs and adds them after the payment items.
