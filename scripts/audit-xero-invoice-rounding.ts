/**
 * Read-only operator audit for historical Xero invoice rounding drift (#1318).
 *
 * Replays the pre-#1231 (#1163) line maths over persisted booking/guest/night
 * data and flags issued invoices whose guest-line total would have drifted 1–2
 * cents. Scans BOTH per-booking invoices (Payment.xeroInvoiceId) and group
 * settlement invoices (GroupBookingSettlement.xeroInvoiceId). It makes ZERO
 * live-provider calls (no Xero, no Stripe), opens no transactions, and mutates
 * nothing — it only runs `booking.findMany` + `groupBookingSettlement.findMany`.
 *
 * SAFE USAGE — run against a NON-PRODUCTION copy of the database:
 *
 *   DATABASE_URL='postgresql://user:pass@127.0.0.1:5432/scratch_copy' \
 *     npm run xero:audit-invoice-rounding
 *
 * Exclude invoices issued after you deployed the #1231 fix (they are already
 * correct in Xero) with --issued-before:
 *
 *   ... npm run xero:audit-invoice-rounding -- --issued-before 2026-07-04
 *
 * A candidate is a LOCAL-data match only. Before treating one as a real error,
 * confirm in Xero that the invoice is still live (not voided/credited/
 * superseded). Remediation, if any, is a manual accounting correction.
 */
import "dotenv/config";
import { prisma } from "../src/lib/prisma";
import {
  formatRoundingAuditReport,
  scanXeroInvoiceRoundingDrift,
  type RoundingAuditPrismaClient,
} from "../src/lib/xero-invoice-rounding-audit";

function printUsage() {
  console.log(`Usage:
  DATABASE_URL=<non-prod copy> npm run xero:audit-invoice-rounding -- [options]

Options:
  --issued-before <YYYY-MM-DD>  Only scan invoices whose payment.createdAt is
                                before this date (set it to the date you
                                deployed the #1231 fix). Default: scan all.
  --batch-size <n>              Cursor page size (default 200).
  --limit <n>                   Stop after N candidate invoices (diagnostics).
  --json                        Emit machine-readable JSON alongside the report.
  --help, -h                    Show this help.
`);
}

function parseDateInput(value: string): Date {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new Error("--issued-before must use YYYY-MM-DD format.");
  }
  const parsed = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("--issued-before is not a valid date.");
  }
  return parsed;
}

function parseArgs(argv: string[]) {
  const options: {
    issuedBefore?: Date;
    batchSize?: number;
    limit?: number;
    json: boolean;
  } = { json: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--issued-before") {
      const next = argv[index + 1];
      if (!next) throw new Error("--issued-before requires a YYYY-MM-DD date.");
      options.issuedBefore = parseDateInput(next);
      index += 1;
      continue;
    }
    if (arg === "--batch-size") {
      const next = argv[index + 1];
      const parsed = Number(next);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error("--batch-size requires a positive integer.");
      }
      options.batchSize = parsed;
      index += 1;
      continue;
    }
    if (arg === "--limit") {
      const next = argv[index + 1];
      const parsed = Number(next);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error("--limit requires a positive integer.");
      }
      options.limit = parsed;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await scanXeroInvoiceRoundingDrift(
    prisma as unknown as RoundingAuditPrismaClient,
    {
      issuedBefore: args.issuedBefore ?? null,
      batchSize: args.batchSize,
      limit: args.limit,
    }
  );

  console.log(formatRoundingAuditReport(result));

  if (args.json) {
    console.log("");
    console.log("---BEGIN XERO ROUNDING AUDIT JSON---");
    console.log(JSON.stringify(result, null, 2));
    console.log("---END XERO ROUNDING AUDIT JSON---");
  }
}

main()
  .catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Unknown xero-rounding-audit error"
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
