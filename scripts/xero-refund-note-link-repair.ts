/**
 * Operator repair for Stripe per-delta refund credit-note links damaged by the
 * pre-#2901 canonical cleanup (and for the local aftermath of voiding the
 * Xero-side duplicate notes the resulting loop created). The same dry run is
 * also the #2902 operator report: it lists payments whose refund-note coverage
 * exceeds their provider-backed cash refunds — the fictitious notes (with
 * Stripe-bank refund payments) that account-credit cancellations used to mint.
 *
 * It never voids or deletes a Xero document — Xero-side duplicates are voided
 * by the operator in Xero (runbook: docs/xero/ARCHITECTURE.md → "Repairing
 * Stripe refund-note links (#2901)"). The only provider traffic is READ-ONLY
 * status fetches (`--record-statuses`, and automatically before `--apply`),
 * because a note whose live status was never recorded locally is never
 * reactivated. Coverage targets are the provider-backed CASH refund evidence
 * (#2902, INV-PAY-050: succeeded PaymentRefund cents, with the pre-ledger
 * legacy fallback — never the raw refundedAmountCents mirror, which also
 * counts account-credit dispositions).
 *
 * Dry run by default. SAFE USAGE — review the dry-run report first, keep its
 * output with the change record, then apply exactly the reviewed payments:
 *
 *   npm run xero:refund-note-link-repair                        # dry run (writes nothing)
 *   npm run xero:refund-note-link-repair -- --record-statuses   # fetch + record live note statuses, then dry run
 *   npm run xero:refund-note-link-repair -- --apply --payment <id> [--payment <id>...]
 */
import "dotenv/config";
import process from "node:process";
import {
  applyStripeRefundNoteLinkRepairs,
  findStripeRefundNoteLinkRepairs,
  formatStripeRefundNoteLinkRepairReport,
} from "../src/lib/xero-refund-note-link-repair";
import {
  formatStripeRefundNoteStatusRecordResult,
  recordStripeRefundNoteLinkStatuses,
} from "../src/lib/xero-refund-note-status-recorder";
import { prisma } from "../src/lib/prisma";

function printUsage() {
  console.log(`Usage:
  npm run xero:refund-note-link-repair                        # dry run (default, writes nothing)
  npm run xero:refund-note-link-repair -- --dry-run           # explicit dry run
  npm run xero:refund-note-link-repair -- --record-statuses   # fetch live note statuses from Xero (read-only
                                                              # at the provider), record them on the local
                                                              # links, then print the refreshed dry-run report
  npm run xero:refund-note-link-repair -- --payment <id>      # scope to payment id(s) (repeatable)
  npm run xero:refund-note-link-repair -- --apply --payment <id> [--payment <id>...]

Options:
  --apply             Apply the reviewed plans, each payment in its own
                      transaction. REQUIRES at least one --payment id from the
                      dry-run report you reviewed: apply is bound to what was
                      reviewed, never to a fresh unscoped scan. Live statuses
                      are re-recorded first (see --skip-status-check).
  --record-statuses   Fetch each linked credit note from Xero (GET only) and
                      merge its live status onto the local links, so voided
                      notes can never be reactivated and live ones become
                      eligible. Writes link metadata only (a mirror of a note
                      reported VOIDED/DELETED lands inactive, exactly as the
                      inbound webhook would record it).
  --skip-status-check With --apply: skip the pre-apply status recording. Use
                      ONLY when Xero is unreachable and statuses were recorded
                      moments ago; unknown-status links are never reactivated
                      either way.
  --payment <id>      Restrict to one payment id; repeat for several.
  --json              Emit machine-readable JSON alongside the report.
  --help, -h          Show this help.
`);
}

function parseArgs(argv: string[]) {
  const options = {
    apply: false,
    json: false,
    recordStatuses: false,
    skipStatusCheck: false,
    paymentIds: [] as string[],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.apply = false;
      continue;
    }
    if (arg === "--record-statuses") {
      options.recordStatuses = true;
      continue;
    }
    if (arg === "--skip-status-check") {
      options.skipStatusCheck = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--payment") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--payment requires a payment id");
      }
      options.paymentIds.push(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.apply && options.paymentIds.length === 0) {
    throw new Error(
      "--apply requires the reviewed payment ids: pass --payment <id> for each payment from the dry-run report you reviewed. An unscoped apply could write plans no human has seen."
    );
  }

  return options;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scope =
    args.paymentIds.length > 0 ? { paymentIds: args.paymentIds } : undefined;

  if (args.recordStatuses || (args.apply && !args.skipStatusCheck)) {
    const recorded = await recordStripeRefundNoteLinkStatuses(scope);
    console.log(formatStripeRefundNoteStatusRecordResult(recorded));
    console.log("");
  }

  if (!args.apply) {
    const report = await findStripeRefundNoteLinkRepairs(scope);
    console.log("DRY RUN — no repair was applied.");
    console.log("");
    console.log(formatStripeRefundNoteLinkRepairReport(report));
    if (args.json) {
      console.log("\n" + JSON.stringify(report, null, 2));
    }
    return;
  }

  const result = await applyStripeRefundNoteLinkRepairs(scope);
  console.log(formatStripeRefundNoteLinkRepairReport(result.report));
  console.log(
    `\nApplied ${result.appliedPayments} payment(s): reactivated ${result.reactivatedLinks} link(s), deactivated ${result.deactivatedLinks} cancelled-note link(s).`
  );
  for (const skipped of result.skippedPayments) {
    console.log(`Skipped ${skipped.paymentId}: ${skipped.reason}`);
  }
  if (args.json) {
    console.log("\n" + JSON.stringify(result, null, 2));
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
