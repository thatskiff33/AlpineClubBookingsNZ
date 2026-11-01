/**
 * #4531 (`INV-INT-031`): find, and with `--apply` retire, the active links of
 * payments Xero reports DELETED - mirrors the inbound reconcile could not
 * retire before #4531, because Xero leaves a deleted payment out of its
 * invoice and so it was never seen again.
 *
 * Report-only by default: it changes no link (its Xero calls still record usage
 * rows). Provider traffic is READ-ONLY: the dry run pages
 * `GET /Payments?where=Status=="DELETED"` (100 a page), and `--apply` adds one
 * `GET /Payments/{id}` per candidate payment it checks. With `--payment` it
 * asks Xero about just those ids (one call each) instead of listing, and that
 * answer is the confirmation. It retires only a payment Xero confirms DELETED,
 * writing the link inactive with its recorded status DELETED, and never
 * touches Xero. Runbook: docs/MAINTENANCE.md, "Retire links to payments
 * deleted in Xero (#4531)".
 *
 *   pnpm run xero:deleted-payment-link-backfill                       # dry run (changes no link)
 *   pnpm run xero:deleted-payment-link-backfill --apply               # retire every confirmed one
 *   pnpm run xero:deleted-payment-link-backfill --apply --payment <xero payment id> [--payment <id>...]
 */
import "dotenv/config";
import process from "node:process";
import { prisma } from "../src/lib/prisma";
import { getAuthenticatedXeroClient } from "../src/lib/xero-api-client";
import {
  applyDeletedPaymentLinkBackfill,
  findDeletedPaymentLinkBackfill,
  formatDeletedPaymentLinkBackfillApply,
  formatDeletedPaymentLinkBackfillReport,
} from "../src/lib/xero-deleted-payment-link-backfill";

function printUsage() {
  console.log(`Usage:
  pnpm run xero:deleted-payment-link-backfill                  # dry run (default, changes no link)
  pnpm run xero:deleted-payment-link-backfill --apply          # retire links of payments Xero confirms DELETED
  pnpm run xero:deleted-payment-link-backfill --payment <id>   # scope to Xero payment id(s) (repeatable)

Options:
  --apply          Retire the active links of every payment Xero confirms
                   DELETED (a listed one is asked about once more). Anything
                   else is left active and named.
  --payment <id>   Ask Xero about this payment id directly instead of listing;
                   repeat for several.
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
        throw new Error("--payment requires a Xero payment id");
      }
      options.paymentIds.push(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const session = await getAuthenticatedXeroClient();
  const scope = args.paymentIds.length > 0 ? { paymentIds: args.paymentIds } : undefined;

  if (!args.apply) {
    const report = await findDeletedPaymentLinkBackfill(session, scope);
    console.log("DRY RUN - no link was changed.\n");
    console.log(formatDeletedPaymentLinkBackfillReport(report));
    if (args.json) console.log("\n" + JSON.stringify(report, null, 2));
    return;
  }

  const result = await applyDeletedPaymentLinkBackfill(session, scope);
  console.log(formatDeletedPaymentLinkBackfillReport(result.report));
  console.log("\n" + formatDeletedPaymentLinkBackfillApply(result));
  if (args.json) console.log("\n" + JSON.stringify(result, null, 2));
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
