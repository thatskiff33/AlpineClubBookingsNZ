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
  mockUpsertPaymentIntentTransaction,
  mockIsValidCronSecret,
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
  mockUpsertPaymentIntentTransaction: vi.fn().mockResolvedValue(undefined),
  mockIsValidCronSecret: vi.fn().mockReturnValue(false),
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

vi.mock("@/lib/cron-auth", () => ({
  isValidCronSecret: (...args: unknown[]) => mockIsValidCronSecret(...args),
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

vi.mock("@/lib/payment-transactions", () => ({
  upsertPaymentIntentTransaction: (...args: unknown[]) =>
    mockUpsertPaymentIntentTransaction(...args),
}));

vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: vi.fn().mockResolvedValue(undefined),
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
    lodge: {
      findFirst: vi.fn().mockResolvedValue({ id: "lodge-1" }),
    },
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
import {
  HOSTING_COVERAGE_RETRY_CODE,
  HOSTING_COVERAGE_RETRY_MESSAGE,
  HostingCoverageParticipantRetryError,
} from "@/lib/adult-member-hosting-queue-participants";
import { PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY } from "@/lib/payment-recovery-contract";

describe("POST /api/payments/charge-saved-method", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
    mockIsValidCronSecret.mockReturnValue(false);
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
        id: "payment-1",
        stripePaymentMethodId: "pm_123",
        stripeCustomerId: "cus_123",
        // #3269: saved through a SetupIntent, so reusable off-session.
        stripeSetupIntentId: "seti_123",
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
      "lodge-1",
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

  it("refuses (400) a card written by a one-off checkout — no SetupIntent — and never calls Stripe (#3269)", async () => {
    mockBookingFindUnique.mockResolvedValue({
      id: "booking-1",
      memberId: "member-1",
      status: "PENDING",
      finalPriceCents: 12500,
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      guests: [],
      // Customer + pm alone used to pass this route's guard. Stripe refuses to
      // charge a payment method it captured without customer attachment, so
      // the route must refuse first.
      payment: {
        id: "payment-1",
        stripePaymentMethodId: "pm_oneoff",
        stripeCustomerId: "cus_123",
        stripeSetupIntentId: null,
      },
      member: { firstName: "Alice", lastName: "Example" },
    });

    const request = new NextRequest("http://localhost/api/payments/charge-saved-method", {
      method: "POST",
      body: JSON.stringify({ bookingId: "booking-1" }),
      headers: { "content-type": "application/json" },
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "No saved payment method found for this booking",
    });
    expect(mockChargePaymentMethod).not.toHaveBeenCalled();
    expect(mockMarkBookingPaymentSucceeded).not.toHaveBeenCalled();
  });

  it("charges the row's own SetupIntent-saved card (#3269)", async () => {
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_own",
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
    expect(mockChargePaymentMethod).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: "cus_123", paymentMethodId: "pm_123" })
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

  // #1771 — a booking deliberately admitted over the ceiling by an admin carries
  // a persisted capacityOverriddenAt marker. The saved-card preflight must NOT
  // 409 it: the charge proceeds (and markBookingPaymentSucceeded, which honours
  // the same override, settles it).
  it("charges an over-capacity booking with a persisted capacity override instead of 409ing (#1771)", async () => {
    mockBookingFindUnique.mockResolvedValue({
      id: "booking-1",
      memberId: "member-1",
      status: "PENDING",
      finalPriceCents: 12500,
      checkIn: new Date("2026-07-10"),
      checkOut: new Date("2026-07-12"),
      capacityOverriddenAt: new Date("2026-06-01"),
      capacityOverriddenByMemberId: "admin-1",
      guests: [{ id: "guest-1", stayStart: new Date("2026-07-10"), stayEnd: new Date("2026-07-12") }],
      payment: {
        stripePaymentMethodId: "pm_123",
        stripeCustomerId: "cus_123",
        stripeSetupIntentId: "seti_123",
      },
      member: { firstName: "Alice", lastName: "Example" },
    });
    mockCheckCapacityForGuestRanges.mockResolvedValue({
      available: false,
      minAvailable: -1,
      nightDetails: [],
    });
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_override",
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
    expect(mockChargePaymentMethod).toHaveBeenCalled();
    expect(mockMarkBookingPaymentSucceeded).toHaveBeenCalled();
  });

  it("returns privacy-safe status recovery without reverting after a successful charge", async () => {
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_success_2",
      status: "succeeded",
      amount: 12500,
    });
    mockMarkBookingPaymentSucceeded.mockRejectedValue(
      new Error('Payment update failed: constraint "Payment_secret_fkey"'),
    );

    const request = new NextRequest("http://localhost/api/payments/charge-saved-method", {
      method: "POST",
      body: JSON.stringify({ bookingId: "booking-1" }),
      headers: { "content-type": "application/json" },
    });

    const response = await POST(request);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual(PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY);
    expect(body).not.toHaveProperty("finalisationPending");
    expect(body).not.toHaveProperty("paymentIntentId");
    expect(JSON.stringify(body)).not.toContain("Payment_secret_fkey");
    expect(mockBookingUpdateMany).not.toHaveBeenCalled();
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: "pi_success_2" }),
    );
  });

  it("returns the fixed recovery 409 to an admin after a captured charge hits participant contention", async () => {
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_hosting_retry",
      status: "succeeded",
      amount: 12500,
    });
    mockMarkBookingPaymentSucceeded.mockRejectedValue(
      new HostingCoverageParticipantRetryError(),
    );

    const response = await POST(
      new NextRequest("http://localhost/api/payments/charge-saved-method", {
        method: "POST",
        body: JSON.stringify({ bookingId: "booking-1" }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: HOSTING_COVERAGE_RETRY_MESSAGE,
      code: HOSTING_COVERAGE_RETRY_CODE,
      paymentReceived: true,
      finalisationPending: true,
    });
    expect(mockUpsertPaymentIntentTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "payment-1",
        paymentIntentId: "pi_hosting_retry",
        status: "SUCCEEDED",
      }),
    );
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: "pi_hosting_retry" }),
    );
    expect(mockLogAudit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "booking.payment.failed" }),
    );
  });

  it("rethrows participant contention for the cron caller after preserving the captured charge", async () => {
    mockIsValidCronSecret.mockReturnValue(true);
    mockAuth.mockResolvedValue(null);
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_cron_hosting_retry",
      status: "succeeded",
      amount: 12500,
    });
    mockMarkBookingPaymentSucceeded.mockRejectedValue(
      new HostingCoverageParticipantRetryError(),
    );

    await expect(
      POST(
        new NextRequest("http://localhost/api/payments/charge-saved-method", {
          method: "POST",
          body: JSON.stringify({ bookingId: "booking-1" }),
          headers: {
            "content-type": "application/json",
            "x-cron-secret": "test",
          },
        }),
      ),
    ).rejects.toMatchObject({ code: HOSTING_COVERAGE_RETRY_CODE });
    expect(mockUpsertPaymentIntentTransaction).toHaveBeenCalled();
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalled();
  });

  it("returns status-unconfirmed recovery for an ordinary cron failure after capture", async () => {
    mockIsValidCronSecret.mockReturnValue(true);
    mockAuth.mockResolvedValue(null);
    mockChargePaymentMethod.mockResolvedValue({
      id: "pi_cron_status_unknown",
      status: "succeeded",
      amount: 12500,
    });
    mockMarkBookingPaymentSucceeded.mockRejectedValue(
      new Error("local persistence unavailable"),
    );

    const response = await POST(
      new NextRequest("http://localhost/api/payments/charge-saved-method", {
        method: "POST",
        body: JSON.stringify({ bookingId: "booking-1" }),
        headers: {
          "content-type": "application/json",
          "x-cron-secret": "test",
        },
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual(
      PAYMENT_RECEIVED_STATUS_UNCONFIRMED_BODY,
    );
    expect(mockSendAdminPaymentFailureAlert).toHaveBeenCalled();
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
