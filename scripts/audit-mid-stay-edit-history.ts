/**
 * Read-only audit of booking edits made after check-in, before this install
 * took the #2743 and #2744 fixes (#5242, `INV-MOD-025`). It lists each edit
 * that may have billed a guest again for nights after their stay ended, or
 * credited nights back at the rates and membership standing of the day, with
 * what may be at stake.
 *
 * REPORT ONLY - this script never writes, never repairs and never calls a live
 * provider. It has no `--apply`. The decision goes to the owner on #5242 with
 * the summary as the evidence. The rules and their limits live in
 * `src/lib/mid-stay-edit-history-audit.ts`; the runbook is in
 * `docs/MAINTENANCE.md`.
 *
 * Running it on production is an owner step. Agents use a local or test
 * database only.
 *
 *   pnpm run --silent bookings:audit-mid-stay-edits > ~/mid-stay-edit-audit.txt
 *   pnpm run --silent bookings:audit-mid-stay-edits --summary
 */
import "dotenv/config";
import process from "node:process";

import { auditMidStayEditHistory } from "../src/lib/mid-stay-edit-history-audit";
import {
  formatMidStayEditAuditReport,
  parseMidStayEditAuditArgs,
} from "../src/lib/mid-stay-edit-history-audit-report";
import { prisma } from "../src/lib/prisma";
import { getClubFormat } from "../src/lib/club-format-settings";
import { readClubTimeZoneOutsideRequest } from "../src/lib/club-time-zone-runtime";

function printUsage() {
  console.log(`Usage:
  pnpm run --silent bookings:audit-mid-stay-edits                  # full report, with booking ids
  pnpm run --silent bookings:audit-mid-stay-edits --summary        # header and counts only: safe to post on #5242
  pnpm run --silent bookings:audit-mid-stay-edits --json           # report plus every examined edit as JSON

This audit is read-only. It never writes and never calls Xero/Stripe/SES.
It writes no file: redirect its output to keep one, to a path outside this
checkout (such as ~/), and keep that file off the public repository and issue. Do not run it while a migration runs: it reads in
one snapshot held for up to 120 seconds.

Options:
  --summary              Print the header and counts alone.
  --json                 Emit machine-readable JSON after the report.
  --before <ISO instant> Examine edits before this moment (zone required, e.g.
                         2026-08-11T00:00:00+12:00) instead of the cut-off derived
                         from the marker migration.
  --help, -h             Show this help.
`);
}

async function main() {
  const args = parseMidStayEditAuditArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  // The club's format and zone, read once before the audit's snapshot.
  const format = await getClubFormat();
  const zone = await readClubTimeZoneOutsideRequest();
  const result = await auditMidStayEditHistory({ zone, before: args.before });
  console.log(formatMidStayEditAuditReport(result, format, { summaryOnly: args.summary }));

  if (args.json) {
    console.log("");
    console.log(JSON.stringify(result, null, 2));
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : "Unknown mid-stay edit audit error");
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
