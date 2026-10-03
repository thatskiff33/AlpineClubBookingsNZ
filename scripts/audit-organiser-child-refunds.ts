/**
 * Read-only audit of organiser-settled children whose refunded mirror is not
 * backed by a refund Stripe made out of the group's combined payment (#3653,
 * `INV-PAY-113`). The classification and its reasoning live in
 * `src/lib/organiser-child-refund-audit.ts`.
 *
 * REPORT ONLY - this script never writes, never repairs and never calls a live
 * provider. A cash mirror is only ever raised or settled from Stripe evidence,
 * so an `unbacked` row goes to an officer with this report as the evidence.
 *
 * SAFE USAGE - run against a NON-PRODUCTION copy:
 *
 *   DATABASE_URL='postgresql://user:pass@127.0.0.1:5432/scratch_copy' \
 *     pnpm run payments:audit-organiser-child-refunds
 */
import "dotenv/config";
import process from "node:process";

import { findUnbackedOrganiserChildRefundMirrors } from "../src/lib/organiser-child-refund-audit";
import { prisma } from "../src/lib/prisma";
import { getClubFormat } from "../src/lib/club-format-settings";
import { formatCents } from "../src/lib/utils";

async function main() {
  const argv = process.argv.slice(2).filter((arg) => arg !== "--");
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`Usage:
  pnpm run payments:audit-organiser-child-refunds         # read-only audit
  pnpm run payments:audit-organiser-child-refunds --json  # machine-readable rows

This audit is read-only. It never writes and never calls Xero/Stripe/SES.`);
    return;
  }
  for (const arg of argv) {
    if (arg !== "--json") throw new Error(`Unknown argument: ${arg}`);
  }

  const format = await getClubFormat();
  const findings = await findUnbackedOrganiserChildRefundMirrors();
  const counts = new Map<string, number>();
  for (const finding of findings) {
    counts.set(finding.classification, (counts.get(finding.classification) ?? 0) + 1);
  }
  console.log(`Organiser-settled children with a refunded mirror Stripe does not fully back: ${findings.length}`);
  for (const [classification, count] of counts) console.log(`  ${classification}: ${count}`);
  for (const finding of findings.filter((row) => row.classification === "unbacked")) {
    console.log(
      `  UNBACKED booking ${finding.bookingId} (group ${finding.groupBookingId}, ${finding.bookingStatus}): mirror ${formatCents(finding.mirrorCents, format)}, Stripe ${formatCents(finding.providerRefundCents, format)}, unexplained ${formatCents(finding.unexplainedCents, format)}`,
    );
  }
  if (argv.includes("--json")) {
    console.log("");
    console.log(JSON.stringify(findings, null, 2));
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : "Unknown organiser child refund audit error");
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
