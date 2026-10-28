import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BookingClassificationContext } from "@/lib/xero-booking-repair-types";
import type { RepairDependencies } from "@/lib/xero-booking-repair-deps";

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), load: vi.fn(), events: vi.fn(), enqueue: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/organiser-billing", () => ({ resolveOrganiserBilling: mocks.resolve }));
vi.mock("@/lib/xero-booking-repair-load", () => ({ loadAuditData: mocks.load }));
import { applyHistoricalOrganiserInvoiceRepair, classifyOrganiserBillingRepair } from "@/lib/xero-booking-repair-organiser-billing";

const deps = {
  prisma: { bookingEvent: { findMany: mocks.events } }, enqueueXeroSupplementaryInvoiceOperation: mocks.enqueue,
} as unknown as RepairDependencies;
const date = (day: number) => new Date(`2026-05-${String(day).padStart(2, "0")}T00:00:00.000Z`);
function change(id: string, priceDiffCents: number, changeFeeCents = 0, day = 2) {
  return { id, bookingId: "child", priceDiffCents, changeFeeCents, createdAt: date(day) };
}
function context() {
  return {
    booking: { id: "child", memberId: "joiner", organisation: null,
      member: { id: "joiner", firstName: "Sam", lastName: "Joiner", email: "sam@example.test" },
      status: "CANCELLED", checkIn: date(10), checkOut: date(12), organiserSettled: true, parentBookingId: "parent",
      payment: { id: "payment", source: "INTERNET_BANKING", status: "PARTIALLY_REFUNDED", refundedAmountCents: 3000 },
      modifications: [change("increase", 5000, 1000), change("reduction", -5000, 0, 3)],
    }, modificationLinksById: new Map(), modificationOperationsById: new Map(),
  } as unknown as BookingClassificationContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockResolvedValue({ settlementId: "settlement", combinedInvoiceId: "combined", organiserMemberId: "organiser" });
  mocks.events.mockResolvedValue([{ id: "refund", type: "REFUNDED", amountCents: 3000, occurredAt: date(4), snapshot: null }]);
  mocks.enqueue.mockResolvedValue({ queueOperationId: "queued", message: "Queued" });
});

describe("historical organiser billing B1", () => {
  it("shows later refunds and reductions but bills the full recorded price plus fee after cancellation", async () => {
    const report = await classifyOrganiserBillingRepair(context(), deps);
    expect(report?.actions).toHaveLength(1);
    const action = report!.actions[0]!;
    expect(action.safeToAutoApply).toBe(false);
    expect(action.payload).toMatchObject({ priceDiffCents: 5000, changeFeeCents: 1000, billCents: 6000, bookingStatus: "CANCELLED", recordedRefundedAmountCents: 3000,
      laterReductions: [{ modificationId: "reduction", priceDiffCents: -5000 }], laterEvents: [{ id: "refund", amountCents: 3000 }] });
    expect(action.key).toMatch(/^queue:organiser-historical:increase:[a-f0-9]{64}$/);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("bills every positive net, including fee-only and mixed-sign changes, without reconstructing old reviews", async () => {
    const subject = context();
    subject.booking.modifications = [change("first", 5000), change("second", 5000), change("fee", 0, 500), change("mixed", -400, 500), change("zero-review", 0), change("negative-net", -1000, 500)] as typeof subject.booking.modifications;
    const report = await classifyOrganiserBillingRepair(subject, deps);
    expect(report?.actions.map((row) => row.payload.billCents)).toEqual([5000, 5000, 500, 100]);
    expect(new Set(report?.actions.map((row) => row.key)).size).toBe(4);
  });

  it.each([
    { source: "STRIPE", organiserSettled: true },
    { source: "INTERNET_BANKING", organiserSettled: false },
  ] as const)("leaves the normal classifier to handle $source / organiserSettled=$organiserSettled", async ({ source, organiserSettled }) => {
    const subject = context();
    subject.booking.payment!.source = source;
    subject.booking.organiserSettled = organiserSettled;
    expect(await classifyOrganiserBillingRepair(subject, deps)).toBeNull();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it.each(["PENDING", "RUNNING", "FAILED", "PARTIAL", "SUCCEEDED", "CANCELLED"])("skips an existing %s invoice operation", async (status) => {
    const subject = context();
    subject.modificationOperationsById.set("increase", [{ id: "existing", direction: "OUTBOUND", entityType: "INVOICE", operationType: "CREATE", queueType: "SUPPLEMENTARY_INVOICE", status }] as never);
    const report = await classifyOrganiserBillingRepair(subject, deps);
    expect(report?.actions).toEqual([]);
    expect(report?.findings[0]?.code).toBe("BLOCKED_BY_XERO_OPERATION");
  });

  it("skips an inactive invoice link so a voided historical bill is never re-issued", async () => {
    const subject = context();
    subject.modificationLinksById.set("increase", [{ xeroObjectType: "INVOICE", role: "SUPPLEMENTARY_INVOICE", active: false, xeroObjectId: "old" }] as never);
    expect((await classifyOrganiserBillingRepair(subject, deps))?.actions).toEqual([]);
  });

  it("reports a missing combined invoice without offering a charge", async () => {
    mocks.resolve.mockRejectedValue(new Error("Combined invoice missing"));
    const report = await classifyOrganiserBillingRepair(context(), deps);
    expect(report?.actions).toEqual([]);
    expect(report?.findings[0]?.details).toEqual({ reason: "Combined invoice missing" });
  });

  it("rechecks the reviewed digest before apply and refuses changed refund history", async () => {
    const subject = context();
    const action = (await classifyOrganiserBillingRepair(subject, deps))!.actions[0]!;
    subject.booking.payment!.refundedAmountCents = 3500;
    mocks.load.mockResolvedValue([subject]);
    await applyHistoricalOrganiserInvoiceRepair(action, deps);
    expect(action.status).toBe("skipped");
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("queues the reviewed signed components unpaid, never waiting for a card", async () => {
    const subject = context();
    subject.booking.modifications = [change("increase", -400, 500)] as typeof subject.booking.modifications;
    const action = (await classifyOrganiserBillingRepair(subject, deps))!.actions[0]!;
    mocks.load.mockResolvedValue([subject]);
    await applyHistoricalOrganiserInvoiceRepair(action, deps);
    expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith({ bookingId: "child", bookingModificationId: "increase", priceDiffCents: -400, changeFeeCents: 500 },
      { recordPayment: false, waitForConfirmedAdditionalPayment: false, paymentIntentId: null });
    expect(action.status).toBe("queued");
  });

  it("does not enqueue if another caller already billed the reviewed change", async () => {
    const subject = context();
    const action = (await classifyOrganiserBillingRepair(subject, deps))!.actions[0]!;
    subject.modificationLinksById.set("increase", [{ xeroObjectType: "INVOICE", role: "SUPPLEMENTARY_INVOICE", active: true }] as never);
    mocks.load.mockResolvedValue([subject]);
    await applyHistoricalOrganiserInvoiceRepair(action, deps);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
