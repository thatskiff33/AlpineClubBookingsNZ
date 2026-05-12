import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { count: vi.fn(), findMany: vi.fn() },
    memberSubscription: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() },
    payment: { findMany: vi.fn(), count: vi.fn(), aggregate: vi.fn() },
    auditLog: { findMany: vi.fn(), count: vi.fn() },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
const {
  mockRequireActiveSessionUser,
  mockGetXeroContactGroupMemberships,
  mockGetXeroContactIdsForGroup,
} = vi.hoisted(() => ({
  mockRequireActiveSessionUser: vi
    .fn<(memberId: string) => Promise<Response | null>>()
    .mockResolvedValue(null),
  mockGetXeroContactGroupMemberships: vi
    .fn<
      (contactIds: string[]) => Promise<Record<string, Array<{ id: string; name: string }>>>
    >()
    .mockResolvedValue({}),
  mockGetXeroContactIdsForGroup: vi
    .fn<(groupId: string) => Promise<string[]>>()
    .mockResolvedValue([]),
}));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mockRequireActiveSessionUser,
}));
vi.mock("@/lib/xero", () => ({
  getXeroContactGroupMemberships: mockGetXeroContactGroupMemberships,
  getXeroContactIdsForGroup: mockGetXeroContactIdsForGroup,
}));

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
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.member.count).mockResolvedValue(1 as any);
    mockGetXeroContactGroupMemberships.mockResolvedValue({});
    mockGetXeroContactIdsForGroup.mockResolvedValue([]);
  });

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
        member: {
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@test.com",
          ageTier: "ADULT",
          xeroContactId: "xc-1",
        },
      },
    ];

    mockGetXeroContactGroupMemberships.mockResolvedValue({
      "xc-1": [{ id: "cg-1", name: "Adult Members" }],
    });
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
    expect(body.data[0].member.ageTier).toBe("ADULT");
    expect(body.data[0].xeroContactGroups).toEqual([
      { id: "cg-1", name: "Adult Members" },
    ]);
    expect(body.xeroContactGroupsLoaded).toBe(true);
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

  it("filters by age tier and xero contact group", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } } as any);
    mockGetXeroContactIdsForGroup.mockResolvedValue(["xc-1", "xc-2"]);
    vi.mocked(prisma.memberSubscription.findMany).mockResolvedValue([]);
    vi.mocked(prisma.memberSubscription.count).mockResolvedValue(0);
    vi.mocked(prisma.memberSubscription.groupBy).mockResolvedValue([] as any);

    const req = new NextRequest(
      "http://localhost/api/admin/subscriptions?ageTier=YOUTH&xeroContactGroup=cg-youth"
    );
    await getSubscriptions(req);

    expect(mockGetXeroContactIdsForGroup).toHaveBeenCalledWith("cg-youth");
    expect(prisma.memberSubscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          seasonYear: 2026,
          member: {
            ageTier: "YOUTH",
            xeroContactId: { in: ["xc-1", "xc-2"] },
          },
        },
      })
    );
  });
});

describe("Admin Payments API", () => {
  function makePaymentCandidate(overrides: Record<string, unknown> = {}) {
    return {
      id: "pay1",
      bookingId: "b1",
      amountCents: 5000,
      refundedAmountCents: 0,
      status: "SUCCEEDED",
      stripePaymentIntentId: "pi_123",
      xeroInvoiceId: null,
      xeroInvoiceNumber: null,
      updatedAt: new Date("2026-04-01T09:00:00.000Z"),
      transactions: [],
      refunds: [],
      booking: {
        id: "b1",
        status: "PAID",
        checkIn: new Date("2026-04-10"),
        creditsFromCancellation: [],
        member: {
          id: "m1",
          firstName: "Bob",
          lastName: "Jones",
          email: "bob@test.com",
        },
      },
      ...overrides,
    };
  }

  function makePaymentRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "pay1",
      bookingId: "b1",
      amountCents: 5000,
      refundedAmountCents: 0,
      status: "SUCCEEDED",
      stripePaymentIntentId: "pi_123",
      xeroInvoiceId: null,
      xeroInvoiceNumber: null,
      createdAt: new Date("2026-04-01T08:00:00.000Z"),
      updatedAt: new Date("2026-04-01T09:00:00.000Z"),
      booking: {
        id: "b1",
        status: "PAID",
        checkIn: new Date("2026-04-10"),
        checkOut: new Date("2026-04-12"),
        creditsFromCancellation: [],
        member: {
          id: "m1",
          firstName: "Bob",
          lastName: "Jones",
          email: "bob@test.com",
        },
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.member.count).mockResolvedValue(1 as any);
  });

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

    vi.mocked(prisma.payment.findMany)
      .mockResolvedValueOnce([
        makePaymentCandidate({
          transactions: [{ updatedAt: new Date("2026-04-03T11:00:00.000Z") }],
        }),
      ] as any)
      .mockResolvedValueOnce([makePaymentRow()] as any);

    const req = new NextRequest("http://localhost/api/admin/payments?page=1&pageSize=10");
    const res = await getPayments(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(10);
    expect(body.summary.totalRevenueCents).toBe(5000);
    expect(body.summary.refundedCents).toBe(0);
    expect(body.summary.count).toBe(1);
    expect(body.data[0].lastUpdatedAt).toBe("2026-04-03T11:00:00.000Z");
  });

  it("filters by status", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } } as any);
    vi.mocked(prisma.payment.findMany).mockResolvedValue([]);
    vi.mocked(prisma.payment.count).mockResolvedValue(0);

    const req = new NextRequest("http://localhost/api/admin/payments?status=SUCCEEDED");
    await getPayments(req);

    expect(prisma.payment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: "SUCCEEDED" },
      })
    );
  });

  it("filters by legacy last-updated date range aliases", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } } as any);
    vi.mocked(prisma.payment.findMany)
      .mockResolvedValueOnce([
        makePaymentCandidate({
          id: "outside",
          updatedAt: new Date("2026-04-01T09:00:00.000Z"),
        }),
        makePaymentCandidate({
          id: "inside",
          updatedAt: new Date("2026-04-01T09:00:00.000Z"),
          transactions: [{ updatedAt: new Date("2026-04-20T09:00:00.000Z") }],
        }),
      ] as any)
      .mockResolvedValueOnce([makePaymentRow({ id: "inside" })] as any);

    const req = new NextRequest("http://localhost/api/admin/payments?from=2026-04-15&to=2026-04-30");
    const res = await getPayments(req);

    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.data[0].id).toBe("inside");
    expect(body.data[0].lastUpdatedAt).toBe("2026-04-20T09:00:00.000Z");
  });

  it("applies member, check-in, amount, and sort filters", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } } as any);
    vi.mocked(prisma.payment.findMany).mockResolvedValue([]);

    const req = new NextRequest(
      "http://localhost/api/admin/payments?search=Alice%20Jones&amountMin=50&amountMax=75&checkInFrom=2026-07-01&checkInTo=2026-07-31&sortBy=amount&sortDir=asc"
    );
    await getPayments(req);

    const callArgs = vi.mocked(prisma.payment.findMany).mock.calls[0][0] as any;
    expect(callArgs.where.amountCents).toEqual({ gte: 5000, lte: 7500 });
    expect(callArgs.where.booking.is.checkIn.gte).toEqual(new Date("2026-07-01T00:00:00"));
    expect(callArgs.where.booking.is.checkIn.lte).toEqual(new Date("2026-07-31T23:59:59"));
    expect(callArgs.where.booking.is.member.is.AND).toHaveLength(2);
  });

  it("lets exact amount take precedence over min and max", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } } as any);
    vi.mocked(prisma.payment.findMany).mockResolvedValue([]);

    const req = new NextRequest(
      "http://localhost/api/admin/payments?amountExact=123.45&amountMin=1&amountMax=999"
    );
    await getPayments(req);

    const callArgs = vi.mocked(prisma.payment.findMany).mock.calls[0][0] as any;
    expect(callArgs.where.amountCents).toBe(12345);
  });

  it("rejects invalid amount ranges", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } } as any);

    const req = new NextRequest("http://localhost/api/admin/payments?amountMin=75&amountMax=50");
    const res = await getPayments(req);

    expect(res.status).toBe(400);
    expect(prisma.payment.findMany).not.toHaveBeenCalled();
  });
});

describe("Admin Audit Log API", () => {
  function auditLog(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: "log1",
      action: "booking.payment.confirmed",
      memberId: "admin-1",
      targetId: "booking-1",
      details: JSON.stringify({ bookingId: "booking-1", amountCents: 10000 }),
      ipAddress: "203.0.113.10",
      createdAt: new Date("2026-04-05T10:00:00"),
      actorMemberId: "admin-1",
      subjectMemberId: "member-1",
      entityType: "Booking",
      entityId: "booking-1",
      category: "payment",
      severity: "critical",
      outcome: "success",
      summary: "Payment confirmed",
      metadata: { bookingId: "booking-1", amountCents: 10000 },
      requestId: "req-1",
      userAgent: "Unit Test",
      retentionClass: "critical",
      ...overrides,
    };
  }

  function mockAuditLogResponse(logs: unknown[] = [], total = logs.length) {
    vi.mocked(prisma.auditLog.findMany)
      .mockResolvedValueOnce(logs as any)
      .mockResolvedValueOnce([
        { action: "booking.payment.confirmed" },
        { action: "LOGIN" },
      ] as any)
      .mockResolvedValueOnce([{ category: "payment" }] as any)
      .mockResolvedValueOnce([{ entityType: "Booking" }] as any)
      .mockResolvedValueOnce([{ outcome: "success" }] as any)
      .mockResolvedValueOnce([{ severity: "critical" }] as any);
    vi.mocked(prisma.auditLog.count).mockResolvedValue(total);
    vi.mocked(prisma.member.findMany).mockResolvedValue([
      {
        id: "admin-1",
        firstName: "Ada",
        lastName: "Admin",
        email: "ada@example.com",
        role: "ADMIN",
      },
      {
        id: "member-1",
        firstName: "Mara",
        lastName: "Member",
        email: "mara@example.com",
        role: "MEMBER",
      },
    ] as any);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.member.count).mockResolvedValue(1 as any);
  });

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

  it("returns 403 for deactivated admin sessions", async () => {
    mockRequireActiveSessionUser.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Account is deactivated" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      })
    );
    mockedAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } } as any);

    const req = new NextRequest("http://localhost/api/admin/audit-log");
    const res = await getAuditLog(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Account is deactivated");
  });

  it("returns readable audit timeline data and filter facets for admin", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } } as any);
    mockAuditLogResponse([auditLog()], 1);

    const req = new NextRequest("http://localhost/api/admin/audit-log?page=1&pageSize=25");
    const res = await getAuditLog(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(25);
    expect(body.data[0]).toEqual(
      expect.objectContaining({
        summary: "Payment confirmed",
        description: "Amount $100.00 · Booking Id booking-1",
        actorDisplayName: "Ada Admin",
        subjectDisplayName: "Mara Member",
        entityType: "Booking",
        entityId: "booking-1",
      })
    );
    expect(body.data[0].drilldowns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ href: "/admin/members/member-1" }),
        expect.objectContaining({ href: "/bookings/booking-1" }),
      ])
    );
    expect(body.facets.eventTypes).toEqual(["booking.payment.confirmed", "LOGIN"]);
    expect(body.actions).toEqual(["booking.payment.confirmed", "LOGIN"]);
  });

  it("filters by event type alias and member scope", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } } as any);
    mockAuditLogResponse();

    const req = new NextRequest(
      "http://localhost/api/admin/audit-log?action=LOGIN&memberId=member-1&memberScope=subject"
    );
    await getAuditLog(req);

    const callArgs = vi.mocked(prisma.auditLog.findMany).mock.calls[0][0] as any;
    expect(callArgs.where.AND).toEqual(
      expect.arrayContaining([
        { action: "LOGIN" },
        expect.objectContaining({
          OR: expect.arrayContaining([{ subjectMemberId: "member-1" }]),
        }),
      ])
    );
  });

  it("filters by date range", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } } as any);
    mockAuditLogResponse();

    const req = new NextRequest("http://localhost/api/admin/audit-log?from=2026-04-01&to=2026-04-30");
    await getAuditLog(req);

    const callArgs = vi.mocked(prisma.auditLog.findMany).mock.calls[0][0] as any;
    const dateWhere = callArgs.where.AND.find(
      (clause: any) => Boolean(clause.createdAt)
    );
    expect(dateWhere.createdAt.gte).toEqual(new Date("2026-04-01T00:00:00"));
    expect(dateWhere.createdAt.lte).toEqual(new Date("2026-04-30T23:59:59"));
  });

  it("filters by category, outcome, severity, entity, and text search", async () => {
    mockedAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } } as any);
    mockAuditLogResponse();

    const req = new NextRequest(
      "http://localhost/api/admin/audit-log?category=payment&outcome=success&severity=critical&entityType=Booking&q=req-1"
    );
    await getAuditLog(req);

    const callArgs = vi.mocked(prisma.auditLog.findMany).mock.calls[0][0] as any;
    expect(callArgs.where.AND).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          OR: expect.arrayContaining([{ category: "payment" }]),
        }),
        { outcome: "success" },
        { severity: "critical" },
        { entityType: "Booking" },
        expect.objectContaining({
          OR: expect.arrayContaining([
            { requestId: { contains: "req-1", mode: "insensitive" } },
          ]),
        }),
      ])
    );
  });
});
