/**
 * #4712: find, and with `--apply` retire, the ACCOUNT_CREDIT_NOTE links the
 * inbound credit-note reconcile wrote on payments whose booking an applied
 * credit was spent on (#1925's local provenance, before #4712). No Xero call.
 *
 * Dry run by default. SAFE USAGE - review the dry-run report, keep it with the
 * change record, then apply exactly the reviewed payments:
 *
 *   pnpm run xero:applied-credit-account-note-link-repair                  # dry run (writes nothing)
 *   pnpm run xero:applied-credit-account-note-link-repair --apply --payment <id> [--payment <id>...]
 *
 * Runbook: docs/MAINTENANCE.md, "Retire account-credit note links written on
 * bookings a credit was applied to (#4712)".
 */
import "dotenv/config";
import process from "node:process";
import { prisma } from "../src/lib/prisma";
import {
  applyStaleAppliedCreditAccountNoteLinkRepair,
  findStaleAppliedCreditAccountNoteLinks,
  formatAppliedCreditAccountNoteLinkApply,
  formatAppliedCreditAccountNoteLinkReport,
} from "../src/lib/xero-applied-credit-account-note-link-repair";

function printUsage() {
  console.log(`Usage:
  pnpm run xero:applied-credit-account-note-link-repair                 # dry run (default, writes nothing)
  pnpm run xero:applied-credit-account-note-link-repair --payment <id>  # scope to payment id(s) (repeatable)
  pnpm run xero:applied-credit-account-note-link-repair --apply --payment <id> [--payment <id>...]

Options:
  --apply          Retire the stale links of the named payments, each classified
                   again first, and recount each payment's refunded total.
                   REQUIRES at least one --payment id from the dry-run report.
  --payment <id>   Restrict to one payment id; repeat for several.
  --json           Emit machine-readable JSON after the report.
  --help, -h       Show this help.
`);
}

function parseArgs(argv: string[]) {
  const options = { apply: false, json: false, paymentIds: [] as string[] };
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
    throw new Error("--apply requires the reviewed payment ids: pass --payment <id> for each payment from the dry-run report you reviewed.");
  }
  return options;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scope = args.paymentIds.length > 0 ? { paymentIds: args.paymentIds } : undefined;

  if (!args.apply) {
    const report = await findStaleAppliedCreditAccountNoteLinks(scope);
    console.log("DRY RUN - no link was changed.\n");
    console.log(formatAppliedCreditAccountNoteLinkReport(report));
    if (args.json) console.log("\n" + JSON.stringify(report, null, 2));
    return;
  }

  const result = await applyStaleAppliedCreditAccountNoteLinkRepair(args.paymentIds);
  console.log(formatAppliedCreditAccountNoteLinkApply(result));
  if (args.json) console.log("\n" + JSON.stringify(result, null, 2));
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
