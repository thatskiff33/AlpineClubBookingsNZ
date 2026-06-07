import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockAuth,
  mockRequireActiveSessionUser,
  mockChargePaymentMethod,
  mockEnqueueXeroBookingInvoiceOperation,
  mockKickQueuedXeroOutboxOperationsIfConnected,
  mockSendAdminPaymentFailureAlert,
  mockLogAudit,
  mockBookingFindUnique,
  mockBookingUpdateMany,
  mockBookingUpdate,
  mockPaymentUpdate,
  mockPrismaTransaction,
  mockMarkBookingPaymentSucceeded,
  mockCheckCapacityForGuestRanges,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireActiveSessionUser: vi.fn().mockResolvedValue(null),
  mockChargePaymentMethod: vi.fn(),
  mockEnqueueXeroBookingInvoiceOperation: vi.fn().mockResolvedValue({
    queueOperationId: "op_1",
    message: "queued",
  }),
  mockKickQueuedXeroOutboxOperationsIfConnected: vi.fn().mockResolvedValue({
    found: 1,
    processed: 1,
    succeeded: 1,
    failed: 0,
    skipped: 0,
  }),
  mockSendAdminPaymentFailureAlert: vi.fn().mockResolvedValue(undefined),
  mockLogAudit: vi.fn(),
  mockBookingFindUnique: vi.fn(),
  mockBookingUpdateMany: vi.fn(),
  mockBookingUpdate: vi.fn(),
  mockPaymentUpdate: vi.fn(),
  mockPrismaTransaction: vi.fn(),
  mockMarkBookingPaymentSucceeded: vi.fn(),
  mockCheckCapacityForGuestRanges: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mockAuth,
}));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mockRequireActiveSessionUser,
}));

vi.mock("@/lib/stripe", () => ({
  chargePaymentMethod: (...args: unknown[]) => mockChargePaymentMethod(...args),
}));

vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroBookingInvoiceOperation: (...args: unknown[]) =>
    mockEnqueueXeroBookingInvoiceOperation(...args),
  kickQueuedXeroOutboxOperationsIfConnected: (...args: unknown[]) =>
    mockKickQueuedXeroOutboxOperationsIfConnected(...args),
}));

vi.mock("@/lib/email", () => ({
  sendAdminPaymentFailureAlert: (...args: unknown[]) => mockSendAdminPaymentFailureAlert(...args),
}));

vi.mock("@/lib/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

vi.mock("@/lib/payment-reconciliation", () => ({
  markBookingPaymentSucceeded: (...args: unknown[]) =>
    mockMarkBookingPaymentSucceeded(...args),
}));

vi.mock("@/lib/capacity", () => ({
  checkCapacityForGuestRanges: (...args: unknown[]) =>
    mockCheckCapacityForGuestRanges(...args),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findUnique: (...args: unknown[]) => mockBookingFindUnique(...args),
      updateMany: (...args: unknown[]) => mockBookingUpdateMany(...args),
      update: (...args: unknown[]) => mockBookingUpdate(...args),
    },
    payment: {
      update: (...args: unknown[]) => mockPaymentUpdate(...args),
    },
    $transaction: (...args: unknown[]) => mockPrismaTransaction(...args),
  },
}));

import { POST } from "@/app/api/payments/charge-saved-method/route";

describe("POST /api/payments/charge-saved-method", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    mockBookingFindUnique.mockResolvedValue({
      id: "booking-1",
      memberId: "member-1",
      status: "PENDING",
      finalPriceCents: 12500,
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      guests: [
        {
          id: "guest-1",
          stayStart: new Date("2026-07-10"),
          stayEnd: new Date("2026-07-11"),
        },
        {
          id: "guest-2",
          stayStart: new Date("2026-07-11"),
          stayEnd: new Date("2026-07-12"),
        },
      ],
      payment: {
        stripePaymentMethodId: "pm_123",
        stripeCustomerId: "cus_123",
      },
      member: {
        firstName: "Alice",
        lastName: "Example",
      },
    });
    mockBookingUpdateMany.mockResolvedValue({ count: 1 });
    mockPaymentUpdate.mockResolvedValue({});
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: true,
      minAvailable: 0,
      nightDetails: [],
    });
    mockBookingUpdate.mockResolvedValue({});
    mockPrismaTransaction.mockImplementation(async (arg: unknown) => {
      if (typeof arg === "function") {
        return arg({
          booking: {
            update: (...args: unknown[]) => mockBookingUpdate(...args),
          },
        });
      }

      return Promise.all(arg as Promise<unknown>[]);
    });
    mockMarkBookingPaymentSucceeded.mockResolvedValue({
      outcome: "paid",
      bookingId: "booking-1",
      bumpedBookingIds: [],
    });
  });

  it("marks the booking PAID immediately when the off-session charge succeeds", async () => {
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_success_1",
      status: "succeeded",
      amount: 12500,
    });

    const request = new NextRequest("http://localhost/api/payments/charge-saved-method", {
      method: "POST",
      body: JSON.stringify({ bookingId: "booking-1" }),
      headers: { "content-type": "application/json" },
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      paymentIntentId: "pi_success_1",
      status: "succeeded",
    });

    expect(mockMarkBookingPaymentSucceeded).toHaveBeenCalledWith({
      bookingId: "booking-1",
      paymentIntentId: "pi_success_1",
      amountCents: 12500,
      paymentMethodId: null,
    });
    expect(mockCheckCapacityForGuestRanges).toHaveBeenCalledWith(
      new Date("2026-07-10"),
      new Date("2026-07-12"),
      expect.arrayContaining([
        expect.objectContaining({
          stayStart: new Date("2026-07-10"),
          stayEnd: new Date("2026-07-11"),
        }),
        expect.objectContaining({
          stayStart: new Date("2026-07-11"),
          stayEnd: new Date("2026-07-12"),
        }),
      ]),
      "booking-1"
    );
  });

  it("returns 409 without charging when saved-card capacity preflight fails", async () => {
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: false,
      minAvailable: -1,
      nightDetails: [],
    });

    const request = new NextRequest("http://localhost/api/payments/charge-saved-method", {
      method: "POST",
      body: JSON.stringify({ bookingId: "booking-1" }),
      headers: { "content-type": "application/json" },
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toContain("capacity");
    expect(mockChargePaymentMethod).not.toHaveBeenCalled();
    expect(mockMarkBookingPaymentSucceeded).not.toHaveBeenCalled();
  });

  it("does not revert the booking to PENDING when local persistence fails after a successful charge", async () => {
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_success_2",
      status: "succeeded",
      amount: 12500,
    });
    mockMarkBookingPaymentSucceeded.mockRejectedValue(new Error("Payment update failed"));

    const request = new NextRequest("http://localhost/api/payments/charge-saved-method", {
      method: "POST",
      body: JSON.stringify({ bookingId: "booking-1" }),
      headers: { "content-type": "application/json" },
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "Failed to charge saved payment method" });
    expect(mockBookingUpdateMany).not.toHaveBeenCalled();
  });

  it("still succeeds when Xero invoice queueing fails after a successful charge", async () => {
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_success_3",
      status: "succeeded",
      amount: 12500,
    });
    mockEnqueueXeroBookingInvoiceOperation.mockRejectedValue(new Error("Xero down"));

    const request = new NextRequest("http://localhost/api/payments/charge-saved-method", {
      method: "POST",
      body: JSON.stringify({ bookingId: "booking-1" }),
      headers: { "content-type": "application/json" },
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(mockEnqueueXeroBookingInvoiceOperation).toHaveBeenCalledWith("booking-1", {
      createdByMemberId: "admin-1",
    });
  });
});
