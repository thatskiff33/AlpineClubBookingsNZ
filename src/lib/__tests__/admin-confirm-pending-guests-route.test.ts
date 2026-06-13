import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  bookingFindUnique: vi.fn(),
  bookingUpdate: vi.fn(),
  bookingUpdateMany: vi.fn(),
  paymentUpsert: vi.fn(),
  chargePaymentMethod: vi.fn(),
  markBookingPaymentSucceeded: vi.fn(),
  reconcile: vi.fn(),
  enqueueXero: vi.fn(),
  kickXero: vi.fn(),
  sendConfirmedEmail: vi.fn(),
  createStructuredAuditLog: vi.fn(),
  getAuditRequestContext: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findUnique: mocks.bookingFindUnique,
      update: mocks.bookingUpdate,
      updateMany: mocks.bookingUpdateMany,
    },
    payment: { upsert: mocks.paymentUpsert },
  },
}));

vi.mock("@/lib/stripe", () => ({ chargePaymentMethod: mocks.chargePaymentMethod }));
vi.mock("@/lib/payment-reconciliation", () => ({
  markBookingPaymentSucceeded: mocks.markBookingPaymentSucceeded,
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBooking: mocks.reconcile,
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroBookingInvoiceOperation: mocks.enqueueXero,
  kickQueuedXeroOutboxOperationsIfConnected: mocks.kickXero,
}));
vi.mock("@/lib/email", () => ({ sendBookingConfirmedEmail: mocks.sendConfirmedEmail }));
vi.mock("@/lib/audit", () => ({
  createStructuredAuditLog: mocks.createStructuredAuditLog,
  getAuditRequestContext: mocks.getAuditRequestContext,
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { POST } from "@/app/api/admin/bookings/[id]/confirm-pending-guests/route";

const params = Promise.resolve({ id: "b1" });

function makeRequest() {
  return new NextRequest(
    "https://example.test/api/admin/bookings/b1/confirm-pending-guests",
    { method: "POST" }
  );
}

function makeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "b1",
    memberId: "m1",
    status: "PENDING",
    hasNonMembers: true,
    nonMemberHoldUntil: new Date("2026-07-08"),
    checkIn: new Date("2026-07-15"),
    checkOut: new Date("2026-07-17"),
    finalPriceCents: 10000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    member: { email: "m@example.com", firstName: "Pat", lastName: "Lee" },
    guests: [{ id: "g1" }, { id: "g2" }],
    payment: { stripePaymentMethodId: "pm_1", stripeCustomerId: "cus_1" },
    promoRedemption: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin1", role: "ADMIN" } },
  });
  mocks.getAuditRequestContext.mockReturnValue({});
  mocks.createStructuredAuditLog.mockResolvedValue(undefined);
  mocks.reconcile.mockResolvedValue({ enabled: false, deletedCount: 0, createdCount: 0 });
  mocks.bookingUpdate.mockResolvedValue({});
  mocks.bookingUpdateMany.mockResolvedValue({ count: 1 });
  mocks.paymentUpsert.mockResolvedValue({});
  mocks.enqueueXero.mockResolvedValue({ queueOperationId: null });
  mocks.kickXero.mockResolvedValue({});
  mocks.sendConfirmedEmail.mockResolvedValue(undefined);
});

describe("POST /api/admin/bookings/[id]/confirm-pending-guests", () => {
  it("charges the saved card and confirms to PAID, clearing the hold", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking());
    mocks.chargePaymentMethod.mockResolvedValue({
      id: "pi_1",
      status: "succeeded",
      amount: 10000,
      payment_method: "pm_1",
    });
    mocks.markBookingPaymentSucceeded.mockResolvedValue({ outcome: "paid" });

    const res = await POST(makeRequest(), { params });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ success: true, status: "PAID", charged: true });
    expect(mocks.chargePaymentMethod).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 10000, idempotencyKey: "pending_charge_b1" })
    );
    expect(mocks.bookingUpdate).toHaveBeenCalledWith({
      where: { id: "b1" },
      data: { nonMemberHoldUntil: null },
    });
    expect(mocks.createStructuredAuditLog).toHaveBeenCalled();
  });

  it("moves a no-card (request-origin) booking to payment-owed without charging", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking({ payment: null }));

    const res = await POST(makeRequest(), { params });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ status: "PAYMENT_PENDING", charged: false });
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "b1", status: "PENDING" },
      data: { status: "PAYMENT_PENDING", nonMemberHoldUntil: null },
    });
    expect(mocks.chargePaymentMethod).not.toHaveBeenCalled();
  });

  it("confirms a $0 booking to PAID without charging", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking({ finalPriceCents: 0 }));

    const res = await POST(makeRequest(), { params });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ status: "PAID", charged: false });
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "b1", status: "PENDING" },
      data: { status: "PAID", nonMemberHoldUntil: null },
    });
    expect(mocks.paymentUpsert).toHaveBeenCalled();
    expect(mocks.chargePaymentMethod).not.toHaveBeenCalled();
  });

  it("rejects a booking with no pending non-member guests", async () => {
    mocks.bookingFindUnique.mockResolvedValue(
      makeBooking({ status: "PAID", nonMemberHoldUntil: null })
    );

    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(409);
    expect(mocks.chargePaymentMethod).not.toHaveBeenCalled();
  });

  it("returns 404 when the booking is missing", async () => {
    mocks.bookingFindUnique.mockResolvedValue(null);

    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(404);
  });

  it("rejects a non-admin via the requireAdmin guard", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 403 }),
    });

    const res = await POST(makeRequest(), { params });

    expect(res.status).toBe(403);
    expect(mocks.bookingFindUnique).not.toHaveBeenCalled();
    expect(mocks.chargePaymentMethod).not.toHaveBeenCalled();
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
  });
});
