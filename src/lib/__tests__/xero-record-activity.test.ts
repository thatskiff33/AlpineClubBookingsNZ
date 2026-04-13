import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}), { virtual: true });

const mocks = vi.hoisted(() => ({
  findUniqueMember: vi.fn(),
  findUniquePayment: vi.fn(),
  findUniqueBooking: vi.fn(),
  findUniqueBookingModification: vi.fn(),
  findUniqueSubscription: vi.fn(),
  findManyOperations: vi.fn(),
  countOperations: vi.fn(),
  groupByOperations: vi.fn(),
  findManyLinks: vi.fn(),
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
  },
}));

vi.mock("@/lib/xero-links", () => ({
  buildXeroObjectUrl: (objectType: string, objectId: string) => `https://xero.test/${objectType}/${objectId}`,
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
    expect(result?.summary).toEqual({
      totalOperations: 3,
      failedOperations: 1,
      pendingOperations: 1,
      partialOperations: 0,
      activeLinks: 1,
    });
    expect(result?.backLink).toEqual({
      href: "/admin/bookings",
      label: "Back to Bookings",
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
      label: "Back to Riley Chen",
    });
  });
});
