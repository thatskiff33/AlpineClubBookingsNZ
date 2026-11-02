/** #4299: real money claims, with Xero a stateful double of the extra invoices and their credit notes. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Invoice } from "xero-node";
import type { Prisma } from "@prisma/client";
import { assertSafeRaceDbUrl } from "@/lib/__tests__/support/race-db-url";
import { releaseBookingFinancialHistoryForTeardown } from "@/lib/__tests__/support/booking-financial-history-teardown";
import { effectiveOrganiserPaidChangeFeeCents, readOrganiserExtraReduction, readOrganiserExtraState } from "@/lib/organiser-extra-state";
import { reserveOrganiserExtraCancellation, bindOrganiserExtraRefundToHandBack, releaseOrganiserExtraRefundNotes, settleOrganiserExtraReduction } from "@/lib/organiser-extra-netting";
import { readOrganiserExtraAdjustmentPayload } from "@/lib/organiser-extra-adjustment-payload";
import { cancelRefundableBaseCents } from "@/lib/booking-payment-state";
import { openNonCancellationHandBackCents, refundableCashNetOfOpenHandBacks } from "@/lib/edit-refund-hand-back";
import { calculateRefundAmount } from "@/lib/policies/cancellation";

// F3: this file's connections carry their own name, so a lock barrier counts only this file's own
// waiters. Set before any import builds the client (`@/lib/prisma` reads the URL once); nothing
// connects until a suite's `beforeAll` has passed `assertSafeRaceDbUrl`.
const race = vi.hoisted(() => {
  const APPLICATION_NAME = `race-4299-netting-${process.pid}`;
  let taggedUrl = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
  try {
    const tagged = new URL(taggedUrl);
    tagged.searchParams.set("application_name", APPLICATION_NAME);
    taggedUrl = tagged.toString();
  } catch {
    // Not a URL: the suites skip, or their guard refuses it.
  }
  if (process.env.RUN_CONCURRENCY_RACE_TESTS === "1" && taggedUrl) process.env.DATABASE_URL = taggedUrl;
  return { APPLICATION_NAME, taggedUrl };
});
// Xero: each extra invoice's total, the organiser's payments and the credit notes allocated to it.
const xero = vi.hoisted(() => ({
  invoices: {} as Record<string, { totalCents: number; paidCents: number; creditedCents: number; voided: boolean }>,
  notes: {} as Record<string, { totalCents: number; allocations: { invoice: { invoiceID: string }; amount: number }[]; voided: boolean }>,
  cashImported: false,
}));
const invoiceBody = vi.hoisted(() => (invoiceID: string) => {
  const invoice = xero.invoices[invoiceID]!;
  const dueCents = invoice.voided ? 0 : invoice.totalCents - invoice.paidCents - invoice.creditedCents;
  return {
    invoiceID, invoiceNumber: invoiceID, contact: { contactID: "organiser" }, total: invoice.totalCents / 100,
    amountPaid: invoice.paidCents / 100, amountCredited: invoice.creditedCents / 100, amountDue: dueCents / 100,
    status: invoice.voided ? "VOIDED" : dueCents === 0 ? "PAID" : "AUTHORISED",
  } as unknown as Invoice;
});
// The raced-cash case can import the cash itself first, so the waivers' first global lock is the reservation's.
vi.mock("@/lib/organiser-extra-receipt", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/organiser-extra-receipt");
  return { ...actual, syncOrganiserExtraInvoiceCash: async (invoice: Invoice) => (xero.cashImported ? undefined : actual.syncOrganiserExtraInvoiceCash(invoice)) };
});
vi.mock("@/lib/xero-api-client", () => ({
  getAuthenticatedXeroClient: vi.fn(async () => ({ tenantId: "fake-tenant", xero: { accountingApi: {
    getInvoice: vi.fn(async (_tenant: string, invoiceID: string) => ({ body: { invoices: [invoiceBody(invoiceID)] } })),
    updateInvoice: vi.fn(async (_tenant: string, invoiceID: string) => { xero.invoices[invoiceID]!.voided = true; return { body: {} }; }),
    createCreditNotes: vi.fn(async (_tenant: string, body: { creditNotes: { lineItems: { unitAmount: number }[] }[] }) => {
      const creditNoteID = `note-${Object.keys(xero.notes).length + 1}`;
      xero.notes[creditNoteID] = { totalCents: Math.round(body.creditNotes[0]!.lineItems[0]!.unitAmount * 100), allocations: [], voided: false };
      return { body: { creditNotes: [{ creditNoteID }] } };
    }),
    getCreditNote: vi.fn(async (_tenant: string, creditNoteID: string) => {
      const note = xero.notes[creditNoteID]!;
      return { body: { creditNotes: [{ creditNoteID, status: note.voided ? "VOIDED" : "AUTHORISED", total: note.totalCents / 100, allocations: note.allocations, lineItems: [{ quantity: 1 }] }] } };
    }),
    updateCreditNote: vi.fn(async (_tenant: string, creditNoteID: string, body: { creditNotes: { status?: string; lineItems?: { unitAmount: number }[] }[] }) => {
      const change = body.creditNotes[0]!;
      if (change.status === "VOIDED") xero.notes[creditNoteID]!.voided = true;
      else xero.notes[creditNoteID]!.totalCents = Math.round(change.lineItems![0]!.unitAmount * 100);
      return { body: {} };
    }),
    createCreditNoteAllocation: vi.fn(async (_tenant: string, creditNoteID: string, body: { allocations: { invoice: { invoiceID: string }; amount: number }[] }) => {
      const allocation = body.allocations[0]!;
      xero.notes[creditNoteID]!.allocations.push({ invoice: allocation.invoice, amount: allocation.amount });
      xero.invoices[allocation.invoice.invoiceID]!.creditedCents += Math.round(allocation.amount * 100);
      return { body: {} };
    }),
  } } })),
  callXeroApi: vi.fn(async (call: () => Promise<unknown>) => call()),
}));

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const url = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const { APPLICATION_NAME, taggedUrl } = race;
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
    // #4514: ledger lines no longer cascade with their booking (INV-MONEY-043).
    await releaseBookingFinancialHistoryForTeardown(prisma, [childId, organiserId]);
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
    process.env.DATABASE_URL = taggedUrl;
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
 * #4299: cash the organiser pays while queued waivers of an extra invoice wait
 * is refunded as if it had arrived before the oldest plan - once per plan
 * (N1 fix delta), under the real global money lock however the waivers
 * interleave, at each plan's own tier, its fee charged once. The plans are
 * sized by the real arithmetic their callers use: a reduction's basis from its
 * unpaid-extra offset and the cash still refundable, a cancel's from
 * `cancelRefundableBaseCents` over the reduced price.
 */
(RUN ? describe : describe.skip)("organiser extra raced cash - real PostgreSQL", () => {
  const R = "race-4299-raced";
  const ids = ["a", "b"] as const;
  const booking = `${R}-child`;
  type Tier = { percentage: number; fixedFeeCents: number };
  let execute: (typeof import("@/lib/organiser-extra-adjustment"))["executeOrganiserExtraAdjustment"];
  async function cleanup() {
    await releaseBookingFinancialHistoryForTeardown(prisma, [booking, `${R}-organiser`]);
    await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [booking, ...ids.map((id) => `${R}-mod-${id}`)] } } });
    await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: [booking, `${R}-payment`, ...ids.map((id) => `${R}-mod-${id}`)] } } });
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
  /** A place whose organiser paid its $100 share, with raised, unpaid organiser extras (`ids` order, oldest first). */
  async function seed(extras: { priceCents: number; feeCents: number }[]) {
    xero.cashImported = false;
    xero.invoices = {};
    xero.notes = {};
    await cleanup();
    const member = `${R}-member`;
    await prisma.member.create({ data: { id: member, email: `${R}@example.invalid`, firstName: "Raced", lastName: "Cash", passwordHash: "not-a-real-password", ageTier: "ADULT" } });
    await prisma.lodge.create({ data: { id: `${R}-lodge`, name: "Raced cash proof", slug: R } });
    const stay = { memberId: member, lodgeId: `${R}-lodge`, checkIn: new Date("2026-08-01T00:00:00.000Z"), checkOut: new Date("2026-08-02T00:00:00.000Z"), status: "PAID" as const };
    await prisma.booking.create({ data: { ...stay, id: `${R}-organiser`, totalPriceCents: 10_000, finalPriceCents: 10_000 } });
    await prisma.groupBooking.create({ data: { id: `${R}-group`, organiserBookingId: `${R}-organiser`, organiserMemberId: member, joinCode: R, paymentMode: "ORGANISER_PAYS" } });
    await prisma.groupBookingSettlement.create({ data: { id: `${R}-settlement`, groupBookingId: `${R}-group`, amountCents: 10_000, source: "INTERNET_BANKING", status: "SUCCEEDED", xeroInvoiceId: `${R}-combined` } });
    // The place's price rose by every extra; the fees are recorded on its payment, as the edit records them.
    const placeCents = 10_000 + extras.reduce((sum, extra) => sum + extra.priceCents, 0);
    await prisma.booking.create({ data: { ...stay, id: booking, parentBookingId: `${R}-organiser`, organiserSettled: true, totalPriceCents: placeCents, finalPriceCents: placeCents } });
    await prisma.payment.create({ data: { id: `${R}-payment`, bookingId: booking, amountCents: 10_000, changeFeeCents: extras.reduce((sum, extra) => sum + extra.feeCents, 0), source: "INTERNET_BANKING", status: "SUCCEEDED" } });
    for (const [index, { priceCents, feeCents }] of extras.entries()) {
      const id = ids[index]!;
      await prisma.bookingModification.create({ data: { id: `${R}-mod-${id}`, bookingId: booking, memberId: member, modificationType: "DATE_CHANGE", previousData: {}, newData: {}, priceDiffCents: priceCents, changeFeeCents: feeCents, createdAt: new Date(Date.UTC(2026, 5, 1 + index)) } });
      await prisma.xeroObjectLink.create({ data: { localModel: "BookingModification", localId: `${R}-mod-${id}`, xeroObjectType: "INVOICE", xeroObjectId: `${R}-invoice-${id}`, role: "SUPPLEMENTARY_INVOICE", metadata: { organiserBilling: true, priceDiffCents: priceCents, changeFeeCents: feeCents } } });
      xero.invoices[`${R}-invoice-${id}`] = { totalCents: priceCents + feeCents, paidCents: 0, creditedCents: 0, voided: false };
    }
  }
  const tierRefund = (basisCents: number, tier: Tier) =>
    calculateRefundAmount(basisCents, 0, [{ daysBeforeStay: 0, refundPercentage: tier.percentage, creditRefundPercentage: tier.percentage, fixedFeeCents: tier.fixedFeeCents, creditFixedFeeCents: 0 }], "card").refundAmountCents;
  /** One plan, reserved as the money claim does: under the global lock. */
  const plan = <T>(reserve: (tx: Prisma.TransactionClient) => Promise<T>) => prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
    return reserve(tx);
  });
  /** A reduction, sized as the edit sizes it: its unpaid-extra offset first, then the cash still refundable. */
  const planReduction = (scopeId: string, reductionCents: number, tier: Tier) => plan(async (tx) => {
    const reduction = await readOrganiserExtraReduction(tx, booking, reductionCents);
    const payment = await tx.payment.findUniqueOrThrow({ where: { bookingId: booking } });
    const refundableCents = (await refundableCashNetOfOpenHandBacks(tx, payment)) - effectiveOrganiserPaidChangeFeeCents(payment.changeFeeCents, reduction);
    const basisCents = Math.max(0, Math.min(reductionCents - reduction.offsetCents, refundableCents));
    const refundCents = tierRefund(basisCents, tier);
    await settleOrganiserExtraReduction(tx, { reduction: { ...reduction, scopeId }, refundAmountCents: refundCents, refundBasisCents: basisCents, refundPercentage: tier.percentage, fixedFeeCents: tier.fixedFeeCents });
    await tx.booking.update({ where: { id: booking }, data: { finalPriceCents: { decrement: reductionCents } } });
    return refundCents;
  });
  /** The cancel, sized as `booking-cancel.ts` sizes it: `cancelRefundableBaseCents` over the reduced price. */
  const planCancel = (tier: Tier) => plan(async (tx) => {
    const payment = await tx.payment.findUniqueOrThrow({ where: { bookingId: booking } });
    const { finalPriceCents } = await tx.booking.findUniqueOrThrow({ where: { id: booking }, select: { finalPriceCents: true } });
    const state = await readOrganiserExtraState(tx, booking);
    const basisCents = cancelRefundableBaseCents({
      amountCents: payment.amountCents, refundedAmountCents: payment.refundedAmountCents,
      openNonCancellationHandBackCents: await openNonCancellationHandBackCents(tx, payment.id), finalPriceCents,
      changeFeeCents: effectiveOrganiserPaidChangeFeeCents(payment.changeFeeCents, state),
    });
    const refundCents = tierRefund(basisCents, tier);
    await reserveOrganiserExtraCancellation(tx, { bookingId: booking, scopeId: `${R}-cancel`, refundAmountCents: refundCents, refundBasisCents: basisCents, refundPercentage: tier.percentage, fixedFeeCents: tier.fixedFeeCents });
    return refundCents;
  });
  /** The organiser pays `cents` of the extra invoice, and - unless the case imports it later - the bank feed imports it. */
  async function pay(id: (typeof ids)[number], cents: number) {
    xero.invoices[`${R}-invoice-${id}`]!.paidCents += cents;
    const { syncOrganiserExtraInvoiceCash } = await import("@/lib/organiser-extra-receipt");
    await syncOrganiserExtraInvoiceCash(invoiceBody(`${R}-invoice-${id}`));
  }
  /** The plans' queued waivers, oldest plan first, claimed as the outbox claims them. */
  async function claimWaivers(attempt: number) {
    const waivers = (await prisma.xeroSyncOperation.findMany({ where: { localId: booking, queueType: "ORGANISER_EXTRA_ADJUSTMENT" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }))
      .filter((row) => readOrganiserExtraAdjustmentPayload(row.requestPayload)?.purpose === "waive");
    const startedAt = new Date(Date.UTC(2026, 6, 1, 0, attempt));
    await prisma.xeroSyncOperation.updateMany({ where: { id: { in: waivers.map((row) => row.id) } }, data: { status: "RUNNING", startedAt } });
    // No reset runs in this suite, so no late note re-takes a row (#4655): a re-take here is a failure.
    const onRetake = () => { throw new Error("No organiser waiver here should re-take its row: nothing reset it"); };
    return waivers.map((row) => () => execute(readOrganiserExtraAdjustmentPayload(row.requestPayload)!, { id: row.id, startedAt }, { onRetake }));
  }
  /**
   * Claims every queued waiver of the plan, as the outbox does, and runs them all at once. With
   * `barrier`, the global lock is held until both waivers queue on it, so their reservations overlap.
   */
  async function runWaiversConcurrently(attempt: number, barrier = false) {
    const waivers = await claimWaivers(attempt);
    expect(waivers).toHaveLength(2);
    let release = () => {};
    const holding = new Promise<void>((resolve) => { release = resolve; });
    let locked: (pid: number) => void = () => {};
    const isLocked = new Promise<number>((resolve) => { locked = resolve; });
    const holder = barrier ? prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;
      const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      locked(pid);
      await holding;
    }, { timeout: 30_000 }) : Promise.resolve();
    const holderPid = barrier ? await isLocked : 0;
    const running = Promise.all(waivers.map((run) => run()));
    // F3: bounded by polls, not the clock; counts only this file's own backends (the waivers), never the holder.
    let bothQueued = false;
    for (let poll = 0; barrier && !bothQueued && poll < 400; poll += 1) {
      const [{ waiting }] = await prisma.$queryRaw<{ waiting: bigint }[]>`
        SELECT count(*) AS waiting FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory' AND l.objid = 1 AND l.objsubid = 1 AND NOT l.granted
          AND a.application_name = ${APPLICATION_NAME} AND l.pid <> ${holderPid}`;
      bothQueued = Number(waiting) >= 2;
      if (!bothQueued) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    release();
    await holder;
    await running;
    return bothQueued;
  }
  /** Every hand-back raised, oldest first. */
  const handBacks = async () => (await prisma.manualRefundTask.findMany({ where: { bookingId: booking }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })).map((task) => task.amountCents);
  /** Raced cash's refund rows: every one names the plan whose waiver it met. */
  const racedRows = async () => (await prisma.xeroSyncOperation.findMany({ where: { localId: booking, queueType: "ORGANISER_EXTRA_ADJUSTMENT" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }))
    .map((row) => readOrganiserExtraAdjustmentPayload(row.requestPayload)!).filter((row) => row.racedPlanScopeId);
  /** Every waiver that did not complete. */
  const waiversUnfinished = async () => (await prisma.xeroSyncOperation.findMany({ where: { localId: booking, queueType: "ORGANISER_EXTRA_ADJUSTMENT", status: { not: "SUCCEEDED" } } }))
    .filter((row) => readOrganiserExtraAdjustmentPayload(row.requestPayload)?.purpose === "waive");
  /** Runs the queued waivers one at a time in `order`, then replays them all: the replay reserves nothing. */
  async function runInOrder(order: "oldest-first" | "newest-first") {
    const waivers = await claimWaivers(1);
    for (const run of order === "oldest-first" ? waivers : [...waivers].reverse()) await run();
    expect(await waiversUnfinished()).toEqual([]);
    const settled = await handBacks();
    for (const run of await claimWaivers(2)) await run();
    expect(await handBacks()).toEqual(settled);
    return settled;
  }

  beforeAll(async () => {
    assertSafeRaceDbUrl(url, "organiser extra raced cash");
    process.env.DATABASE_URL = taggedUrl;
    ({ prisma } = await import("@/lib/prisma"));
    ({ executeOrganiserExtraAdjustment: execute } = await import("@/lib/organiser-extra-adjustment"));
  });
  afterAll(async () => { xero.cashImported = false; if (prisma) await cleanup(); });

  it.each([
    { extraCents: 20_000, handBackCents: [2_500, 5_000], totalCents: 7_500 }, // (10000 + 40000) x 25% - 5000
    { extraCents: 8_000, handBackCents: [1_500], totalCents: 1_500 }, // (10000 + 16000) x 25% - 5000
  ])("two raced extras of $extraCents under one plan, run concurrently, hand back $totalCents in all, and a replay adds nothing", async ({ extraCents, handBackCents, totalCents }) => {
    await seed([{ priceCents: extraCents, feeCents: 0 }, { priceCents: extraCents, feeCents: 0 }]);
    // A 25% tier with a $50 fixed fee: the cancel's own base is the $100 share (the extras unpaid), so it refunds nothing.
    expect(await planCancel({ percentage: 25, fixedFeeCents: 5_000 })).toBe(0);
    // The organiser pays both extras in full while their waivers are queued; the bank feed imports it.
    for (const id of ids) await pay(id, extraCents);
    xero.cashImported = true;
    const overlapped = await runWaiversConcurrently(1, true);
    expect(await waiversUnfinished()).toEqual([]);
    // Which waiver takes the lock first decides the split, never the total.
    expect([...(await handBacks())].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(handBackCents);
    const raced = await racedRows();
    expect(raced.every((row) => row.racedPlanScopeId === `${R}-cancel`)).toBe(true);
    expect(raced.reduce((sum, row) => sum + (row.priceBasisCents ?? 0), 0)).toBe(2 * extraCents);
    expect(raced.reduce((sum, row) => sum + row.amountCents, 0)).toBe(totalCents);
    // Both reservations really did queue on the global money lock together.
    expect(overlapped).toBe(true);

    // A stale-claim retry of both waivers reserves nothing more.
    await runWaiversConcurrently(2);
    expect([...(await handBacks())].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(handBackCents);
  }, 60_000);

  // One $60 extra ($50 + $10 fee) on a $100 share. A 50% reduction of $30 waives $30 of it; a 25% cancel follows.
  // The policy, as if the organiser's cash had arrived before the reduction: cash pays the fee first; the reduction
  // refunds what its waiver no longer needed at 50%; the cancel refunds the reduced place's paid price at 25%.
  const half = { percentage: 50, fixedFeeCents: 0 };
  const quarter = { percentage: 25, fixedFeeCents: 0 };

  it.each(["oldest-first", "newest-first"] as const)("(a)/(b) both waivers queued when all 6000c lands, run %s: hand-backs 1500c then 500c (with the cancel's 2500c, the policy's 4500c)", async (order) => {
    await seed([{ priceCents: 5_000, feeCents: 1_000 }]);
    expect(await planReduction(`${R}-reduction`, 3_000, half)).toBe(0);
    // The cancel's base is the $100 share: the extra unpaid, its fee unpaid too.
    expect(await planCancel(quarter)).toBe(2_500);
    await pay("a", 6_000);
    xero.cashImported = true;
    expect(await runInOrder(order)).toEqual([1_500, 500]);
    expect((await racedRows()).map((row) => [row.racedPlanScopeId, row.priceBasisCents, row.amountCents])).toEqual([[`${R}-reduction`, 3_000, 1_500], [`${R}-cancel`, 2_000, 500]]);
  }, 60_000);

  it("(c) the $60 imported before the cancel plans: the cancel's real base excludes the reduction's $30, so the reduction's queued waiver keeps its $15 (with the cancel's $30, the policy's $45)", async () => {
    await seed([{ priceCents: 5_000, feeCents: 1_000 }]);
    await planReduction(`${R}-reduction`, 3_000, half);
    await pay("a", 6_000);
    // min($160 paid, $120 now worth + $10 fee) - $10 fee = $120 at 25%.
    expect(await planCancel(quarter)).toBe(3_000);
    xero.cashImported = true;
    expect(await runInOrder("oldest-first")).toEqual([1_500]);
  }, 60_000);

  it.each(["oldest-first", "newest-first"] as const)("only 3000c paid while both waivers were queued, run %s: the reduction's waiver is set against the 3000c still unpaid, the cancel hands back 2000c of price at 25%", async (order) => {
    await seed([{ priceCents: 5_000, feeCents: 1_000 }]);
    await planReduction(`${R}-reduction`, 3_000, half);
    expect(await planCancel(quarter)).toBe(2_500);
    await pay("a", 3_000);
    xero.cashImported = true;
    // Policy: the cancel's base would be min($130, $120 + $10) - $10 = $120, $30 at 25%: $5 more than its $25.
    expect(await runInOrder(order)).toEqual([500]);
    // What was still due is credited, never voided: the invoice carries a payment.
    expect(xero.invoices[`${R}-invoice-a`]).toMatchObject({ paidCents: 3_000, creditedCents: 3_000, voided: false });
  }, 60_000);
});
