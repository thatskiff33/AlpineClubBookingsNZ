/**
 * #4162 (owner decision 17 Oct 2026, `INV-ADDPAY-042`): READ-ONLY COUNT of
 * voided bank-transfer refund credit notes, sorted into the buckets the
 * nightly follow-up will act on, plus bank-transfer payments whose refunded
 * total is below their own transaction detail with no voided note.
 *
 * Run it BEFORE setting XERO_ENABLE_BANK_REFUND_VOID_WRITES=true:
 *
 *   pnpm run xero:bank-refund-void-count            # counts and amounts
 *   pnpm run xero:bank-refund-void-count --list     # also the link/payment ids
 *   pnpm run xero:bank-refund-void-count --json     # machine-readable
 *
 * It opens no transaction, takes no lock, writes nothing and makes no provider
 * call: one `$queryRaw` for the candidates and Prisma reads. Runbook:
 * docs/xero/ARCHITECTURE.md, "Voided bank-transfer refund notes (#4162)".
 */
import "dotenv/config";
import type { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { countBankRefundVoids, formatBankRefundVoidCount } from "../src/lib/bank-refund-void-count";

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("Usage: pnpm run xero:bank-refund-void-count [--list] [--json]");
    return;
  }
  const count = await countBankRefundVoids(prisma as unknown as Prisma.TransactionClient);
  console.log(argv.includes("--json") ? JSON.stringify(count, null, 2) : formatBankRefundVoidCount(count, { list: argv.includes("--list") }));
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
