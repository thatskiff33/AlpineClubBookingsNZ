/**
 * #5228: LIST, AND ON REQUEST RELEASE, Xero outbox rows left PENDING without a
 * queued request the outbox can send - what a cooldown give-back left before
 * #5228. Such a row is never sent and never alerted; the outbox now skips and
 * counts it.
 *
 *   pnpm run xero:stuck-queued-report             # read-only: each row, its queue type, record and age
 *   pnpm run xero:stuck-queued-report --release   # also move exactly those rows to FAILED
 *
 * The report changes nothing. `--release` moves only the rows it has just
 * listed, and only while each is still as listed, from PENDING to FAILED with
 * `QUEUED_REQUEST_RELEASED`; it keeps each row's request, response, Xero ids
 * and keys, makes no Xero call and rewrites nothing already posted. An officer
 * then checks Xero and uses Retry. On a live site `--release` is the owner's
 * to run. Runbook: docs/MAINTENANCE.md, "Release Xero outbox rows stuck without
 * a queued request (#5228)". The logic lives in `src/lib/xero-stuck-queued-request.ts`.
 */
import "dotenv/config";
import process from "node:process";
import logger from "../src/lib/logger";
import { prisma } from "../src/lib/prisma";
import { sendLogsToStderr } from "../src/lib/xero-revived-refund-note-cli";
import { runStuckQueuedRequestReportCli } from "../src/lib/xero-stuck-queued-request";

// Before any work: stdout carries the report only.
sendLogsToStderr(logger);

runStuckQueuedRequestReportCli(process.argv.slice(2), {
  db: prisma,
  now: () => new Date(),
  out: (text) => console.log(text),
  err: (text) => console.error(text),
})
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
