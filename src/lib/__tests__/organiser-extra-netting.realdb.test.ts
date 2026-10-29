/** #4299: real money claims, with Xero represented only by inbound payloads. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Invoice } from "xero-node";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { readOrganiserExtraState } from "@/lib/organiser-extra-state";
import { reserveOrganiserExtraCancellation, bindOrganiserExtraRefundToHandBack, releaseOrganiserExtraRefundNotes } from "@/lib/organiser-extra-netting";
import { readOrganiserExtraAdjustmentPayload } from "@/lib/organiser-extra-adjustment-payload";

// Xero is only the extra invoices' live figures: what each one shows as paid.
const xero = vi.hoisted(() => ({ paidCents: {} as Record<string, number>, cashImported: false }));
// The raced-cash case imports the cash itself first, so the waivers' first global lock is the reservation's.
vi.mock("@/lib/organiser-extra-receipt", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/organiser-extra-receipt");
  return { ...actual, syncOrganiserExtraInvoiceCash: async (invoice: Invoice) => (xero.cashImported ? undefined : actual.syncOrganiserExtraInvoiceCash(invoice)) };
});
vi.mock("@/lib/xero-api-client", () => ({
  getAuthenticatedXeroClient: vi.fn(async () => ({ tenantId: "fake-tenant", xero: { accountingApi: {
    getInvoice: vi.fn(async (_tenant: string, invoiceID: string) => {
      const paid = (xero.paidCents[invoiceID] ?? 0) / 100;
      return { body: { invoices: [{ invoiceID, invoiceNumber: invoiceID, contact: { contactID: "organiser" }, amountPaid: paid, amountDue: 0, total: paid, status: "PAID" } as Invoice] } };
    }),
  } } })),
  callXeroApi: vi.fn(async (call: () => Promise<unknown>) => call()),
}));

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
  it("N-d / N2: a reversal of cash already partly refunded raises one treasurer task and blocks nothing", async () => {
    // F2 records a refund on the combined share's row first, so the extra's own receipt shows none
    // refunded: the $5 refund of its paid price is read from the netting's plans (released above).
    const extra = await prisma.paymentTransaction.findFirstOrThrow({ where: { paymentId: `${P}-payment`, kind: "ADDITIONAL", status: "SUCCEEDED" } });
    expect(extra.refundedAmountCents).toBe(0);
    const before = await prisma.payment.findUniqueOrThrow({ where: { bookingId: childId } });
    // Xero now shows the $20 reversed. Neither the inbound event nor a re-delivery throws.
    await syncCash({ invoiceID: invoiceId, invoiceNumber: "EXTRA-1", amountPaid: 0, amountDue: 60, total: 60 });
    await syncCash({ invoiceID: invoiceId, invoiceNumber: "EXTRA-1", amountPaid: 0, amountDue: 60, total: 60 });
    // N6: on the Booking, so the booking's page lists it; once, however often the event arrives.
    const reviews = await prisma.xeroSyncOperation.findMany({ where: { localModel: "Booking", localId: childId, entityType: "REVIEW" } });
    expect(reviews.map((row) => [row.operationType, row.status, row.replayable])).toEqual([["ORGANISER_EXTRA_CASH_REVERSED", "FAILED", false]]);
    expect(reviews[0]!.requestPayload).toMatchObject({ modificationId });
    expect(reviews[0]!.lastErrorMessage).toContain("EXTRA-1");
    // Nothing recorded as paid changed: the treasurer reconciles it in Xero.
    expect((await prisma.paymentTransaction.findUniqueOrThrow({ where: { id: extra.id } })).status).toBe("SUCCEEDED");
    expect((await prisma.payment.findUniqueOrThrow({ where: { bookingId: childId } })).amountCents).toBe(before.amountCents);
  });
});

/**
 * #4299 N1 (fix delta): raced cash is reserved once per PLAN, under the real
 * global money lock, however the plan's waivers interleave.
 */
(RUN ? describe : describe.skip)("organiser extra raced cash, one plan's waivers - real PostgreSQL", () => {
  const R = "race-4299-raced";
  const ids = ["a", "b"] as const;
  const booking = `${R}-child`;
  let execute: (typeof import("@/lib/organiser-extra-adjustment"))["executeOrganiserExtraAdjustment"];
  async function cleanup() {
    await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [booking, ...ids.map((id) => `${R}-mod-${id}`)] } } });
    await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: ids.map((id) => `${R}-mod-${id}`) } } });
    await prisma.manualRefundTask.deleteMany({ where: { bookingId: booking } });
    await prisma.paymentTransaction.deleteMany({ where: { payment: { bookingId: booking } } });
    await prisma.bookingModification.deleteMany({ where: { bookingId: booking } });
    await prisma.payment.deleteMany({ where: { bookingId: booking } });
    await prisma.booking.deleteMany({ where: { id: booking } });
    await prisma.groupBookingSettlement.deleteMany({ where: { groupBookingId: `${R}-group` } });
    await prisma.groupBooking.deleteMany({ where: { id: `${R}-group` } });
    await prisma.booking.deleteMany({ where: { id: `${R}-organiser` } });
    await prisma.member.deleteMany({ where: { id: `${R}-member` } });
    await prisma.lodge.deleteMany({ where: { id: `${R}-lodge` } });
  }
  /** A place with two unpaid organiser extras of `extraCents` each (no fee), and one cancel plan waiving both. */
  async function seed(extraCents: number) {
    await cleanup();
    const member = `${R}-member`;
    await prisma.member.create({ data: { id: member, email: `${R}@example.invalid`, firstName: "Raced", lastName: "Cash", passwordHash: "not-a-real-password", ageTier: "ADULT" } });
    await prisma.lodge.create({ data: { id: `${R}-lodge`, name: "Raced cash proof", slug: R } });
    const stay = { memberId: member, lodgeId: `${R}-lodge`, checkIn: new Date("2026-08-01T00:00:00.000Z"), checkOut: new Date("2026-08-02T00:00:00.000Z"), totalPriceCents: 10_000, finalPriceCents: 10_000, status: "PAID" as const };
    await prisma.booking.create({ data: { ...stay, id: `${R}-organiser` } });
    await prisma.groupBooking.create({ data: { id: `${R}-group`, organiserBookingId: `${R}-organiser`, organiserMemberId: member, joinCode: R, paymentMode: "ORGANISER_PAYS" } });
    await prisma.groupBookingSettlement.create({ data: { id: `${R}-settlement`, groupBookingId: `${R}-group`, amountCents: 10_000, source: "INTERNET_BANKING", status: "SUCCEEDED", xeroInvoiceId: `${R}-combined` } });
    await prisma.booking.create({ data: { ...stay, id: booking, parentBookingId: `${R}-organiser`, organiserSettled: true } });
    await prisma.payment.create({ data: { id: `${R}-payment`, bookingId: booking, amountCents: 10_000, source: "INTERNET_BANKING", status: "SUCCEEDED" } });
    for (const id of ids) {
      await prisma.bookingModification.create({ data: { id: `${R}-mod-${id}`, bookingId: booking, memberId: member, modificationType: "DATE_CHANGE", previousData: {}, newData: {}, priceDiffCents: extraCents, changeFeeCents: 0, createdAt: new Date(`2026-06-0${id === "a" ? 1 : 2}T00:00:00.000Z`) } });
      await prisma.xeroObjectLink.create({ data: { localModel: "BookingModification", localId: `${R}-mod-${id}`, xeroObjectType: "INVOICE", xeroObjectId: `${R}-invoice-${id}`, role: "SUPPLEMENTARY_INVOICE", metadata: { organiserBilling: true, priceDiffCents: extraCents, changeFeeCents: 0 } } });
      xero.paidCents[`${R}-invoice-${id}`] = 0;
    }
    // A 25% tier with a $50 fixed fee over a $100 basis: the plan refunds nothing and leaves $25 of its fee unabsorbed.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      await reserveOrganiserExtraCancellation(tx, { bookingId: booking, scopeId: `${R}-cancel`, refundAmountCents: 0, refundBasisCents: 10_000, refundPercentage: 25, fixedFeeCents: 5_000 });
    });
  }
  /**
   * Claims every queued waiver of the plan, as the outbox does, and runs them all at once. With
   * `barrier`, the global lock is held until both waivers queue on it, so their reservations overlap.
   */
  async function runWaiversConcurrently(attempt: number, barrier = false) {
    const waivers = (await prisma.xeroSyncOperation.findMany({ where: { localId: booking, queueType: "ORGANISER_EXTRA_ADJUSTMENT" } }))
      .filter((row) => readOrganiserExtraAdjustmentPayload(row.requestPayload)?.purpose === "waive");
    expect(waivers).toHaveLength(2);
    const startedAt = new Date(Date.UTC(2026, 6, 1, 0, attempt));
    await prisma.xeroSyncOperation.updateMany({ where: { id: { in: waivers.map((row) => row.id) } }, data: { status: "RUNNING", startedAt } });
    let release = () => {};
    const holding = new Promise<void>((resolve) => { release = resolve; });
    let locked = () => {};
    const isLocked = new Promise<void>((resolve) => { locked = resolve; });
    const holder = barrier ? prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      locked();
      await holding;
    }, { timeout: 30_000 }) : Promise.resolve();
    if (barrier) await isLocked;
    const running = Promise.all(waivers.map((row) => execute(readOrganiserExtraAdjustmentPayload(row.requestPayload)!, { id: row.id, startedAt })));
    // Bounded by polls, not the clock: both waivers queue on the key the holder has.
    let bothQueued = false;
    for (let poll = 0; barrier && !bothQueued && poll < 400; poll += 1) {
      const [{ waiting }] = await prisma.$queryRaw<{ waiting: bigint }[]>`
        SELECT count(*) AS waiting FROM pg_locks WHERE locktype = 'advisory' AND objid = 1 AND objsubid = 1 AND NOT granted`;
      bothQueued = Number(waiting) >= 2;
      if (!bothQueued) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    release();
    await holder;
    await running;
    // Both completed: nothing was left due, so neither raised a credit note.
    expect((await prisma.xeroSyncOperation.findMany({ where: { id: { in: waivers.map((row) => row.id) } } })).map((row) => row.status)).toEqual(["SUCCEEDED", "SUCCEEDED"]);
    return bothQueued;
  }
  const handBacks = async () => (await prisma.manualRefundTask.findMany({ where: { bookingId: booking } })).map((task) => task.amountCents).sort((a, b) => a - b);

  beforeAll(async () => {
    assertSafeRaceDbUrl(url, "organiser extra raced cash");
    process.env.DATABASE_URL = url;
    ({ prisma } = await import("@/lib/prisma"));
    ({ executeOrganiserExtraAdjustment: execute } = await import("@/lib/organiser-extra-adjustment"));
  });
  afterAll(async () => { xero.cashImported = false; if (prisma) await cleanup(); });

  it.each([
    { extraCents: 20_000, handBackCents: [2_500, 5_000], totalCents: 7_500 }, // (10000 + 40000) x 25% - 5000
    { extraCents: 8_000, handBackCents: [1_500], totalCents: 1_500 }, // (10000 + 16000) x 25% - 5000
  ])("two raced extras of $extraCents under one plan, run concurrently, hand back $totalCents in all, and a replay adds nothing", async ({ extraCents, handBackCents, totalCents }) => {
    xero.cashImported = false;
    await seed(extraCents);
    // The organiser pays both extras in full while their waivers are queued; the bank feed imports it.
    for (const id of ids) xero.paidCents[`${R}-invoice-${id}`] = extraCents;
    const { syncOrganiserExtraInvoiceCash } = await import("@/lib/organiser-extra-receipt");
    for (const id of ids) await syncOrganiserExtraInvoiceCash({ invoiceID: `${R}-invoice-${id}`, amountPaid: extraCents / 100, amountDue: 0, total: extraCents / 100 } as Invoice);
    xero.cashImported = true;
    const overlapped = await runWaiversConcurrently(1, true);
    // Which waiver takes the lock first decides the split, never the total.
    expect(await handBacks()).toEqual(handBackCents);
    const raced = (await prisma.xeroSyncOperation.findMany({ where: { localId: booking, queueType: "ORGANISER_EXTRA_ADJUSTMENT" } }))
      .map((row) => readOrganiserExtraAdjustmentPayload(row.requestPayload)!).filter((plan) => plan.racedPlanScopeId);
    expect(raced.every((plan) => plan.racedPlanScopeId === `${R}-cancel`)).toBe(true);
    expect(raced.reduce((sum, plan) => sum + (plan.priceBasisCents ?? 0), 0)).toBe(2 * extraCents);
    expect(raced.reduce((sum, plan) => sum + plan.amountCents, 0)).toBe(totalCents);
    // Both reservations really did queue on the global money lock together.
    expect(overlapped).toBe(true);

    // A stale-claim retry of both waivers reserves nothing more.
    await runWaiversConcurrently(2);
    expect(await handBacks()).toEqual(handBackCents);
  }, 60_000);
});
