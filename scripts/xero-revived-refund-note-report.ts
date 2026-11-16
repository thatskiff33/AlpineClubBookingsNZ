/**
 * #4336 (owner decision 24 Oct 2026, on #4288): READ-ONLY REPORT of refund
 * credit notes Xero says are VOIDED or DELETED while the app still has their
 * link active and may count them as refund cover.
 *
 * Run it once on the live deployment after upgrading from any version before
 * #4341 (v0.13.2 or earlier):
 *
 *   pnpm run xero:revived-refund-note-report                       # counts and cents per payment source
 *   pnpm run xero:revived-refund-note-report --list                # also each payment, booking and note
 *   pnpm run xero:revived-refund-note-report --json                # machine-readable (logs go to stderr)
 *   pnpm run xero:revived-refund-note-report --resume-from <id>    # carry on a run that stopped early
 *
 * It changes no booking, payment, credit, link or Xero record. It reads the
 * database outside any transaction, then asks Xero about each distinct note
 * once (`getCreditNote`, one every 1.5 seconds). Each read writes API-usage
 * rows, as every metered Xero call does; if the token needs refreshing, the
 * shared client stores the new token, its refresh lease and a credential audit
 * row, and a failed refresh alerts the admins as it would for the app. Output
 * goes to the terminal only; it names members' payments, so never post it
 * publicly.
 *
 * Exit codes: 0 the list is complete; 2 it is incomplete (see the output);
 * 1 an error, a refused argument or the credentials preflight. Runbook:
 * docs/MAINTENANCE.md, "Find refund notes Xero voided that the app still
 * counts (#4336)". The logic lives in `src/lib/xero-revived-refund-note-cli.ts`.
 */
import "dotenv/config";
import process from "node:process";
import logger from "../src/lib/logger";
import { prisma } from "../src/lib/prisma";
import { runRevivedRefundNoteReportCli, sendLogsToStderr } from "../src/lib/xero-revived-refund-note-cli";
import {
  assertXeroReadableHere,
  createXeroCreditNoteReader,
  XeroReportPreflightError,
} from "../src/lib/xero-revived-refund-note-reader";

// Before any work: stdout carries the report (or its JSON) only.
sendLogsToStderr(logger);

runRevivedRefundNoteReportCli(process.argv.slice(2), {
  db: prisma,
  preflight: () => assertXeroReadableHere(),
  reader: () => createXeroCreditNoteReader(),
  out: (text) => console.log(text),
  err: (text) => console.error(text),
})
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // A preflight refusal is a fixed sentence: print it alone, with no stack.
    console.error(error instanceof XeroReportPreflightError ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
