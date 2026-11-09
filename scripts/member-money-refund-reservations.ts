/**
 * Owner-run M4c refund reservations command (#4516; plan section 8, the rollback rules). Default: a read-only census
 * of every population payment's card refund journal. `--reconcile` answers (or releases, REFUSED) the reservations a
 * recovery row marks made by an exact refund on record, through the one cash writer: the reconciliation a redeploy
 * after a rollback across M4c runs. `--release <reservationId> --note "<why>"` releases one reservation nothing can
 * answer (OPERATOR), with its funding, and audits it. No provider call; nothing is matched by amount or time.
 */
import { Prisma } from "@prisma/client";
import { createAuditLog } from "../src/lib/audit";
import { readBookingRefundCensus, reconcileMadeRefundReservations, receiptPopulationPaymentIds, releaseReservationByOperator } from "../src/lib/member-money";
import { isBookingJournalInactive, resolveBookingMoneyPostingContext } from "../src/lib/member-money/doors";
import { prisma } from "../src/lib/prisma";

const USAGE = "member-money:refund-reservations [--dry-run | --reconcile | --release <reservationId> --note \"<why>\"]";

async function census(paymentIds: readonly string[]) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const findings = [];
    for (const id of paymentIds) findings.push(...await readBookingRefundCensus(tx, id));
    return findings;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 60_000 });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) { console.log(USAGE); return; }
  const release = args.indexOf("--release");
  const note = args.indexOf("--note");
  const reconcile = args.includes("--reconcile");
  const known = new Set(["--dry-run", "--reconcile", "--release", "--note"]);
  const values = new Set([release + 1, note + 1].filter((index) => index > 0));
  if (args.some((arg, index) => !known.has(arg) && !values.has(index)) || (release >= 0 && (reconcile || args.includes("--dry-run")))
    || (reconcile && args.includes("--dry-run"))) throw new Error(`Choose one mode. ${USAGE}`);
  const context = await resolveBookingMoneyPostingContext();
  if (isBookingJournalInactive(context)) throw new Error("Member-money journal is inactive; nothing to reconcile or release.");

  if (release >= 0) {
    const reservationId = args[release + 1];
    const why = note >= 0 ? args[note + 1]?.trim() : "";
    if (!reservationId || !why) throw new Error(`--release needs a reservation id and a --note saying why. ${USAGE}`);
    const released = await prisma.$transaction(async (tx) => {
      const result = await releaseReservationByOperator(tx, context, { reservationId });
      await createAuditLog({ category: "payment", action: "booking-payment.card-refund.reservation-released-by-operator", targetId: result.bookingId,
        entityType: "MemberMoneyRefundReservation", entityId: reservationId, severity: "critical", outcome: "success",
        summary: "An owner released a card refund reservation nothing could answer; its funding was reversed.", details: why,
        metadata: { attemptKey: result.attemptKey, amountCents: result.amountCents } }, tx);
      return result;
    });
    console.log(JSON.stringify({ mode: "release", reservationId, ...released }, null, 2));
    return;
  }

  const paymentIds = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    return receiptPopulationPaymentIds(tx);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 60_000 });
  let posted = 0;
  if (reconcile) for (const paymentId of paymentIds) {
    posted += await prisma.$transaction((tx) => reconcileMadeRefundReservations(tx, context, paymentId), { timeout: 30_000 });
  }
  const findings = await census(paymentIds);
  console.log(JSON.stringify({ mode: reconcile ? "reconcile" : "dry-run", payments: paymentIds.length, posted, findings }, null, 2));
  if (findings.some((f) => f.kind === "STRANDED_RESERVATION" || f.kind === "ANSWERABLE_RESERVATION")) process.exitCode = 2;
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Refund reservations command failed");
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
