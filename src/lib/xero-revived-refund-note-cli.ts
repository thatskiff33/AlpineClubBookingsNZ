/**
 * #4336: the command line of the revived refund-note report, kept out of the
 * script so tests run exactly what the script runs, against the same
 * `prisma` import. `scripts/xero-revived-refund-note-report.ts` only wires it
 * to the live client, sends logs to stderr and disconnects.
 */
import pino, { type Logger } from "pino";
import type { Prisma } from "@prisma/client";
import { formatRevivedRefundNoteReport } from "@/lib/xero-revived-refund-note-format";
import {
  classifyRevivedRefundNotes,
  readActiveRefundNoteLinks,
  RevivedReportCursorError,
  wasRefundNoteOnAnyLink,
  type CreditNoteReader,
} from "@/lib/xero-revived-refund-note-report";

export const REVIVED_REPORT_USAGE = `Usage: pnpm run xero:revived-refund-note-report [--list] [--json] [--resume-from <credit note id>]

Read-only. Asks Xero about every refund credit note on an active refund-note
link and lists those Xero reports VOIDED or DELETED while the app still counts
them. Changes no booking, payment, credit, link or Xero record.

Options:
  --list                Also print each payment, booking and note, and each
                        note that could not be read.
  --json                Print the full report as JSON instead (logs go to
                        stderr, so stdout is JSON only).
  --resume-from <id>    Carry on from the note the previous run printed. It
                        retries every note that run could not read; totals
                        then cover this run only.
  --help, -h            Show this help.

Exit codes: 0 every note in this run's scope was read (for a resumed run: the
walk is finished), 2 some notes were not read (see the output), 1 error.`;

export interface RevivedReportArgs {
  help: boolean;
  list: boolean;
  json: boolean;
  resumeFrom: string | null;
}

export function parseRevivedReportArgs(argv: string[]): RevivedReportArgs | { error: string } {
  const args: RevivedReportArgs = { help: false, list: false, json: false, resumeFrom: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--list") args.list = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--resume-from") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) return { error: "--resume-from needs the credit note id a stopped run printed." };
      if (args.resumeFrom !== null) return { error: "--resume-from may be given once." };
      args.resumeFrom = value;
      index += 1;
    } else return { error: `Unknown argument: ${arg}` };
  }
  return args;
}

export interface RevivedReportCliDeps {
  db: Pick<Prisma.TransactionClient, "xeroObjectLink" | "payment">;
  /** Throws a fixed-sentence error when Xero cannot be read from here. */
  preflight: () => Promise<void>;
  reader: () => CreditNoteReader;
  out: (text: string) => void;
  err: (text: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** Run the report for `argv`; returns the exit code (0 nothing left to read, 2 notes left to read, 1 refused). */
export async function runRevivedRefundNoteReportCli(argv: string[], deps: RevivedReportCliDeps): Promise<number> {
  const args = parseRevivedReportArgs(argv);
  if ("error" in args) {
    deps.err(`${args.error}\n\n${REVIVED_REPORT_USAGE}`);
    return 1;
  }
  if (args.help) {
    deps.out(REVIVED_REPORT_USAGE);
    return 0;
  }
  await deps.preflight(); // before any link is walked
  const links = await readActiveRefundNoteLinks(deps.db);
  const cursorWasLinked = args.resumeFrom !== null && (await wasRefundNoteOnAnyLink(deps.db, args.resumeFrom));
  let report;
  try {
    report = await classifyRevivedRefundNotes(links, deps.reader(), { sleep: deps.sleep, resumeFrom: args.resumeFrom, cursorWasLinked });
  } catch (error) {
    if (!(error instanceof RevivedReportCursorError)) throw error;
    deps.err(error.message);
    return 1;
  }
  deps.out(args.json ? JSON.stringify(report, null, 2) : formatRevivedRefundNoteReport(report, { list: args.list }));
  return report.walkFinished ? 0 : 2;
}

/**
 * Point a pino logger at stderr, so a log line (a rate-limit retry, a token
 * refresh) never lands in the middle of `--json` output on stdout. Uses pino's
 * exported stream symbol; the logger is otherwise unchanged.
 */
export function sendLogsToStderr(logger: Logger): void {
  (logger as unknown as Record<symbol, unknown>)[pino.symbols.streamSym] = pino.destination({ dest: 2, sync: true });
}
