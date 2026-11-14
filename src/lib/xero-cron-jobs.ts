/**
 * The Xero cron tasks and the `CronJobRun.jobName` each records under (#4922
 * review). The one spelling of every Xero job name: the runner records and
 * claims runs under it, the scheduler logs and checks in to Sentry under it,
 * and admin cron health reads the recorded rows back by it. A raw copy anywhere
 * else would silently stop matching on a rename, so
 * `xero-cron-job-name-literals.test.ts` refuses one.
 *
 * Dependency-free on purpose: `instrumentation.node.ts` imports it at boot,
 * and must not pull the runner's provider and Prisma graph in to do so.
 */

export const XERO_CRON_TASKS = [
  "memberships",
  "outbox",
  "retries",
  "inbound",
  "backfill",
  "link-cleanup",
  // #4162: after the link cleanup, whose #4161 heal turns voided mirrors off.
  "bank-refund-voids",
  "report",
  "credit-sync",
  // #4270: after the inbound cycle, whose webhook path mirrors a note as it changes.
  "credit-note-mirror",
] as const;

export type XeroCronTask = (typeof XERO_CRON_TASKS)[number];

export const XERO_CRON_JOB_NAMES = {
  memberships: "xero-membership-refresh",
  outbox: "xero-outbox",
  retries: "xero-operation-replay",
  inbound: "xero-inbound-reconcile",
  backfill: "xero-link-backfill",
  "link-cleanup": "xero-link-cleanup",
  "bank-refund-voids": "xero-bank-refund-void-follow-up",
  report: "xero-reconciliation-report",
  // #2501: the checker's throttle reads its own run history back under this name.
  "credit-sync": "xero-credit-sync-check",
  // #4270: the mirror's backstop sweep.
  "credit-note-mirror": "xero-credit-note-outside-spend-mirror",
} as const satisfies Record<XeroCronTask, string>;
