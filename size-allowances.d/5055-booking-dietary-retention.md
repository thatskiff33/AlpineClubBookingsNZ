# File-size allowances for #5055

file: src/instrumentation.node.ts
lines: 1726
reason: the post-stay dietary clear joins the existing privacy-retention job
  list in the nightly scheduler as one more row of the same loop. Moving that
  loop out of the scheduler to admit one row would split the retention jobs'
  schedule from every other cron's, which is where operators look for it.

file: src/lib/admin-cron-health.ts
lines: 954
reason: the new job is listed beside the other two privacy-retention jobs in
  the same defineCronJob mapping, with its own "ships on" note. The growth is
  that row, its note and two imports; splitting the cron-health table would
  separate the job's health definition from its siblings.
