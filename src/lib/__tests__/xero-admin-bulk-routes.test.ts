import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  after: vi.fn((callback: () => Promise<void> | void) => {
    void callback();
  }),
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  logAudit: vi.fn(),
  getXeroAdminHealthSnapshot: vi.fn(),
  getMissingXeroInvoiceBookings: vi.fn(),
  getFailedXeroOperationOverview: vi.fn(),
  enqueueXeroBookingInvoiceOperation: vi.fn(),
  processQueuedXeroOutboxOperations: vi.fn(),
  enqueueXeroSyncOperationRetry: vi.fn(),
  processQueuedXeroOperationRetries: vi.fn(),
  findOrCreateXeroContact: vi.fn(),
  checkMembershipStatus: vi.fn(),
  buildXeroInvoiceUrl: vi.fn((invoiceId: string) => `https://xero.test/invoices/${invoiceId}`),
  loggerError: vi.fn(),
  prisma: {
    xeroSyncOperation: {
      findMany: vi.fn(),
    },
    member: {
      findMany: vi.fn(),
    },
    booking: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();

  return {
    ...actual,
    after: mocks.after,
  };
});

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/audit", () => ({
  logAudit: mocks.logAudit,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: mocks.loggerError,
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: mocks.prisma,
}));

vi.mock("@/lib/xero-admin-health", () => ({
  getXeroAdminHealthSnapshot: mocks.getXeroAdminHealthSnapshot,
  getMissingXeroInvoiceBookings: mocks.getMissingXeroInvoiceBookings,
}));

vi.mock("@/lib/xero-admin-failures", () => ({
  getFailedXeroOperationOverview: mocks.getFailedXeroOperationOverview,
}));

vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroBookingInvoiceOperation: mocks.enqueueXeroBookingInvoiceOperation,
  processQueuedXeroOutboxOperations: mocks.processQueuedXeroOutboxOperations,
}));

vi.mock("@/lib/xero-operation-queue", () => ({
  enqueueXeroSyncOperationRetry: mocks.enqueueXeroSyncOperationRetry,
  processQueuedXeroOperationRetries: mocks.processQueuedXeroOperationRetries,
}));

vi.mock("@/lib/xero-operation-retry", () => {
  class TestXeroOperationRetryError extends Error {
    status: number;

    constructor(message: string, status = 400) {
      super(message);
      this.name = "XeroOperationRetryError";
      this.status = status;
    }
  }

  return {
    XeroOperationRetryError: TestXeroOperationRetryError,
  };
});

vi.mock("@/lib/xero-links", () => ({
  buildXeroInvoiceUrl: mocks.buildXeroInvoiceUrl,
}));

vi.mock("@/lib/xero", () => {
  class TestXeroContactValidationError extends Error {
    missingFields: string[];

    constructor(missingFields: string[]) {
      super("Xero contact validation failed");
      this.name = "XeroContactValidationError";
      this.missingFields = missingFields;
    }
  }

  return {
    checkMembershipStatus: mocks.checkMembershipStatus,
    findOrCreateXeroContact: mocks.findOrCreateXeroContact,
    XeroContactValidationError: TestXeroContactValidationError,
  };
});

import { GET as getHealth } from "@/app/api/admin/xero/health/route";
import { POST as triggerMissingInvoices } from "@/app/api/admin/xero/missing-invoices/route";
import { POST as retryAllFailedOperations } from "@/app/api/admin/xero/operations/retry-all/route";
import { POST as forceSync } from "@/app/api/admin/xero/force-sync/route";
import { XeroOperationRetryError } from "@/lib/xero-operation-retry";

function adminSession() {
  return { user: { id: "admin-1", role: "ADMIN" } };
}

function makeJsonRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Xero admin bulk routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(adminSession());
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.processQueuedXeroOutboxOperations.mockResolvedValue({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
    mocks.processQueuedXeroOperationRetries.mockResolvedValue({
      found: 1,
      processed: 1,
      succeeded: 1,
      failed: 0,
      skipped: 0,
    });
  });

  it("returns the Xero admin health snapshot for admins", async () => {
    const snapshot = {
      unlinkedMembers: { count: 4, href: "/admin/members?active=true&xeroLinked=false" },
      failedOperations: { count: 2, legacyCount: 5 },
      pendingOperations: { count: 3 },
      lastMembershipRefresh: {
        at: "2026-04-24T10:00:00.000Z",
        lastCronStatus: "SUCCESS",
        lastCronStartedAt: "2026-04-24T09:55:00.000Z",
      },
      missingInvoices: { count: 1 },
      apiBudget: {
        status: "warning",
        usagePercent: 0.8,
        totalCalls: 4000,
        failedCalls: 12,
      },
    };
    mocks.getXeroAdminHealthSnapshot.mockResolvedValue(snapshot);

    const response = await getHealth();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(snapshot);
    expect(mocks.requireActiveSessionUser).toHaveBeenCalledWith("admin-1");
  });

  it("queues missing invoices in bulk and records skipped bookings", async () => {
    mocks.getMissingXeroInvoiceBookings.mockResolvedValue({
      count: 2,
      bookings: [
        {
          bookingId: "booking-1",
          paymentId: "payment-1",
          memberId: "member-1",
          memberName: "Alex Admin",
          memberEmail: "alex@example.com",
          status: "PAID",
          checkIn: "2026-05-01T00:00:00.000Z",
          checkOut: "2026-05-02T00:00:00.000Z",
          createdAt: "2026-04-24T00:00:00.000Z",
          hasLinkedInvoice: false,
        },
        {
          bookingId: "booking-2",
          paymentId: "payment-2",
          memberId: "member-2",
          memberName: "Bailey Booker",
          memberEmail: "bailey@example.com",
          status: "CONFIRMED",
          checkIn: "2026-05-03T00:00:00.000Z",
          checkOut: "2026-05-04T00:00:00.000Z",
          createdAt: "2026-04-24T00:00:00.000Z",
          hasLinkedInvoice: false,
        },
      ],
    });
    mocks.enqueueXeroBookingInvoiceOperation
      .mockResolvedValueOnce({
        queueOperationId: "queue-1",
        message: "Queued booking invoice sync.",
      })
      .mockResolvedValueOnce({
        queueOperationId: null,
        message: "Invoice sync already queued.",
      });

    const response = await triggerMissingInvoices();

    expect(response.status).toBe(202);
    expect(mocks.getMissingXeroInvoiceBookings).toHaveBeenCalledWith({ limit: 200 });
    expect(mocks.enqueueXeroBookingInvoiceOperation).toHaveBeenNthCalledWith(1, "booking-1", {
      createdByMemberId: "admin-1",
    });
    expect(mocks.enqueueXeroBookingInvoiceOperation).toHaveBeenNthCalledWith(2, "booking-2", {
      createdByMemberId: "admin-1",
    });
    expect(mocks.processQueuedXeroOutboxOperations).toHaveBeenCalledWith({ limit: 1 });
    expect(mocks.logAudit).toHaveBeenCalledWith({
      action: "XERO_TRIGGER_MISSING_INVOICES",
      memberId: "admin-1",
      details: "Queued 1 missing booking invoices (1 skipped)",
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      found: 2,
      queued: 1,
      skipped: 1,
      skippedBookings: [
        {
          bookingId: "booking-2",
          reason: "Invoice sync already queued.",
        },
      ],
      message: "Queued 1 missing booking invoice for background processing.",
    });
  });

  it("retries all replayable failed operations and reports skipped ones", async () => {
    mocks.getFailedXeroOperationOverview.mockResolvedValue({
      totalFailedRows: 7,
      activeFailedCount: 2,
      legacyFailedCount: 5,
      activeOperations: [
        { id: "op-1", replayable: true },
        { id: "op-2", replayable: true },
      ],
      resolutions: new Map(),
    });
    mocks.enqueueXeroSyncOperationRetry
      .mockResolvedValueOnce({
        queueOperationId: "queue-op-1",
        message: "Queued retry.",
      })
      .mockRejectedValueOnce(
        new XeroOperationRetryError("A queued retry is already pending for this Xero operation.", 409)
      );

    const response = await retryAllFailedOperations();

    expect(response.status).toBe(202);
    expect(mocks.enqueueXeroSyncOperationRetry).toHaveBeenNthCalledWith(1, "op-1", {
      createdByMemberId: "admin-1",
    });
    expect(mocks.enqueueXeroSyncOperationRetry).toHaveBeenNthCalledWith(2, "op-2", {
      createdByMemberId: "admin-1",
    });
    expect(mocks.processQueuedXeroOperationRetries).toHaveBeenCalledWith({ limit: 1 });
    expect(mocks.logAudit).toHaveBeenCalledWith({
      action: "XERO_OPERATION_RETRY_ALL",
      memberId: "admin-1",
      details: "Queued 1 active Xero retries (1 skipped, 5 legacy hidden)",
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      found: 2,
      queued: 1,
      skipped: 1,
      legacySkipped: 5,
      skippedOperations: [
        {
          id: "op-2",
          reason: "A queued retry is already pending for this Xero operation.",
        },
      ],
      message: "Queued 1 active failed Xero operation for background retry.",
    });
  });

  it("returns a client error when a force-sync member lookup is ambiguous", async () => {
    mocks.prisma.member.findMany.mockResolvedValue([
      {
        id: "member-1",
        firstName: "Alex",
        lastName: "Admin",
        email: "alex@example.com",
      },
      {
        id: "member-2",
        firstName: "Alex",
        lastName: "Aardvark",
        email: "alex2@example.com",
      },
    ]);

    const response = await forceSync(
      makeJsonRequest("http://localhost/api/admin/xero/force-sync", {
        syncType: "CONTACT",
        query: "member",
      })
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Member ID is ambiguous. Use the full member ID.",
    });
    expect(mocks.findOrCreateXeroContact).not.toHaveBeenCalled();
    expect(mocks.logAudit).not.toHaveBeenCalled();
  });
});
