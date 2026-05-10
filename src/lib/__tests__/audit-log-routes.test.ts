import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    auditLog: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

const { mockRequireActiveSessionUser } = vi.hoisted(() => ({
  mockRequireActiveSessionUser: vi
    .fn<(memberId: string) => Promise<Response | null>>()
    .mockResolvedValue(null),
}));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mockRequireActiveSessionUser,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: vi.fn(),
  },
}));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { GET as getAdminMemberAuditLog } from "@/app/api/admin/members/[id]/audit-log/route";
import { GET as getMemberAuditLog } from "@/app/api/member/audit-log/route";

const mockedAuth = vi.mocked(auth);
const mockedPrisma = vi.mocked(prisma, true);

function auditLog(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "audit-1",
    action: "booking.payment.confirmed",
    memberId: "admin-1",
    targetId: "member-1",
    details: null,
    ipAddress: "203.0.113.10",
    createdAt: new Date("2026-05-10T01:00:00.000Z"),
    actorMemberId: "admin-1",
    subjectMemberId: "member-1",
    entityType: "Booking",
    entityId: "booking-1",
    category: "payment",
    severity: "critical",
    outcome: "success",
    summary: "Payment confirmed",
    metadata: { amountCents: 12345 },
    requestId: "req-1",
    userAgent: "Unit Test",
    retentionClass: "critical",
    ...overrides,
  };
}

describe("admin member audit log endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireActiveSessionUser.mockResolvedValue(null);
  });

  it("returns 401 for unauthenticated requests", async () => {
    mockedAuth.mockResolvedValue(null as never);

    const req = new NextRequest(
      "http://localhost/api/admin/members/member-1/audit-log"
    );
    const res = await getAdminMemberAuditLog(req, {
      params: Promise.resolve({ id: "member-1" }),
    });

    expect(res.status).toBe(401);
  });

  it("returns 403 for non-admin users", async () => {
    mockedAuth.mockResolvedValue({
      user: { id: "member-1", role: "MEMBER" },
    } as never);

    const req = new NextRequest(
      "http://localhost/api/admin/members/member-1/audit-log"
    );
    const res = await getAdminMemberAuditLog(req, {
      params: Promise.resolve({ id: "member-1" }),
    });

    expect(res.status).toBe(403);
  });

  it("returns 404 for a missing target member", async () => {
    mockedAuth.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN" },
    } as never);
    mockedPrisma.member.findUnique.mockResolvedValue(null);

    const req = new NextRequest(
      "http://localhost/api/admin/members/member-1/audit-log"
    );
    const res = await getAdminMemberAuditLog(req, {
      params: Promise.resolve({ id: "member-1" }),
    });

    expect(res.status).toBe(404);
  });

  it("returns paginated audit rows with admin-only metadata and actor details", async () => {
    mockedAuth.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN" },
    } as never);
    mockedPrisma.member.findUnique.mockResolvedValue({ id: "member-1" } as never);
    mockedPrisma.auditLog.findMany.mockResolvedValue([auditLog()] as never);
    mockedPrisma.auditLog.count.mockResolvedValue(1);
    mockedPrisma.member.findMany.mockResolvedValue([
      {
        id: "admin-1",
        firstName: "Ada",
        lastName: "Admin",
        email: "ada@example.com",
        role: "ADMIN",
      },
    ] as never);

    const req = new NextRequest(
      "http://localhost/api/admin/members/member-1/audit-log?category=payment&page=2&pageSize=5"
    );
    const res = await getAdminMemberAuditLog(req, {
      params: Promise.resolve({ id: "member-1" }),
    });

    expect(res.status).toBe(200);
    expect(mockedPrisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 5,
        take: 5,
      })
    );

    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.page).toBe(2);
    expect(body.pageSize).toBe(5);
    expect(body.category).toBe("payment");
    expect(body.data[0]).toEqual(
      expect.objectContaining({
        id: "audit-1",
        summary: "Payment confirmed",
        metadata: { amountCents: 12345 },
        requestId: "req-1",
        ipAddress: "203.0.113.10",
        userAgent: "Unit Test",
        actorDisplayName: "Ada Admin",
      })
    );
    expect(body.data[0].actor).toEqual(
      expect.objectContaining({ email: "ada@example.com", role: "ADMIN" })
    );
  });
});

describe("member self audit log endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireActiveSessionUser.mockResolvedValue(null);
  });

  it("returns 401 for unauthenticated requests", async () => {
    mockedAuth.mockResolvedValue(null as never);

    const req = new NextRequest("http://localhost/api/member/audit-log");
    const res = await getMemberAuditLog(req);

    expect(res.status).toBe(401);
  });

  it("rejects admin-only category filters", async () => {
    mockedAuth.mockResolvedValue({
      user: { id: "member-1", role: "MEMBER" },
    } as never);

    const req = new NextRequest(
      "http://localhost/api/member/audit-log?category=admin"
    );
    const res = await getMemberAuditLog(req);

    expect(res.status).toBe(400);
    expect(mockedPrisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  it("redacts admin-only metadata and admin actor details for member view", async () => {
    mockedAuth.mockResolvedValue({
      user: { id: "member-1", role: "MEMBER" },
    } as never);
    mockedPrisma.auditLog.findMany.mockResolvedValue([auditLog()] as never);
    mockedPrisma.auditLog.count.mockResolvedValue(1);
    mockedPrisma.member.findMany.mockResolvedValue([
      {
        id: "admin-1",
        firstName: "Ada",
        lastName: "Admin",
        email: "ada@example.com",
        role: "ADMIN",
      },
    ] as never);

    const req = new NextRequest(
      "http://localhost/api/member/audit-log?category=payment&page=1&pageSize=10"
    );
    const res = await getMemberAuditLog(req);

    expect(res.status).toBe(200);
    expect(mockedPrisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 0,
        take: 10,
      })
    );

    const body = await res.json();
    expect(body.data[0]).toEqual(
      expect.objectContaining({
        summary: "Payment confirmed",
        actor: null,
        actorDisplayName: "Club admin",
        metadata: null,
      })
    );
    expect(body.data[0]).not.toHaveProperty("requestId");
    expect(body.data[0]).not.toHaveProperty("ipAddress");
    expect(body.data[0]).not.toHaveProperty("userAgent");
  });
});
