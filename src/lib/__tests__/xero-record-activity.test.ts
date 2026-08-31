import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  findUniqueMember: vi.fn(),
  findUniquePayment: vi.fn(),
  findUniqueBooking: vi.fn(),
  findUniqueBookingModification: vi.fn(),
  findUniqueManualRefundTask: vi.fn(),
  findUniqueSubscription: vi.fn(),
  findManyOperations: vi.fn(),
  countOperations: vi.fn(),
  groupByOperations: vi.fn(),
  findManyLinks: vi.fn(),
  findManyInboundEvents: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: mocks.findUniqueMember,
    },
    payment: {
      findUnique: mocks.findUniquePayment,
    },
    booking: {
      findUnique: mocks.findUniqueBooking,
    },
    bookingModification: {
      findUnique: mocks.findUniqueBookingModification,
    },
    manualRefundTask: {
      findUnique: mocks.findUniqueManualRefundTask,
    },
    memberSubscription: {
      findUnique: mocks.findUniqueSubscription,
    },
    xeroSyncOperation: {
      findMany: mocks.findManyOperations,
      count: mocks.countOperations,
      groupBy: mocks.groupByOperations,
    },
    xeroObjectLink: {
      findMany: mocks.findManyLinks,
    },
    xeroInboundEvent: {
      findMany: mocks.findManyInboundEvents,
    },
  },
}));

// This suite is about SCOPE building — which records a panel gathers — so the
// URL builder stays a recognisable stub. The organisation short code #2314
// applies to these same links is pinned against the real builders in
// `xero-server-deep-links.test.ts`; here it is stubbed out of the way.
vi.mock("@/lib/xero-links", () => ({
  buildXeroObjectUrl: (objectType: string, objectId: string) => `https://xero.test/${objectType}/${objectId}`,
  applyXeroOrgShortCode: (url: string | null) => url,
}));

vi.mock("@/lib/xero-link-short-code", () => ({
  getXeroOrgShortCode: async () => null,
}));

vi.mock("@/lib/xero-operation-retry", () => ({
  getXeroOperationRetryMeta: (operation: { status: string }) =>
    operation.status === "FAILED"
      ? { supported: true, reason: null }
      : { supported: false, reason: "Not retryable" },
}));

import { getXeroRecordActivity } from "@/lib/xero-record-activity";

describe("getXeroRecordActivity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.countOperations.mockResolvedValue(3);
    mocks.groupByOperations.mockResolvedValue([
      { status: "FAILED", _count: 1 },
      { status: "PENDING", _count: 1 },
      { status: "SUCCEEDED", _count: 1 },
    ]);
    mocks.findManyLinks.mockResolvedValue([]);
    mocks.findManyInboundEvents.mockResolvedValue([]);
  });

  it("builds booking scope activity across the booking, payment, and modifications", async () => {
    mocks.findUniqueBooking.mockResolvedValue({
      id: "book_1",
      checkIn: new Date("2026-05-01T00:00:00.000Z"),
      checkOut: new Date("2026-05-03T00:00:00.000Z"),
      member: { firstName: "Aroha", lastName: "Ngata" },
      payment: { id: "pay_1", amountCents: 12345 },
      modifications: [
        { id: "mod_1", modificationType: "DATE_CHANGE", priceDiffCents: 2500 },
      ],
    });
    mocks.findManyOperations.mockResolvedValue([
      {
        id: "op_1",
        direction: "OUTBOUND",
        entityType: "INVOICE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "pay_1",
        status: "FAILED",
        idempotencyKey: "idem_1",
        correlationKey: "corr_1",
        attemptCount: 2,
        replayable: true,
        lastErrorCode: "500",
        lastErrorMessage: "boom",
        requestPayload: { test: true },
        responsePayload: { ok: false },
        xeroObjectType: "INVOICE",
        xeroObjectId: "xero_inv_1",
        xeroObjectNumber: "INV-001",
        xeroObjectUrl: null,
        createdByMemberId: "admin_1",
        startedAt: new Date("2026-05-01T01:00:00.000Z"),
        completedAt: new Date("2026-05-01T01:01:00.000Z"),
        createdAt: new Date("2026-05-01T01:00:00.000Z"),
        updatedAt: new Date("2026-05-01T01:01:00.000Z"),
      },
    ]);
    mocks.findManyLinks.mockResolvedValue([
      {
        id: "link_1",
        localModel: "Payment",
        localId: "pay_1",
        xeroObjectType: "INVOICE",
        xeroObjectId: "xero_inv_1",
        xeroObjectNumber: "INV-001",
        xeroObjectUrl: null,
        role: "PRIMARY_INVOICE",
        active: true,
        metadata: null,
        createdAt: new Date("2026-05-01T01:00:00.000Z"),
        updatedAt: new Date("2026-05-01T01:01:00.000Z"),
      },
    ]);
    mocks.findManyInboundEvents.mockResolvedValue([
      {
        id: "evt_1",
        source: "webhook",
        eventCategory: "INVOICE",
        eventType: "UPDATE",
        resourceId: "xero_inv_1",
        correlationKey: "corr_evt_1",
        payload: { invoiceId: "xero_inv_1" },
        status: "FAILED",
        errorMessage: "sync failed",
        processedAt: null,
        createdAt: new Date("2026-05-01T02:00:00.000Z"),
      },
    ]);

    const result = await getXeroRecordActivity("Booking", "book_1", 25);

    expect(result).not.toBeNull();
    expect(result?.scopeRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ localModel: "Booking", localId: "book_1", relation: "Booking" }),
        expect.objectContaining({ localModel: "Payment", localId: "pay_1", relation: "Payment" }),
        expect.objectContaining({ localModel: "BookingModification", localId: "mod_1", relation: "Modification" }),
      ])
    );
    expect(result?.operations[0]).toMatchObject({
      localUrl: "/admin/xero/records/Payment/pay_1",
      localLabel: "Payment $123.45",
      xeroObjectUrl: "https://xero.test/INVOICE/xero_inv_1",
      supported: true,
    });
    expect(result?.links[0]).toMatchObject({
      localUrl: "/admin/xero/records/Payment/pay_1",
      xeroObjectUrl: "https://xero.test/INVOICE/xero_inv_1",
    });
    expect(result?.inboundEvents[0]).toMatchObject({
      id: "evt_1",
      eventCategory: "INVOICE",
      xeroObjectUrl: "https://xero.test/INVOICE/xero_inv_1",
      canReplay: true,
    });
    expect(result?.summary).toEqual({
      totalOperations: 3,
      failedOperations: 1,
      pendingOperations: 1,
      partialOperations: 0,
      activeLinks: 1,
    });
    expect(result?.backLink).toEqual({
      href: "/admin/bookings",
      label: "Bookings",
    });

    expect(mocks.findManyOperations).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: expect.arrayContaining([
            { localModel: "Booking", localId: "book_1" },
            { localModel: "Payment", localId: "pay_1" },
            { localModel: "BookingModification", localId: "mod_1" },
          ]),
        },
      })
    );
    expect(mocks.findManyInboundEvents).toHaveBeenCalledWith({
      where: {
        OR: [{ eventCategory: "INVOICE", resourceId: "xero_inv_1" }],
      },
      orderBy: { createdAt: "desc" },
      take: 25,
    });
  });

  /**
   * #3193 fix round: THE SECOND ASK HAS A PAGE.
   *
   * A second supplementary invoice is anchored on the review task whose settled
   * share it bills, so the booking change's own reads cannot find it and raise it
   * to the combined total. `ManualRefundTask` was not a Xero local model, so this
   * returned null: the record page 404'd and the operations panel rendered the
   * row as untitled plain text. A second ask that Xero rejected was then
   * findable only by somebody with no reason to look, while the booking's audit
   * trail already said the amount was being billed.
   */
  it("builds review-task scope activity for a second supplementary invoice", async () => {
    mocks.findUniqueManualRefundTask.mockResolvedValue({
      id: "task_2",
      status: "COMPLETED",
      amountCents: 3000,
      booking: {
        id: "book_1",
        checkIn: new Date("2026-05-01T00:00:00.000Z"),
        checkOut: new Date("2026-05-03T00:00:00.000Z"),
        payment: { id: "pay_1", amountCents: 12345 },
      },
    });
    mocks.findManyOperations.mockResolvedValue([]);

    const result = await getXeroRecordActivity("ManualRefundTask", "task_2", 10);

    expect(result).not.toBeNull();
    // The SCOPE is the task alone, so the page shows this ask's own operations
    // and links rather than the whole booking's.
    expect(result?.scopeRecords).toEqual([
      expect.objectContaining({ localModel: "ManualRefundTask", localId: "task_2" }),
    ]);
    expect(result?.relatedRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ localModel: "Booking", localId: "book_1" }),
        expect.objectContaining({ localModel: "Payment", localId: "pay_1" }),
      ])
    );
    expect(result?.rootRecord.label).toContain("$30.00");
    // And the row is OPENABLE. A `localModel` the admin link builder does not
    // know renders as plain text with no page behind it, which is how a failed
    // second ask stayed invisible.
    expect(result?.rootRecord.url).toBe("/admin/xero/records/ManualRefundTask/task_2");
    expect(result?.backLink).toEqual({
      href: "/admin/xero/records/Booking/book_1",
      label: "Booking Activity",
    });
  });

  it("includes member subscriptions in member-scoped activity", async () => {
    mocks.findUniqueMember.mockResolvedValue({
      id: "mem_1",
      firstName: "Riley",
      lastName: "Chen",
      subscriptions: [
        { id: "sub_1", seasonYear: 2026, status: "PAID" },
      ],
    });
    mocks.findManyOperations.mockResolvedValue([]);

    const result = await getXeroRecordActivity("Member", "mem_1", 10);

    expect(result).not.toBeNull();
    expect(result?.scopeRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ localModel: "Member", localId: "mem_1" }),
        expect.objectContaining({ localModel: "MemberSubscription", localId: "sub_1" }),
      ])
    );
    expect(result?.backLink).toEqual({
      href: "/admin/members/mem_1",
      label: "Riley Chen",
    });
  });
});
