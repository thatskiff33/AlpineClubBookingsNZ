# Size allowances for the once-ever alert sweep (#5255)

function: src/lib/email/core.ts#sendEmail
lines: 378
reason: the alert's once-ever claim has to reach the email row's write, and
  sendEmail is the one path from the admin-alert senders to recordEmailAttempt.
  Three lines: the option, its destructure and its hand-off. Splitting sendEmail
  is its own refactor, outside this issue.

file: src/lib/admin-cron-health.ts
lines: 965
reason: one more 15-minute payments task, registered in the list beside its
  siblings; the registry stays the one place every cron job is declared.

function: src/lib/admin-cron-health.ts#getAdminCronJobDefinitions
lines: 569
reason: the same single entry, in the payments cycle's list of jobs.
