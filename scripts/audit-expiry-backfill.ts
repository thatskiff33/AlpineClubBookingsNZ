/**
 * Give older audit entries with no retention class and no expiry the
 * seven-year expiry new entries get, counted from the day each was recorded
 * (#5265, owner decision 20 Nov 2026). The owner runs this. An agent does not,
 * and it is never pointed at production from a lane.
 *
 * Read the census, then the dry run, then apply with the two numbers the dry
 * run prints. Some entries may already be past seven years: the next nightly
 * clean-up deletes those for good, which is why apply asks for that count.
 * Only `expiresAt` is written. A second `--apply` changes nothing. There is no
 * migration and nothing runs at deploy.
 *
 * Under the least-privilege roles neither the application nor the
 * audit-retention connection may change an expiry; name the operator
 * connection in DATABASE_URL for apply.
 *
 *   DATABASE_URL='postgresql://user:pass@127.0.0.1:5432/tacbookings' \
 *     pnpm run audit:expiry-backfill
 *
 *   DATABASE_URL=... pnpm run audit:expiry-backfill -- --dry-run
 *
 *   DATABASE_URL=... pnpm run audit:expiry-backfill -- --apply --actor <memberId> \
 *     --confirm-total <n> [--allow-delete <n>]
 */
import "dotenv/config";
import process from "node:process";

import {
  formatAuditExpiryBackfillReport,
  runAuditExpiryBackfill,
  type AuditExpiryBackfillMode,
} from "../src/lib/audit-expiry-backfill";
import { prisma } from "../src/lib/prisma";

function printUsage() {
  console.log(`Usage:
  pnpm run audit:expiry-backfill                     # census (default): counts by kind, no writes
  pnpm run audit:expiry-backfill -- --dry-run        # the census plus the batch plan and the exact apply command
  pnpm run audit:expiry-backfill -- --apply --actor <id> --confirm-total <n> [--allow-delete <n>]

Options:
  --census              Read-only counts. This is the default.
  --dry-run             Read-only; prints the apply command for exactly what it read.
  --apply               Set the seven-year expiry. Requires --actor and --confirm-total.
  --actor <id>          The member recorded as having done the apply.
  --confirm-total <n>   The live total the dry run printed. Apply refuses any other number.
  --allow-delete <n>    Required when some entries are already past seven years: the number
                        the next nightly clean-up would delete. Apply refuses any other number.
  --batch-size <n>      Entries per transaction (default 500).
  --json                Print the report as JSON after the text.
  --help, -h            Show this help.

Name DATABASE_URL yourself. Apply needs the operator connection under split roles.
`);
}

function wholeNumber(flag: string, value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) throw new Error(`${flag} needs a whole number`);
  return Number(value);
}

function parseArgs(argv: string[]) {
  const options: {
    mode: AuditExpiryBackfillMode;
    json: boolean;
    actor: string | null;
    confirmTotal: number | null;
    allowDelete: number | null;
    batchSize: number | undefined;
  } = { mode: "census", json: false, actor: null, confirmTotal: null, allowDelete: null, batchSize: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    switch (arg) {
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      case "--census":
        options.mode = "census";
        break;
      case "--dry-run":
        options.mode = "dry-run";
        break;
      case "--apply":
        options.mode = "apply";
        break;
      case "--json":
        options.json = true;
        break;
      case "--actor":
        if (!next || next.startsWith("--")) throw new Error("--actor needs a member id");
        options.actor = next;
        i += 1;
        break;
      case "--confirm-total":
        options.confirmTotal = wholeNumber(arg, next);
        i += 1;
        break;
      case "--allow-delete":
        options.allowDelete = wholeNumber(arg, next);
        i += 1;
        break;
      case "--batch-size":
        options.batchSize = wholeNumber(arg, next);
        i += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

async function main() {
  // pnpm 11 passes the `--` in `pnpm run audit:expiry-backfill -- --apply` through.
  const args = parseArgs(process.argv.slice(2).filter((arg) => arg !== "--"));
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set. Name the database this run should read.");
  }
  const report = await runAuditExpiryBackfill({
    mode: args.mode,
    db: prisma,
    actorMemberId: args.actor,
    confirmTotal: args.confirmTotal,
    allowDelete: args.allowDelete,
    batchSize: args.batchSize,
  });
  console.log(`Mode: ${report.mode}`);
  console.log(formatAuditExpiryBackfillReport(report));
  if (args.json) {
    console.log("");
    console.log("---BEGIN AUDIT EXPIRY BACKFILL JSON---");
    console.log(JSON.stringify(report, null, 2));
    console.log("---END AUDIT EXPIRY BACKFILL JSON---");
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "Unknown audit expiry backfill error");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
