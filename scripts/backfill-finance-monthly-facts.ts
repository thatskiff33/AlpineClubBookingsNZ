/**
 * One-off (re-runnable) historical backfill of the finance monthly fact
 * table (FinanceAccountMonthlyBalance) from Xero. Walks backwards from the
 * current month in 12-month report chunks until organisation pre-history or
 * the --from-month bound. Safe to re-run: each chunk replaces its own months.
 *
 * Requires DATABASE_URL and a connected operational Xero token. Run against
 * the Xero demo tenant before production.
 */
import "dotenv/config";
import process from "node:process";
import {
  backfillFinanceMonthlyFacts,
  DEFAULT_FINANCE_BACKFILL_MAX_CHUNKS,
} from "../src/lib/finance-monthly-fact-backfill";
import { isMonthKey } from "../src/lib/finance-monthly-facts";
import { prisma } from "../src/lib/prisma";

function printUsage() {
  console.log(`Usage:
  npm run finance:backfill-monthly-facts
  npm run finance:backfill-monthly-facts -- --from-month 2020-04
  npm run finance:backfill-monthly-facts -- --max-chunks 5

Options:
  --from-month <YYYY-MM>  Stop after the chunk containing this month
                          (default: walk back to org pre-history).
  --max-chunks <n>        Cap on 12-month chunks per report
                          (default: ${DEFAULT_FINANCE_BACKFILL_MAX_CHUNKS}).
  --help                  Show this help.
`);
}

function parseArgs(argv: string[]): {
  fromMonth: string | null;
  maxChunks: number | undefined;
} {
  let fromMonth: string | null = null;
  let maxChunks: number | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--from-month") {
      const value = argv[index + 1]?.trim();
      if (!value || !isMonthKey(value)) {
        throw new Error("--from-month requires a YYYY-MM value");
      }
      fromMonth = value;
      index += 1;
      continue;
    }

    if (arg === "--max-chunks") {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error("--max-chunks requires a positive integer");
      }
      maxChunks = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { fromMonth, maxChunks };
}

async function main() {
  const { fromMonth, maxChunks } = parseArgs(process.argv.slice(2));

  console.log(
    `Backfilling finance monthly facts${fromMonth ? ` back to ${fromMonth}` : " to org pre-history"}...`
  );

  const execution = await backfillFinanceMonthlyFacts({
    fromMonth,
    maxChunks,
    metadata: { initiatedFrom: "scripts/backfill-finance-monthly-facts.ts" },
  });

  console.log(`Run ${execution.runId} finished with status ${execution.status}`);
  for (const dataset of execution.datasetResults) {
    const facts =
      dataset.factRowCount !== undefined
        ? `, factRows=${dataset.factRowCount}, unresolved=${dataset.unresolvedFactRowCount ?? 0}`
        : "";
    const failure = dataset.errorMessage ? `, error=${dataset.errorMessage}` : "";
    console.log(
      `  ${dataset.datasetKey}: snapshots=${dataset.snapshotCount}${facts}${failure}`
    );
  }

  if (execution.status === "FAILED") {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
