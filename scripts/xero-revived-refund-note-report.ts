/**
 * #4336 (owner decision 24 Oct 2026, on #4288): READ-ONLY REPORT of refund
 * credit notes Xero says are VOIDED or DELETED while the app still has their
 * link active and may count them as refund cover.
 *
 * Run it once on the live deployment after upgrading from any version before
 * #4341 (v0.13.2 or earlier):
 *
 *   pnpm run xero:revived-refund-note-report            # counts and cents per payment source
 *   pnpm run xero:revived-refund-note-report --list     # also each payment, booking and note
 *   pnpm run xero:revived-refund-note-report --json     # machine-readable
 *
 * It writes no booking, payment, credit, link or operation row and repairs
 * nothing. It reads the database outside any transaction, then asks Xero about
 * each distinct note once (`getCreditNote`, one every 1.5 seconds). Like every
 * metered Xero call, each read adds to the API-usage meter, and the shared Xero
 * client may refresh its stored token. Output goes to the terminal only; it
 * names members' payments, so never post it publicly.
 *
 * Exit codes: 0 the list is complete; 2 it is incomplete (a note could not be
 * read, or the run stopped early): run it again; 1 an error, including the
 * credentials preflight. Runbook: docs/MAINTENANCE.md, "Find refund notes Xero
 * voided that the app still counts (#4336)".
 */
import "dotenv/config";
import process from "node:process";
import type { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import {
  classifyRevivedRefundNotes,
  formatRevivedRefundNoteReport,
  isRevivedRefundNoteReportComplete,
  readActiveRefundNoteLinks,
} from "../src/lib/xero-revived-refund-note-report";
import {
  assertXeroReadableHere,
  createXeroCreditNoteReader,
  XeroReportPreflightError,
} from "../src/lib/xero-revived-refund-note-reader";

const USAGE = `Usage: pnpm run xero:revived-refund-note-report [--list] [--json]

Read-only. Asks Xero about every refund credit note on an active refund-note
link and lists those Xero reports VOIDED or DELETED. Writes no booking,
payment, credit, link or operation row.

Options:
  --list       Also print each payment, booking and note, and each note that
               could not be read.
  --json       Print the full report as JSON instead.
  --help, -h   Show this help.`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const unknown = argv.filter((arg) => arg !== "--list" && arg !== "--json");
  if (unknown.length > 0) {
    console.error(`Unknown argument: ${unknown.join(" ")}\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  await assertXeroReadableHere(); // before any link is walked
  const links = await readActiveRefundNoteLinks(prisma as unknown as Prisma.TransactionClient);
  const report = await classifyRevivedRefundNotes(links, createXeroCreditNoteReader());
  console.log(argv.includes("--json") ? JSON.stringify(report, null, 2) : formatRevivedRefundNoteReport(report, { list: argv.includes("--list") }));
  if (!isRevivedRefundNoteReportComplete(report)) process.exitCode = 2;
}

main()
  .catch((error: unknown) => {
    // A preflight refusal is a fixed sentence: print it alone, with no stack.
    console.error(error instanceof XeroReportPreflightError ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
