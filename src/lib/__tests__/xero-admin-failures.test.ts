import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    xeroSyncOperation: {
      findMany: vi.fn(),
    },
    member: {
      findMany: vi.fn(),
    },
    payment: {
      findMany: vi.fn(),
    },
    xeroObjectLink: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: mocks.prisma,
}));

import { getFailedXeroOperationOverview } from "@/lib/xero-admin-failures";

function makeOperation(overrides: Record<string, unknown>) {
  return {
    id: "op_default",
    direction: "OUTBOUND",
    entityType: "CONTACT",
    operationType: "CREATE",
    localModel: "Member",
    localId: "member_1",
    status: "FAILED",
    idempotencyKey: null,
    correlationKey: "member:member_1:contact:find-or-create:v1",
    attemptCount: 1,
    replayable: true,
    lastErrorCode: null,
    lastErrorMessage: null,
    requestPayload: null,
    responsePayload: null,
    xeroObjectType: null,
    xeroObjectId: null,
    xeroObjectNumber: null,
    xeroObjectUrl: null,
    createdByMemberId: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date("2026-04-26T00:00:00.000Z"),
    updatedAt: new Date("2026-04-26T00:00:00.000Z"),
    ...overrides,
  };
}

describe("getFailedXeroOperationOverview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prisma.member.findMany.mockResolvedValue([]);
    mocks.prisma.payment.findMany.mockResolvedValue([]);
    mocks.prisma.xeroObjectLink.findMany.mockResolvedValue([]);
  });

  it("counts only the latest unresolved root issue as active and marks repaired rows as legacy", async () => {
    const failedOperations = [
      makeOperation({
        id: "contact_failed",
        entityType: "CONTACT",
        operationType: "CREATE",
        localModel: "Member",
        localId: "member_contact",
        correlationKey: "member:member_contact:contact:find-or-create:v1",
        createdAt: new Date("2026-04-16T00:00:00.000Z"),
      }),
      makeOperation({
        id: "invoice_failed",
        entityType: "INVOICE",
        operationType: "WEBHOOK_RECONCILE",
        localModel: null,
        localId: null,
        correlationKey: "xero:webhook:INVOICE:UPDATE:invoice_1:2026-04-13T17:18:43.079",
        createdAt: new Date("2026-04-16T00:01:00.000Z"),
      }),
      makeOperation({
        id: "credit_failed_old",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "payment_1",
        correlationKey: "payment:payment_1:refund-credit-note:100:v1",
        createdAt: new Date("2026-04-16T00:02:00.000Z"),
      }),
      makeOperation({
        id: "credit_requeue_failed",
        entityType: "CREDIT_NOTE",
        operationType: "REQUEUE",
        localModel: "Payment",
        localId: "payment_1",
        correlationKey: "xero-operation:requeue:credit_failed_old",
        requestPayload: { originalOperationId: "credit_failed_old" },
        createdAt: new Date("2026-04-16T00:03:00.000Z"),
      }),
      makeOperation({
        id: "credit_failed_latest",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "payment_1",
        correlationKey: "payment:payment_1:refund-credit-note:100:v1",
        createdAt: new Date("2026-04-16T00:04:00.000Z"),
      }),
    ];

    mocks.prisma.xeroSyncOperation.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.status === "FAILED") {
        return failedOperations;
      }

      if (where?.status === "SUCCEEDED") {
        return [
          makeOperation({
            id: "contact_success",
            status: "SUCCEEDED",
            correlationKey: "member:member_contact:contact:find-or-create:v1",
            createdAt: new Date("2026-04-16T00:05:00.000Z"),
          }),
          makeOperation({
            id: "invoice_success",
            status: "SUCCEEDED",
            correlationKey: "xero:webhook:INVOICE:UPDATE:invoice_1:2026-04-13T17:18:43.079",
            createdAt: new Date("2026-04-16T00:06:00.000Z"),
          }),
        ];
      }

      if (where?.id?.in) {
        return failedOperations.filter((operation) => where.id.in.includes(operation.id));
      }

      return [];
    });

    mocks.prisma.member.findMany.mockResolvedValue([
      { id: "member_contact", xeroContactId: "xero_contact_1" },
    ]);

    const overview = await getFailedXeroOperationOverview();

    expect(overview.totalFailedRows).toBe(5);
    expect(overview.activeFailedCount).toBe(1);
    expect(overview.legacyFailedCount).toBe(4);
    expect(overview.activeOperations.map((operation) => operation.id)).toEqual([
      "credit_failed_latest",
    ]);
    expect(overview.resolutions.get("contact_failed")).toMatchObject({
      state: "REPAIRED",
    });
    expect(overview.resolutions.get("invoice_failed")).toMatchObject({
      state: "REPAIRED",
    });
    expect(overview.resolutions.get("credit_failed_old")).toMatchObject({
      state: "SUPERSEDED",
      representativeOperationId: "credit_failed_latest",
    });
    expect(overview.resolutions.get("credit_requeue_failed")).toMatchObject({
      state: "SUPERSEDED",
      representativeOperationId: "credit_failed_latest",
    });
    expect(overview.resolutions.get("credit_failed_latest")).toMatchObject({
      state: "ACTIVE",
    });
  });

  it("treats refund-credit-note failures as repaired once the local payment has the durable links", async () => {
    const failedOperations = [
      makeOperation({
        id: "credit_failed",
        entityType: "CREDIT_NOTE",
        operationType: "CREATE",
        localModel: "Payment",
        localId: "payment_2",
        correlationKey: "payment:payment_2:refund-credit-note:2500:v1",
      }),
    ];

    mocks.prisma.xeroSyncOperation.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.status === "FAILED") {
        return failedOperations;
      }

      return [];
    });
    mocks.prisma.payment.findMany.mockResolvedValue([
      { id: "payment_2", xeroRefundCreditNoteId: "cn_123" },
    ]);
    mocks.prisma.xeroObjectLink.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.role === "REFUND_PAYMENT") {
        return [{ localId: "payment_2" }];
      }

      return [];
    });

    const overview = await getFailedXeroOperationOverview();

    expect(overview.activeFailedCount).toBe(0);
    expect(overview.legacyFailedCount).toBe(1);
    expect(overview.resolutions.get("credit_failed")).toMatchObject({
      state: "REPAIRED",
    });
  });
});
