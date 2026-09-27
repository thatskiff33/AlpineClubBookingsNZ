# File-size allowances for #3663 — the cron leader runs the whole payments cycle

The payments cycle lives in its own module (`payments-cron-runner.ts`, inside
budget), and `src/instrumentation.node.ts` is shorter than on the base ref. The
one over-budget file that grows is the cron registry.

file: src/lib/admin-cron-health.ts
lines: 893
reason: hold release and the waiting-invoice reaper now record their own
  `CronJobRun` rows, and the registry is the one table every recorded job must
  appear in (the #814 contract test enforces it). Two entries beside their
  sibling `payment-recovery` entry are the change; a second registry file would
  split the list admin cron health reads.
