- **A failing real-database test run now stops a merge (#4907).** The test
  files that run against a real PostgreSQL database (the proofs that two
  people cannot both take the last bed or both get the same refund, and that
  locks are taken in the right order) used to run in an advisory job: a red
  or timed-out run could still be merged, by hand, by auto-merge or by
  Dependabot. The required `verify` check now waits for that job, renamed
  `Real-PostgreSQL suites (all)`, and fails unless it passed in the same run.

  Through `verify`, a failed, cancelled or timed-out real-database run on
  `main` also stops that commit's release image from being published.

  Clubs see nothing different in the app. Maintainers will find `verify`
  takes about as long as the real-database job: 18 to 25 minutes (median
  23) over the successful `main` runs of 12 to 14 November 2026.
