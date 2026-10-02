/**
 * `pnpm run booking-ledger:census` — the booking ledger's cut-over gate
 * (#3583, `INV-MONEY-037`; design `docs/design/booking-ledger.md` §6).
 *
 * READ-ONLY. One repeatable-read, READ ONLY snapshot of the database named by
 * DATABASE_URL; it writes nothing, repairs nothing and calls no provider. Run
 * it under a SELECT-only role against production (docs/MAINTENANCE.md).
 *
 *   pnpm run booking-ledger:census                 # the summary
 *   pnpm run booking-ledger:census --json          # the whole report as JSON
 *   pnpm run booking-ledger:census --fail-on-gap   # exit 2 unless GATE_OPEN
 */
import process from "node:process";

import type { ClubFormat } from "../src/lib/club-format";
import { getClubFormat } from "../src/lib/club-format-settings";
import type { BookingLedgerCensusReport } from "../src/lib/booking-ledger-projection-census";
import { censusBookingLedgerProjection } from "../src/lib/booking-ledger-projection-census-store";
import { prisma } from "../src/lib/prisma";
import { formatCents, formatSignedCents } from "../src/lib/utils";

const USAGE = `Usage:
  pnpm run booking-ledger:census [--json] [--fail-on-gap]

  --json          Print the whole report (every disagreement, class instance,
                  coverage gap and integrity finding) as JSON.
  --fail-on-gap   Exit with status 2 unless the verdict is GATE_OPEN.
  --help, -h      Show this help.

Read-only: one snapshot, no writes, no provider calls.`;

function parseArgs(argv: readonly string[]): { json: boolean; failOnGap: boolean } {
  const options = { json: false, failOnGap: false };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    if (arg === "--json") options.json = true;
    else if (arg === "--fail-on-gap") options.failOnGap = true;
    else throw new Error(`Unknown argument: ${arg}\n\n${USAGE}`);
  }
  return options;
}

/** At most this many example booking ids per list in the summary; --json prints them all. */
const EXAMPLES = 10;

function examples(ids: readonly string[]): string {
  if (ids.length === 0) return "";
  const shown = ids.slice(0, EXAMPLES).join(", ");
  return ids.length > EXAMPLES ? ` (e.g. ${shown}, …)` : ` (${shown})`;
}

function summary(report: BookingLedgerCensusReport, format: ClubFormat): string {
  const money = (cents: number) => formatCents(cents, format);
  const out: string[] = [];
  out.push("Booking ledger projection census (#3583) — READ ONLY, nothing was changed.");
  out.push("");
  const { population } = report;
  out.push(`Bookings: ${population.bookings}   with ledger lines: ${population.bookingsWithLines}   lines: ${population.lines}`);
  out.push("");
  out.push("Identity          applicable    agree  disagree  classified  coverage");
  for (const [identity, tally] of Object.entries(report.identities)) {
    out.push(
      `${identity.padEnd(16)} ${String(tally.applicable).padStart(11)} ${String(tally.agree).padStart(8)} ${String(tally.disagree).padStart(9)} ${String(tally.classified).padStart(11)} ${String(tally.coverage).padStart(9)}`,
    );
  }
  const strands = report.info.ibUnallocatedAppliedCredit;
  out.push(
    `  CREDIT_APPLIED, information (#1620): internet-banking applied credit no Xero note allocates — realized ${strands.realized.bookings} (${money(strands.realized.cents)}), pending ${strands.pending.bookings} (${money(strands.pending.cents)})`,
  );
  out.push("");
  out.push("Coverage (holds the gate):");
  for (const [kind, ids] of Object.entries(report.coverage)) out.push(`  ${kind.padEnd(24)} ${ids.length}${examples(ids)}`);
  out.push("");
  out.push("Integrity (holds the gate):");
  for (const [kind, count] of Object.entries(report.integrity.counts)) out.push(`  ${kind.padEnd(24)} ${count}`);
  const stats = report.integrity.info.tableStatistics;
  out.push(`  information: ${report.integrity.info.unkeyedLines} line(s) posted before keys existed; table statistics ${stats ? `inserted ${stats.inserts}, updated ${stats.updates}, deleted ${stats.deletes}` : "unavailable"}`);
  out.push("");
  out.push("Named classes (each list is for the owner to acknowledge):");
  for (const [name, entry] of Object.entries(report.classes)) {
    if (entry.bookings === 0) continue;
    out.push(`  ${name.padEnd(36)} ${entry.bookings}${entry.holdsGate ? "  HOLDS THE GATE" : ""}${examples([...new Set(entry.instances.map((instance) => instance.bookingId))])}`);
  }
  out.push(`  information: RETAINED_COLLECTED ${report.info.retainedCollected.bookings} (${money(report.info.retainedCollected.cents)})`);
  out.push("");
  out.push(`Unclassified disagreements: ${report.disagreements.length}`);
  for (const row of report.disagreements.slice(0, EXAMPLES * 2)) {
    out.push(`  ${row.bookingId}  ${row.identity}  column ${money(row.columnCents)}  ledger ${money(row.ledgerCents)}  delta ${formatSignedCents(row.deltaCents, format)}`);
  }
  if (report.disagreements.length > EXAMPLES * 2) out.push("  … (--json for all)");
  out.push("");
  out.push(`VERDICT: ${report.verdict}`);
  for (const reason of report.gateClosedBecause) out.push(`  - ${reason}`);
  return out.join("\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  // The club's currency (#3565), read once, outside the snapshot. JSON keeps integer cents.
  const format = await getClubFormat();
  const report = await censusBookingLedgerProjection(prisma);
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${summary(report, format)}\n`);
  if (options.failOnGap && report.verdict !== "GATE_OPEN") process.exitCode = 2;
}

main()
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
