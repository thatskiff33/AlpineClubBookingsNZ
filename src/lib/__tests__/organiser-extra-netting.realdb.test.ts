/** #4299: real money claims, with Xero represented only by inbound payloads. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { readOrganiserExtraState } from "@/lib/organiser-extra-state";
import { reserveOrganiserExtraCancellation, bindOrganiserExtraRefundToHandBack, releaseOrganiserExtraRefundNotes } from "@/lib/organiser-extra-netting";
import { readOrganiserExtraAdjustmentPayload } from "@/lib/organiser-extra-adjustment-payload";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const url = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const P = "race-4299-extra";
const memberId = `${P}-member`;
const organiserId = `${P}-organiser`;
const childId = `${P}-child`;
const modificationId = `${P}-modification`;
const invoiceId = `${P}-invoice`;
let prisma: (typeof import("@/lib/prisma"))["prisma"];
let syncCash: (typeof import("@/lib/organiser-extra-receipt"))["syncOrganiserExtraInvoiceCash"];
let reconcile: (typeof import("@/lib/payment-transactions"))["reconcilePaymentAggregates"];

(RUN ? describe : describe.skip)("organiser extra netting — real PostgreSQL", () => {
  async function cleanup() {
    await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [childId, modificationId] } } });
    await prisma.xeroObjectLink.deleteMany({ where: { localId: modificationId } });
    await prisma.manualRefundTask.deleteMany({ where: { bookingId: childId } });
    await prisma.bookingModification.deleteMany({ where: { bookingId: childId } });
    await prisma.payment.deleteMany({ where: { bookingId: childId } });
    await prisma.booking.deleteMany({ where: { id: childId } });
    await prisma.groupBookingSettlement.deleteMany({ where: { groupBookingId: `${P}-group` } });
    await prisma.groupBooking.deleteMany({ where: { id: `${P}-group` } });
    await prisma.booking.deleteMany({ where: { id: organiserId } });
    await prisma.member.deleteMany({ where: { id: memberId } });
    await prisma.lodge.deleteMany({ where: { id: `${P}-lodge` } });
  }
  beforeAll(async () => {
    assertSafeRaceDbUrl(url, "organiser extras");
    process.env.DATABASE_URL = url;
    ({ prisma } = await import("@/lib/prisma"));
    ({ syncOrganiserExtraInvoiceCash: syncCash } = await import("@/lib/organiser-extra-receipt"));
    ({ reconcilePaymentAggregates: reconcile } = await import("@/lib/payment-transactions"));
    await cleanup();
    await prisma.member.create({ data: { id: memberId, email: `${P}@example.invalid`, firstName: "Organiser", lastName: "Extra", passwordHash: "not-a-real-password", ageTier: "ADULT" } });
    await prisma.lodge.create({ data: { id: `${P}-lodge`, name: "Extra invoice proof", slug: P } });
    const stay = { memberId, lodgeId: `${P}-lodge`, checkIn: new Date("2026-08-01T00:00:00.000Z"), checkOut: new Date("2026-08-02T00:00:00.000Z"), totalPriceCents: 35_000, finalPriceCents: 35_000, status: "PAID" as const };
    await prisma.booking.create({ data: { ...stay, id: organiserId } });
    await prisma.groupBooking.create({ data: { id: `${P}-group`, organiserBookingId: organiserId, organiserMemberId: memberId, joinCode: P, paymentMode: "ORGANISER_PAYS" } });
    await prisma.groupBookingSettlement.create({ data: { id: `${P}-settlement`, groupBookingId: `${P}-group`, amountCents: 30_000, source: "INTERNET_BANKING", status: "SUCCEEDED", xeroInvoiceId: `${P}-combined` } });
    await prisma.booking.create({ data: { ...stay, id: childId, parentBookingId: organiserId, organiserSettled: true } });
    await prisma.payment.create({ data: { id: `${P}-payment`, bookingId: childId, amountCents: 30_000, changeFeeCents: 1_000, source: "INTERNET_BANKING", status: "SUCCEEDED" } });
    await prisma.bookingModification.create({ data: { id: modificationId, bookingId: childId, memberId, modificationType: "DATE_CHANGE", previousData: {}, newData: {}, priceDiffCents: 5_000, changeFeeCents: 1_000 } });
    await prisma.xeroObjectLink.create({ data: { localModel: "BookingModification", localId: modificationId, xeroObjectType: "INVOICE", xeroObjectId: invoiceId, role: "SUPPLEMENTARY_INVOICE", metadata: { organiserBilling: true, priceDiffCents: 5_000, changeFeeCents: 1_000 } } });
  });
  afterAll(async () => { if (prisma) await cleanup(); });

  it("imports partial cash exactly once, materialising original share so aggregate repair preserves 320", async () => {
    await Promise.all([
      syncCash({ invoiceID: invoiceId, amountPaid: 20, amountDue: 40, total: 60 }),
      syncCash({ invoiceID: invoiceId, amountPaid: 20, amountDue: 40, total: 60 }),
    ]);
    await reconcile({ paymentId: `${P}-payment` });
    const payment = await prisma.payment.findUniqueOrThrow({ where: { bookingId: childId }, include: { transactions: true } });
    expect(payment.amountCents).toBe(32_000);
    expect(payment.transactions.map((r) => [r.kind, r.amountCents]).sort()).toEqual([["ADDITIONAL", 2_000], ["PRIMARY", 30_000]]);
    const state = await readOrganiserExtraState(prisma, childId);
    expect(state.invoices[0]).toMatchObject({ cashCents: 2_000, priceCents: 5_000, feeCents: 1_000 });
    // The first sync loads the Xero inbound graph on demand: about 4.3s warm, over 5s cold.
  }, 60_000);
  it("rolls back every reserved invoice debt if the surrounding cancel fails", async () => {
    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await reserveOrganiserExtraCancellation(tx, { bookingId: childId, scopeId: "failed-cancel", refundAmountCents: 15_500, refundBasisCents: 31_000, refundPercentage: 50 });
      throw new Error("cancel failed");
    })).rejects.toThrow("cancel failed");
    expect(await prisma.xeroSyncOperation.count({ where: { localId: childId } })).toBe(0);
  });
  it("reserves waive40 and refund150+5 atomically, replay dedupes, completion releases only its refunds", async () => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await reserveOrganiserExtraCancellation(tx, { bookingId: childId, scopeId: "cancel", refundAmountCents: 15_500, refundBasisCents: 31_000, refundPercentage: 50 });
      const task = await tx.manualRefundTask.create({ data: { bookingId: childId, paymentId: `${P}-payment`, kind: "CANCELLED_BOOKING_HAND_BACK", amountCents: 15_500, raisedAmountCents: 15_500, reason: "Return to the organiser" } });
      await bindOrganiserExtraRefundToHandBack(tx, { bookingId: childId, scopeId: "cancel", handBackTaskId: task.id });
    });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await reserveOrganiserExtraCancellation(tx, { bookingId: childId, scopeId: "cancel", refundAmountCents: 15_500, refundBasisCents: 31_000, refundPercentage: 50 });
    });
    const rows = await prisma.xeroSyncOperation.findMany({ where: { localId: childId } });
    expect(rows).toHaveLength(3);
    const plans = rows.map((r) => ({ status: r.status, payload: readOrganiserExtraAdjustmentPayload(r.requestPayload)! }));
    expect(plans.filter((r) => r.payload.purpose === "waive").map((r) => [r.status, r.payload.amountCents])).toEqual([["PENDING", 4_000]]);
    expect(plans.filter((r) => r.payload.purpose === "refund").map((r) => [r.status, r.payload.amountCents]).sort()).toEqual([["WAITING_PAYMENT", 500], ["WAITING_PAYMENT", 15_000]].sort());
    const taskId = plans.find((r) => r.payload.purpose === "refund")!.payload.handBackTaskId!;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await tx.manualRefundTask.update({ where: { id: taskId }, data: { status: "COMPLETED" } });
      expect(await releaseOrganiserExtraRefundNotes(tx, taskId)).toBe(true);
    });
    expect(await prisma.xeroSyncOperation.count({ where: { localId: childId, status: "PENDING" } })).toBe(3);
    // The next reduction sees no unpaid amount and the paid extra refund spoken for.
    expect((await readOrganiserExtraState(prisma, childId)).invoices[0]).toMatchObject({ waivedCents: 4_000, refundedCents: 500 });
  });
});
