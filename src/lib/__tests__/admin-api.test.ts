import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    memberSubscription: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
    payment: { findMany: vi.fn(), count: vi.fn(), aggregate: vi.fn() },
    auditLog: { findMany: vi.fn(), count: vi.fn() },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/utils", () => ({
  getSeasonYear: vi.fn().mockReturnValue(2026),
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { GET as getSubscriptions } from "@/app/api/admin/subscriptions/route";
import { GET as getPayments } from "@/app/api/admin/payments/route";
import { GET as getAuditLog } from "@/app/api/admin/audit-log/route";

const mockedAuth = vi.mocked(auth);

describe("Admin Subscriptions API", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns 401 for unauthenticated requests", async () => {
    mockedAuth.mockResolvedValue(null as any);
    const req = new NextRequest("http://localhost/api/admin/subscriptions");
    const res = await getSubscriptions(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 403 for non-admin users", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as any);
    const req = new NextRequest("http://localhost/api/admin/subscriptions");
    const res = await getSubscriptions(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Forbidden");
  });

  it("returns subscriptions data and summary for admin", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } } as any);

    const mockData = [
      {
        id: "sub1", memberId: "m1", seasonYear: 2026, status: "PAID",
        xeroInvoiceId: "inv-1", paidAt: new Date("2026-04-01"),
        member: { firstName: "Alice", lastName: "Smith", email: "alice@test.com" },
      },
    ];

    vi.mocked(prisma.memberSubscription.findMany).mockResolvedValue(mockData as any);
    vi.mocked(prisma.memberSubscription.count).mockResolvedValue(1);
    vi.mocked(prisma.memberSubscription.groupBy).mockResolvedValue([
      { status: "PAID", _count: 5 },
      { status: "UNPAID", _count: 3 },
      { status: "OVERDUE", _count: 1 },
    ] as any);

    const req = new NextRequest("http://localhost/api/admin/subscriptions?page=1&pageSize=10");
    const res = await getSubscriptions(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(10);
    expect(body.summary.paid).toBe(5);
    expect(body.summary.unpaid).toBe(3);
    expect(body.summary.overdue).toBe(1);
    expect(body.summary.total).toBe(9);
  });

  it("filters by status", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } } as any);
    vi.mocked(prisma.memberSubscription.findMany).mockResolvedValue([]);
    vi.mocked(prisma.memberSubscription.count).mockResolvedValue(0);
    vi.mocked(prisma.memberSubscription.groupBy).mockResolvedValue([] as any);

    const req = new NextRequest("http://localhost/api/admin/subscriptions?status=PAID");
    await getSubscriptions(req);

    expect(prisma.memberSubscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { seasonYear: 2026, status: "PAID" },
      })
    );
  });

  it("applies pagination skip and take", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } } as any);
    vi.mocked(prisma.memberSubscription.findMany).mockResolvedValue([]);
    vi.mocked(prisma.memberSubscription.count).mockResolvedValue(0);
    vi.mocked(prisma.memberSubscription.groupBy).mockResolvedValue([] as any);

    const req = new NextRequest("http://localhost/api/admin/subscriptions?page=3&pageSize=10");
    await getSubscriptions(req);

    expect(prisma.memberSubscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 20, take: 10 })
    );
  });
});

describe("Admin Payments API", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns 401 for unauthenticated requests", async () => {
    mockedAuth.mockResolvedValue(null as any);
    const req = new NextRequest("http://localhost/api/admin/payments");
    const res = await getPayments(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 403 for non-admin users", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as any);
    const req = new NextRequest("http://localhost/api/admin/payments");
    const res = await getPayments(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Forbidden");
  });

  it("returns payments data and summary for admin", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } } as any);

    const mockPayments = [
      {
        id: "pay1", bookingId: "b1", amountCents: 5000, refundedAmountCents: 0,
        status: "SUCCEEDED", stripePaymentIntentId: "pi_123",
        createdAt: new Date("2026-04-01"),
        booking: {
          checkIn: new Date("2026-04-10"), checkOut: new Date("2026-04-12"),
          member: { firstName: "Bob", lastName: "Jones", email: "bob@test.com" },
        },
      },
    ];

    vi.mocked(prisma.payment.findMany).mockResolvedValue(mockPayments as any);
    vi.mocked(prisma.payment.count).mockResolvedValue(1);
    vi.mocked(prisma.payment.aggregate).mockResolvedValue({
      _sum: { amountCents: 10000, refundedAmountCents: 500 },
      _count: 3,
    } as any);

    const req = new NextRequest("http://localhost/api/admin/payments?page=1&pageSize=10");
    const res = await getPayments(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(10);
    expect(body.summary.totalRevenueCents).toBe(10000);
    expect(body.summary.refundedCents).toBe(500);
    expect(body.summary.count).toBe(3);
  });

  it("filters by status", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } } as any);
    vi.mocked(prisma.payment.findMany).mockResolvedValue([]);
    vi.mocked(prisma.payment.count).mockResolvedValue(0);
    vi.mocked(prisma.payment.aggregate).mockResolvedValue({
      _sum: { amountCents: 0, refundedAmountCents: 0 }, _count: 0,
    } as any);

    const req = new NextRequest("http://localhost/api/admin/payments?status=SUCCEEDED");
    await getPayments(req);

    expect(prisma.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: "SUCCEEDED" },
      })
    );
  });

  it("filters by date range", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } } as any);
    vi.mocked(prisma.payment.findMany).mockResolvedValue([]);
    vi.mocked(prisma.payment.count).mockResolvedValue(0);
    vi.mocked(prisma.payment.aggregate).mockResolvedValue({
      _sum: { amountCents: 0, refundedAmountCents: 0 }, _count: 0,
    } as any);

    const req = new NextRequest("http://localhost/api/admin/payments?from=2026-04-01&to=2026-04-30");
    await getPayments(req);

    const callArgs = vi.mocked(prisma.payment.findMany).mock.calls[0][0] as any;
    expect(callArgs.where.booking.checkIn.gte).toEqual(new Date("2026-04-01T00:00:00"));
    expect(callArgs.where.booking.checkIn.lte).toEqual(new Date("2026-04-30T23:59:59"));
  });
});

describe("Admin Audit Log API", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns 401 for unauthenticated requests", async () => {
    mockedAuth.mockResolvedValue(null as any);
    const req = new NextRequest("http://localhost/api/admin/audit-log");
    const res = await getAuditLog(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 403 for non-admin users", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as any);
    const req = new NextRequest("http://localhost/api/admin/audit-log");
    const res = await getAuditLog(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Forbidden");
  });

  it("returns audit log data and actions for admin", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } } as any);

    const mockLogs = [
      {
        id: "log1", action: "BOOKING_CREATED", memberId: "m1",
        targetType: "Booking", targetId: "b1", metadata: {},
        createdAt: new Date("2026-04-05T10:00:00"),
      },
      {
        id: "log2", action: "BOOKING_CANCELLED", memberId: "m2",
        targetType: "Booking", targetId: "b2", metadata: {},
        createdAt: new Date("2026-04-05T11:00:00"),
      },
    ];

    const distinctActions = [
      { action: "BOOKING_CANCELLED" },
      { action: "BOOKING_CREATED" },
      { action: "LOGIN" },
    ];

    // findMany is called twice: once for data, once for distinct actions
    vi.mocked(prisma.auditLog.findMany)
      .mockResolvedValueOnce(mockLogs as any)
      .mockResolvedValueOnce(distinctActions as any);
    vi.mocked(prisma.auditLog.count).mockResolvedValue(2);

    const req = new NextRequest("http://localhost/api/admin/audit-log?page=1&pageSize=25");
    const res = await getAuditLog(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toHaveLength(2);
    expect(body.total).toBe(2);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(25);
    expect(body.actions).toEqual(["BOOKING_CANCELLED", "BOOKING_CREATED", "LOGIN"]);
  });

  it("filters by action", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } } as any);
    vi.mocked(prisma.auditLog.findMany).mockResolvedValue([] as any);
    vi.mocked(prisma.auditLog.count).mockResolvedValue(0);

    const req = new NextRequest("http://localhost/api/admin/audit-log?action=LOGIN");
    await getAuditLog(req);

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { action: "LOGIN" },
      })
    );
  });

  it("filters by date range", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } } as any);
    vi.mocked(prisma.auditLog.findMany).mockResolvedValue([] as any);
    vi.mocked(prisma.auditLog.count).mockResolvedValue(0);

    const req = new NextRequest("http://localhost/api/admin/audit-log?from=2026-04-01&to=2026-04-30");
    await getAuditLog(req);

    const callArgs = vi.mocked(prisma.auditLog.findMany).mock.calls[0][0] as any;
    expect(callArgs.where.createdAt.gte).toEqual(new Date("2026-04-01T00:00:00"));
    expect(callArgs.where.createdAt.lte).toEqual(new Date("2026-04-30T23:59:59"));
  });
});
