/**
 * Real-PostgreSQL proof for #4299 review findings F2 and N-e: the organiser's
 * cancel of an Internet Banking group, on a place whose extra invoice is part
 * paid, through the REAL `settleGroupBookingOnOrganiserCancel`.
 *
 *  - F2: the extra's cash gave the place's payment `PaymentTransaction` rows,
 *    so the cancel records its refund ON the rows. An aggregate reconcile
 *    afterwards keeps the refunded total (a mirror-only write was wiped by it).
 *  - The plan freezes the invoice debts with it (N1-N4): the unpaid $40 waived,
 *    the paid part refunded at 50% with the paid fee kept out, split $150 on the
 *    combined invoice and $5 on the extra, both bound to the organiser's
 *    hand-back - and no ordinary refund note beside them.
 *  - N-e: a plan an earlier run froze WITHOUT the debts (pre-#4299 code) is
 *    finished the old way on re-drive - one ordinary refund note, no debts.
 *
 *   RUN_CONCURRENCY_RACE_TESTS=1 \
 *   CONCURRENCY_RACE_DATABASE_URL=postgresql://user:pass@127.0.0.1:55442/concurrency_race_1881 \
 *   pnpm exec vitest run src/lib/__tests__/organiser-extra-group-cancel.realdb.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { readOrganiserExtraAdjustmentPayload } from "@/lib/organiser-extra-adjustment-payload";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const url = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const P = "race-4299-gc";
const memberId = `${P}-member`;
const lodgeId = `${P}-lodge`;
const organiserId = `${P}-organiser`;
const groupId = `${P}-group`;
const settlementId = `${P}-settlement`;
const childId = `${P}-child`;
const paymentId = `${P}-payment`;
const modificationId = `${P}-modification`;
const invoiceId = `${P}-invoice`;
const combinedInvoiceId = `${P}-combined`;

let prisma: (typeof import("@/lib/prisma"))["prisma"];
let syncCash: (typeof import("@/lib/organiser-extra-receipt"))["syncOrganiserExtraInvoiceCash"];
let reconcile: (typeof import("@/lib/payment-transactions"))["reconcilePaymentAggregates"];
let groupCancel: typeof import("@/lib/group-cancel");
let bookingCancel: typeof import("@/lib/booking-cancel");
let resolution: typeof import("@/lib/manual-refund-task-resolution");

(RUN ? describe : describe.skip)("organiser extra invoices in the organiser's group cancel - real PostgreSQL", { timeout: 60_000 }, () => {
  async function cleanup() {
    await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [childId, modificationId, paymentId, settlementId, organiserId] } } });
    await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: [modificationId, childId, paymentId] } } });
    await prisma.manualRefundTask.deleteMany({ where: { bookingId: { in: [childId, organiserId] } } });
    await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: { in: [childId, organiserId] } } });
    await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: { in: [childId, organiserId] } } });
    await prisma.bookingEvent.deleteMany({ where: { bookingId: { in: [childId, organiserId] } } });
    await prisma.auditLog.deleteMany({ where: { OR: [{ targetId: { in: [childId, organiserId] } }, { memberId }, { actorMemberId: memberId }, { subjectMemberId: memberId }] } });
    await prisma.hostingCoverageReevaluation.deleteMany({ where: { memberId } });
    await prisma.bookingModification.deleteMany({ where: { bookingId: childId } });
    await prisma.paymentTransaction.deleteMany({ where: { paymentId } });
    await prisma.payment.deleteMany({ where: { bookingId: childId } });
    await prisma.booking.deleteMany({ where: { id: childId } });
    await prisma.groupBookingSettlement.deleteMany({ where: { groupBookingId: groupId } });
    await prisma.groupBooking.deleteMany({ where: { id: groupId } });
    await prisma.booking.deleteMany({ where: { id: organiserId } });
    await prisma.cancellationPolicy.deleteMany({ where: { lodgeId } });
    await prisma.member.deleteMany({ where: { id: memberId } });
    await prisma.lodge.deleteMany({ where: { id: lodgeId } });
  }

  /** A $300 place on the paid combined invoice, and its $60 extra ($50 + $10 fee) with $20 paid. */
  async function seed(): Promise<void> {
    await cleanup();
    await prisma.member.create({ data: { id: memberId, email: `${P}@example.invalid`, firstName: "Organiser", lastName: "Cancel", passwordHash: "not-a-real-password", ageTier: "ADULT" } });
    await prisma.lodge.create({ data: { id: lodgeId, name: "Group cancel proof", slug: P } });
    await prisma.cancellationPolicy.create({ data: { lodgeId, daysBeforeStay: 0, refundPercentage: 50, creditRefundPercentage: 50 } });
    const stay = { memberId, lodgeId, checkIn: new Date("2026-08-01T00:00:00.000Z"), checkOut: new Date("2026-08-02T00:00:00.000Z"), status: "PAID" as const };
    await prisma.booking.create({ data: { ...stay, id: organiserId, totalPriceCents: 30_000, finalPriceCents: 30_000 } });
    await prisma.groupBooking.create({ data: { id: groupId, organiserBookingId: organiserId, organiserMemberId: memberId, joinCode: P, paymentMode: "ORGANISER_PAYS" } });
    await prisma.groupBookingSettlement.create({ data: { id: settlementId, groupBookingId: groupId, amountCents: 30_000, source: "INTERNET_BANKING", status: "SUCCEEDED", xeroInvoiceId: combinedInvoiceId } });
    await prisma.booking.create({ data: { ...stay, id: childId, parentBookingId: organiserId, organiserSettled: true, totalPriceCents: 35_000, finalPriceCents: 35_000 } });
    await prisma.payment.create({ data: { id: paymentId, bookingId: childId, amountCents: 30_000, changeFeeCents: 1_000, source: "INTERNET_BANKING", status: "SUCCEEDED" } });
    await prisma.bookingModification.create({ data: { id: modificationId, bookingId: childId, memberId, modificationType: "DATE_CHANGE", previousData: {}, newData: {}, priceDiffCents: 5_000, changeFeeCents: 1_000 } });
    await prisma.xeroObjectLink.create({ data: { localModel: "BookingModification", localId: modificationId, xeroObjectType: "INVOICE", xeroObjectId: invoiceId, role: "SUPPLEMENTARY_INVOICE", metadata: { organiserBilling: true, priceDiffCents: 5_000, changeFeeCents: 1_000 } } });
    await syncCash({ invoiceID: invoiceId, amountPaid: 20, amountDue: 40, total: 60 });
  }

  async function plans() {
    const rows = await prisma.xeroSyncOperation.findMany({ where: { localId: childId } });
    return rows.map((row) => ({ status: row.status, payload: readOrganiserExtraAdjustmentPayload(row.requestPayload) })).filter((row) => row.payload !== null);
  }

  beforeAll(async () => {
    assertSafeRaceDbUrl(url, "organiser extra group cancel");
    process.env.DATABASE_URL = url;
    ({ prisma } = await import("@/lib/prisma"));
    ({ syncOrganiserExtraInvoiceCash: syncCash } = await import("@/lib/organiser-extra-receipt"));
    ({ reconcilePaymentAggregates: reconcile } = await import("@/lib/payment-transactions"));
    groupCancel = await import("@/lib/group-cancel");
    bookingCancel = await import("@/lib/booking-cancel");
    resolution = await import("@/lib/manual-refund-task-resolution");
  }, 60_000);
  beforeEach(seed, 60_000);
  afterAll(async () => { if (prisma) await cleanup(); });

  it("F2: records the refund on the payment's rows, so a reconcile keeps it; freezes the debts with the plan, bound to the hand-back", async () => {
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).amountCents).toBe(32_000);
    await groupCancel.settleGroupBookingOnOrganiserCancel(organiserId, memberId, "127.0.0.1", CLUB_FORMAT_TEST);

    // 50% of the $320 paid less the $10 fee the part payment settled first.
    const settlement = await prisma.groupBookingSettlement.findUniqueOrThrow({ where: { id: settlementId } });
    expect(settlement.refundPlan).toEqual({ [childId]: 15_500 });
    const recorded = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(recorded.refundedAmountCents).toBe(15_500);
    await reconcile({ paymentId });
    const reconciled = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId }, include: { transactions: true } });
    expect(reconciled.refundedAmountCents).toBe(15_500);
    expect(reconciled.status).toBe("PARTIALLY_REFUNDED");
    expect(reconciled.transactions.reduce((sum, row) => sum + row.refundedAmountCents, 0)).toBe(15_500);

    const task = await prisma.manualRefundTask.findFirstOrThrow({ where: { bookingId: organiserId } });
    const debts = await plans();
    expect(debts.filter((row) => row.payload!.purpose === "waive").map((row) => [row.status, row.payload!.amountCents])).toEqual([["PENDING", 4_000]]);
    expect(debts.filter((row) => row.payload!.purpose === "refund").map((row) => [row.status, row.payload!.amountCents, row.payload!.handBackTaskId]).sort())
      .toEqual([["WAITING_PAYMENT", 15_000, task.id], ["WAITING_PAYMENT", 500, task.id]].sort());
    // The debts carry the Xero side: no ordinary refund note beside them.
    expect(await prisma.xeroSyncOperation.count({ where: { localId: paymentId, queueType: "REFUND_CREDIT_NOTE" } })).toBe(0);
  });

  /** The officer marks the organiser's hand-back paid, through the real resolver. */
  async function completeHandBack(task: { id: string; amountCents: number | null }) {
    await resolution.resolveManualRefundTask({
      taskId: task.id, resolution: "completed", note: null, actingMemberId: memberId, confirmedAmountCents: task.amountCents, direction: null, recordedNightPrices: null,
    }, CLUB_FORMAT_TEST);
  }

  it("completing the group cancel's hand-back releases exactly its bound refunds", async () => {
    await groupCancel.settleGroupBookingOnOrganiserCancel(organiserId, memberId, "127.0.0.1", CLUB_FORMAT_TEST);
    const task = await prisma.manualRefundTask.findFirstOrThrow({ where: { bookingId: organiserId } });
    await completeHandBack(task);
    const debts = await plans();
    expect(debts.filter((row) => row.payload!.purpose === "refund").map((row) => row.status)).toEqual(["PENDING", "PENDING"]);
    expect(await prisma.xeroSyncOperation.count({ where: { localId: paymentId, queueType: "REFUND_CREDIT_NOTE" } })).toBe(0);
  });

  it("booking cancel: the joiner's own cancel reserves the debts, binds its refunds to its hand-back, and completion releases them", async () => {
    await bookingCancel.cancelBooking(childId, memberId, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, "card");
    const task = await prisma.manualRefundTask.findFirstOrThrow({ where: { bookingId: childId } });
    // The same 50% of $320 less the $10 fee paid first, by bank transfer to the organiser.
    expect(task.amountCents).toBe(15_500);
    const debts = await plans();
    expect(debts.filter((row) => row.payload!.purpose === "waive").map((row) => [row.status, row.payload!.amountCents])).toEqual([["PENDING", 4_000]]);
    expect(debts.filter((row) => row.payload!.purpose === "refund").map((row) => [row.status, row.payload!.amountCents, row.payload!.handBackTaskId]).sort())
      .toEqual([["WAITING_PAYMENT", 15_000, task.id], ["WAITING_PAYMENT", 500, task.id]].sort());
    await completeHandBack(task);
    expect((await plans()).filter((row) => row.payload!.purpose === "refund").map((row) => row.status)).toEqual(["PENDING", "PENDING"]);
    expect(await prisma.xeroSyncOperation.count({ where: { localId: paymentId, queueType: "REFUND_CREDIT_NOTE" } })).toBe(0);
  });

  it("a completed hand-back whose child mirror names an invoice still takes no second refund note beside its released ones", async () => {
    // A child payment that carries an invoice id (legacy data): the cancellation
    // hand-back's own note would be queued for it, on top of the reserved ones.
    await prisma.payment.update({ where: { id: paymentId }, data: { xeroInvoiceId: combinedInvoiceId } });
    await bookingCancel.cancelBooking(childId, memberId, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, "card");
    const task = await prisma.manualRefundTask.findFirstOrThrow({ where: { bookingId: childId } });
    const notesBefore = await prisma.xeroSyncOperation.count({ where: { localId: paymentId, queueType: "REFUND_CREDIT_NOTE" } });
    await completeHandBack(task);
    expect((await plans()).filter((row) => row.payload!.purpose === "refund").map((row) => row.status)).toEqual(["PENDING", "PENDING"]);
    expect(await prisma.xeroSyncOperation.count({ where: { localId: paymentId, queueType: "REFUND_CREDIT_NOTE" } })).toBe(notesBefore);
  });

  it("N-e: a plan frozen without the debts by an earlier run is finished the old way - one refund note, no debts", async () => {
    await prisma.groupBookingSettlement.update({ where: { id: settlementId }, data: { refundPlan: { [childId]: 15_500 } } });
    await groupCancel.settleGroupBookingOnOrganiserCancel(organiserId, memberId, "127.0.0.1", CLUB_FORMAT_TEST);

    expect(await plans()).toEqual([]);
    expect(await prisma.xeroSyncOperation.count({ where: { localId: paymentId, queueType: "REFUND_CREDIT_NOTE" } })).toBe(1);
    await reconcile({ paymentId });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).refundedAmountCents).toBe(15_500);
  });
});
