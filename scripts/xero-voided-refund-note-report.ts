/**
 * #4336 (a follow-up to #4288): READ-ONLY report of refund credit notes that
 * Xero says are VOIDED or DELETED while the app still links them as active.
 *
 *   pnpm run xero:voided-refund-note-report
 *   pnpm run xero:voided-refund-note-report --csv <file>    # also write the list as CSV
 *   pnpm run xero:voided-refund-note-report --json <file>   # also write the full report as JSON
 *
 * It writes nothing to the database and repairs nothing: the database is read,
 * Xero is read (one `getCreditNote` per distinct note, about one a second to
 * stay under Xero's limit), and the only file written is the one named by
 * `--csv` / `--json` (never overwritten). The output carries ids, note numbers
 * and amounts only. Exit code 2 means the list is INCOMPLETE (a note could not
 * be read, or a Xero limit stopped the run): run it again. Exit code 1 with
 * "Xero credentials can't be read here" means the process lacks the app's
 * AUTH_SECRET (checked before any link is walked).
 * Runbook: docs/xero/ARCHITECTURE.md, "Find refund notes Xero voided that the
 * app still shows as live (#4336)".
 */
import "dotenv/config";
import { writeFile } from "node:fs/promises";
import process from "node:process";
import { prisma } from "../src/lib/prisma";
import {
  assertXeroReadableHere,
  buildVoidedRefundNoteReport,
  XeroReportPreflightError,
  createXeroCreditNoteReader,
  formatVoidedRefundNoteReport,
  isVoidedRefundNoteReportComplete,
  voidedRefundNoteReportCsv,
} from "../src/lib/xero-voided-refund-note-report";

const USAGE = `Usage: pnpm run xero:voided-refund-note-report [--csv <file>] [--json <file>]

Read-only. Lists every active refund-note link whose Xero credit note is VOIDED
or DELETED, with its payment, booking, note number, amount and the status the
app has stored. Makes no database write and no Xero change.`;

function parseArgs(argv: string[]) {
  const options: { csv?: string; json?: string; help: boolean } = { help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--csv" || arg === "--json") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a file path`);
      options[arg === "--csv" ? "csv" : "json"] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  await assertXeroReadableHere(); // before any link is walked
  const readCreditNote = await createXeroCreditNoteReader();
  const report = await buildVoidedRefundNoteReport({ db: prisma, readCreditNote });
  console.log(formatVoidedRefundNoteReport(report));
  // `wx`: a report file is evidence, so never replace one.
  if (options.csv) await writeFile(options.csv, voidedRefundNoteReportCsv(report), { flag: "wx" });
  if (options.json) await writeFile(options.json, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  if (!isVoidedRefundNoteReportComplete(report)) process.exitCode = 2;
}

main()
  .catch((error: unknown) => {
    // A preflight refusal is a fixed sentence: print it alone, no stack.
    if (error instanceof XeroReportPreflightError) console.error(error.message);
    else console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
