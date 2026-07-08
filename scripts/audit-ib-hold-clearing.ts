#!/usr/bin/env npx tsx
/**
 * Read-only audit of Internet-Banking hold-expiry invoice-clearing that was
 * under-sized before #1597 (the clearing credit note was sized at the
 * credit-reduced payment amount, not the invoice's full finalPrice, leaving the
 * applied-credit slice open on the Xero invoice).
 *
 * REPORT ONLY — this script never writes and never calls a live provider. It
 * lists each affected booking's expected-vs-actual clearing amounts and the open
 * delta; the operator applies any repair by hand (the existing
 * xero-booking-repair CLI cannot express the remainder repair — see
 * docs/MAINTENANCE.md). There is no --apply here by design (owner decision,
 * 2026-07-08).
 *
 * SAFE USAGE — run against a NON-PRODUCTION copy:
 *
 *   DATABASE_URL='postgresql://user:pass@127.0.0.1:5432/scratch_copy' \
 *     npx tsx scripts/audit-ib-hold-clearing.ts
 */
import "dotenv/config";
import process from "node:process";
import {
  auditCardAppliedCreditDoublePays,
  auditIbAppliedCreditStrands,
  auditIbHoldClearingUnderclears,
  formatCardAppliedCreditDoublePayReport,
  formatIbAppliedCreditStrandReport,
  formatIbHoldClearingAuditReport,
} from "../src/lib/ib-hold-clearing-audit";
import { prisma } from "../src/lib/prisma";

function printUsage() {
  console.log(`Usage:
  npx tsx scripts/audit-ib-hold-clearing.ts          # read-only audit (default)
  npx tsx scripts/audit-ib-hold-clearing.ts --json   # also emit machine-readable JSON

This audit is read-only. It never writes and never calls Xero/Stripe/SES. The
operator repairs any finding by hand (see docs/MAINTENANCE.md).

Options:
  --json          Emit machine-readable JSON alongside the human report.
  --help, -h      Show this help.
`);
}

function parseArgs(argv: string[]) {
  const options = { json: false };

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const result = await auditIbHoldClearingUnderclears();

  console.log(formatIbHoldClearingAuditReport(result));

  // #1620 — enumerate every Internet-Banking payment carrying applied credit
  // against a full invoice (realized double-pay vs pending exposure). Read-only.
  const strandResult = await auditIbAppliedCreditStrands();

  console.log("");
  console.log("=".repeat(70));
  console.log("");
  console.log(formatIbAppliedCreditStrandReport(strandResult));

  // #1641 — enumerate every captured CARD payment that also consumed applied
  // credit against a full-price charge (realized double-pay). Read-only.
  const cardDoublePayResult = await auditCardAppliedCreditDoublePays();

  console.log("");
  console.log("=".repeat(70));
  console.log("");
  console.log(formatCardAppliedCreditDoublePayReport(cardDoublePayResult));

  if (args.json) {
    console.log("");
    console.log("---BEGIN IB HOLD CLEARING AUDIT JSON---");
    console.log(JSON.stringify(result, null, 2));
    console.log("---END IB HOLD CLEARING AUDIT JSON---");
    console.log("");
    console.log("---BEGIN IB APPLIED-CREDIT STRAND JSON---");
    console.log(JSON.stringify(strandResult, null, 2));
    console.log("---END IB APPLIED-CREDIT STRAND JSON---");
    console.log("");
    console.log("---BEGIN CARD APPLIED-CREDIT DOUBLE-PAY JSON---");
    console.log(JSON.stringify(cardDoublePayResult, null, 2));
    console.log("---END CARD APPLIED-CREDIT DOUBLE-PAY JSON---");
  }
}

main()
  .catch((error) => {
    console.error(
      error instanceof Error
        ? error.message
        : "Unknown IB hold-clearing audit error",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
