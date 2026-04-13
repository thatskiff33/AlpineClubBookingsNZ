import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  mockAuth,
  mockRequireActiveSessionUser,
  mockChargePaymentMethod,
  mockIsXeroConnected,
  mockCreateXeroInvoiceForBooking,
  mockNotifyXeroSyncError,
  mockSendAdminPaymentFailureAlert,
  mockLogAudit,
  mockBookingFindUnique,
  mockBookingUpdateMany,
  mockBookingUpdate,
  mockPaymentUpdate,
  mockPrismaTransaction,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireActiveSessionUser: vi.fn().mockResolvedValue(null),
  mockChargePaymentMethod: vi.fn(),
  mockIsXeroConnected: vi.fn().mockResolvedValue(false),
  mockCreateXeroInvoiceForBooking: vi.fn(),
  mockNotifyXeroSyncError: vi.fn().mockResolvedValue(undefined),
  mockSendAdminPaymentFailureAlert: vi.fn().mockResolvedValue(undefined),
  mockLogAudit: vi.fn(),
  mockBookingFindUnique: vi.fn(),
  mockBookingUpdateMany: vi.fn(),
  mockBookingUpdate: vi.fn(),
  mockPaymentUpdate: vi.fn(),
  mockPrismaTransaction: vi.fn(),
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

vi.mock("@/lib/xero", () => ({
  isXeroConnected: (...args: unknown[]) => mockIsXeroConnected(...args),
  createXeroInvoiceForBooking: (...args: unknown[]) => mockCreateXeroInvoiceForBooking(...args),
}));

vi.mock("@/lib/email", () => ({
  sendAdminPaymentFailureAlert: (...args: unknown[]) => mockSendAdminPaymentFailureAlert(...args),
}));

vi.mock("@/lib/xero-error-alert", () => ({
  notifyXeroSyncError: (...args: unknown[]) => mockNotifyXeroSyncError(...args),
}));

vi.mock("@/lib/audit", () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
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
    mockBookingUpdate.mockResolvedValue({});
    mockPrismaTransaction.mockImplementation(async (actions: unknown[]) =>
      Promise.all(actions as Promise<unknown>[])
    );
  });

  it("marks the booking PAID immediately when the off-session charge succeeds", async () => {
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_success_1",
      status: "succeeded",
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

    expect(mockPaymentUpdate).toHaveBeenCalledWith({
      where: { bookingId: "booking-1" },
      data: {
        stripePaymentIntentId: "pi_success_1",
        status: "SUCCEEDED",
      },
    });
    expect(mockBookingUpdate).toHaveBeenCalledWith({
      where: { id: "booking-1" },
      data: { status: "PAID" },
    });
  });

  it("does not revert the booking to PENDING when local persistence fails after a successful charge", async () => {
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_success_2",
      status: "succeeded",
    });
    mockPaymentUpdate.mockRejectedValue(new Error("Payment update failed"));

    const request = new NextRequest("http://localhost/api/payments/charge-saved-method", {
      method: "POST",
      body: JSON.stringify({ bookingId: "booking-1" }),
      headers: { "content-type": "application/json" },
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "Failed to charge saved payment method" });
    expect(mockBookingUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockBookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "booking-1", status: "PENDING" },
      data: { status: "CONFIRMED" },
    });
  });

  it("notifies admins when Xero invoice creation fails after a successful charge", async () => {
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_success_3",
      status: "succeeded",
    });
    mockIsXeroConnected.mockResolvedValue(true);
    mockCreateXeroInvoiceForBooking.mockRejectedValue(new Error("Xero down"));

    const request = new NextRequest("http://localhost/api/payments/charge-saved-method", {
      method: "POST",
      body: JSON.stringify({ bookingId: "booking-1" }),
      headers: { "content-type": "application/json" },
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(mockNotifyXeroSyncError).toHaveBeenCalledWith({
      errorType: "INVOICE_CREATION",
      operation: "Create invoice for booking booking-1 after saved-card charge",
      errorMessage: "Xero down",
    });
  });
});
