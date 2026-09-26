/**
 * Read-only audit of payments whose stored refunded total is below their card
 * refunds plus account-credit settlements (#3640, `INV-PAY-103`). It reports
 * apart the part the old max-based arithmetic can account for (a card refund
 * that met a credit) and a shortfall with another cause.
 *
 * REPORT ONLY - this script never writes, never repairs and never calls a live
 * provider. The repair question goes to the owner with this report as the
 * evidence. The arithmetic and its caveats live in
 * `src/lib/refunded-total-shortfall-audit.ts`.
 *
 * SAFE USAGE - run against a NON-PRODUCTION copy:
 *
 *   DATABASE_URL='postgresql://user:pass@127.0.0.1:5432/scratch_copy' \
 *     npm run payments:audit-refunded-total
 */
import "dotenv/config";
import process from "node:process";

import {
  auditRefundedTotalShortfalls,
  formatRefundedTotalShortfallReport,
} from "../src/lib/refunded-total-shortfall-audit";
import { prisma } from "../src/lib/prisma";
import { getClubFormat } from "../src/lib/club-format-settings";

function printUsage() {
  console.log(`Usage:
  npm run payments:audit-refunded-total            # read-only audit (default)
  npm run payments:audit-refunded-total -- --json  # also emit machine-readable JSON

This audit is read-only. It never writes and never calls Xero/Stripe/SES.

Options:
  --json          Emit machine-readable JSON alongside the human report.
  --help, -h      Show this help.
`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    return;
  }
  for (const arg of argv) {
    if (arg !== "--json") throw new Error(`Unknown argument: ${arg}`);
  }

  // The club's format (#3565), read once before the audit query.
  const format = await getClubFormat();
  const result = await auditRefundedTotalShortfalls();
  console.log(formatRefundedTotalShortfallReport(result, format));

  if (argv.includes("--json")) {
    console.log("");
    console.log(JSON.stringify(result, null, 2));
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : "Unknown refunded-total audit error");
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
