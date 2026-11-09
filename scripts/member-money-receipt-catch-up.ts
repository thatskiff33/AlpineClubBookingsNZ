/** Owner-run M4b receipt catch-up. Default: a read-only census; --execute posts missing receipts unapplied. */
import { Prisma } from "@prisma/client";
import { postBookingReceipts, readBookingReceiptCensus, receiptPopulationPaymentIds } from "../src/lib/member-money";
import { resolveBookingMoneyPostingContext, isBookingJournalInactive } from "../src/lib/member-money/doors";
import { prisma } from "../src/lib/prisma";

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) { console.log("member-money:receipt-catch-up [--dry-run | --execute]\nDefault: read-only census. Execute: missing receipts and exact reversals only, no applications or provider calls."); return; }
  if (args.some((arg) => !["--execute", "--dry-run"].includes(arg)) || args.includes("--execute") && args.includes("--dry-run")) throw new Error("Choose --dry-run or --execute.");
  const context = await resolveBookingMoneyPostingContext();
  if (isBookingJournalInactive(context)) throw new Error("Member-money journal is inactive; no receipt catch-up can run.");
  const execute = args.includes("--execute");
  const paymentIds = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    return receiptPopulationPaymentIds(tx);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 60_000 });
  let posted = 0;
  if (execute) for (const paymentId of paymentIds) {
    posted += await prisma.$transaction((tx) => postBookingReceipts(tx, context, { paymentId }));
  }
  const findings = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const findings = [];
    for (const id of paymentIds) findings.push(...await readBookingReceiptCensus(tx, id));
    return findings;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 60_000 });
  console.log(JSON.stringify({ mode: execute ? "execute" : "dry-run", payments: paymentIds.length, posted, findings }, null, 2));
  if (findings.some((f) => f.kind === "RECEIPT_WITHOUT_EVENT")) process.exitCode = 2;
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Receipt catch-up failed");
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
