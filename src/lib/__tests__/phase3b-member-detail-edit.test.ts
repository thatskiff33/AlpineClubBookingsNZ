import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    booking: { findMany: vi.fn(), aggregate: vi.fn() },
    auditLog: { create: vi.fn().mockResolvedValue({}), findMany: vi.fn() },
    promoCodeAssignment: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn().mockImplementation((operation: unknown) => {
      if (Array.isArray(operation)) {
        return Promise.all(operation);
      }

      return (operation as (tx: unknown) => Promise<unknown>)({});
    }),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
const mockRequireActiveSessionUser = vi.fn(async () => null);
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: (...args: unknown[]) => mockRequireActiveSessionUser(...args),
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/age-tier", () => ({
  computeAgeTier: vi.fn().mockResolvedValue("ADULT"),
  getSeasonStartDate: vi.fn().mockReturnValue(new Date("2026-04-01")),
}));
vi.mock("@/lib/xero", () => ({
  isXeroConnected: vi.fn().mockResolvedValue(false),
  syncManagedXeroContactGroupForMember: vi.fn(),
  updateXeroContact: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { PUT as updateMember, GET as getMemberDetail } from "@/app/api/admin/members/[id]/route";

const mockedAuth = vi.mocked(auth);
const adminSession = { user: { id: "admin1", role: "ADMIN" } } as any;
const memberSession = { user: { id: "m1", role: "MEMBER" } } as any;

const baseMember = {
  id: "m1", firstName: "Alice", lastName: "Smith", email: "alice@test.com",
  phoneCountryCode: null, phoneAreaCode: null, phoneNumber: "021-123", dateOfBirth: new Date("1990-01-15"),
  role: "MEMBER", ageTier: "ADULT", active: true, forcePasswordChange: false,
  financeAccessLevel: "NONE",
  xeroContactId: null, joinedDate: null, createdAt: new Date("2025-01-01"),
  canLogin: true,
};

function makePutRequest(id: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost/api/admin/members/${id}`, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("Phase 3b: Member Detail Edit — PUT /api/admin/members/[id]", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // ── Auth ──

  it("returns 401 for unauthenticated requests", async () => {
    mockedAuth.mockResolvedValue(null as any);
    const res = await updateMember(makePutRequest("m1", { firstName: "Bob" }), { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(401);
  });

  it("returns 401 for non-admin users", async () => {
    mockedAuth.mockResolvedValue(memberSession);
    const res = await updateMember(makePutRequest("m1", { firstName: "Bob" }), { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(401);
  });

  it("returns 404 for non-existent member", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(null);
    const res = await updateMember(makePutRequest("nonexistent", { firstName: "Bob" }), { params: Promise.resolve({ id: "nonexistent" }) });
    expect(res.status).toBe(404);
  });

  // ── Validation ──

  it("returns 422 for invalid email", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    const res = await updateMember(makePutRequest("m1", { email: "not-an-email" }), { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("Validation failed");
  });

  it("returns 422 for invalid date of birth format", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    const res = await updateMember(makePutRequest("m1", { dateOfBirth: "15/01/1990" }), { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(422);
  });

  it("returns 422 for firstName exceeding max length", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    const res = await updateMember(makePutRequest("m1", { firstName: "A".repeat(101) }), { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(422);
  });

  // ── Email uniqueness ──

  it("returns 409 when changing to an email already in use", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.findFirst).mockResolvedValue({ id: "other" } as any);

    const res = await updateMember(makePutRequest("m1", { email: "taken@test.com" }), { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/already exists/i);
  });

  it("allows keeping the same email (no conflict check against self)", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({ ...baseMember, xeroContactId: null } as any);

    const res = await updateMember(makePutRequest("m1", { email: "alice@test.com" }), { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(200);
    // findFirst for email check should not have been called since email is unchanged
    expect(prisma.member.findFirst).not.toHaveBeenCalled();
  });

  // ── Successful updates ──

  it("updates firstName and lastName", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({ ...baseMember, firstName: "Bob", lastName: "Jones", xeroContactId: null } as any);

    const res = await updateMember(makePutRequest("m1", { firstName: "Bob", lastName: "Jones" }), { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.firstName).toBe("Bob");
    expect(body.lastName).toBe("Jones");

    expect(prisma.member.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "m1" },
      data: expect.objectContaining({ firstName: "Bob", lastName: "Jones" }),
    }));
  });

  it("updates role from MEMBER to ADMIN", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({ ...baseMember, role: "ADMIN", xeroContactId: null } as any);

    const res = await updateMember(makePutRequest("m1", { role: "ADMIN" }), { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(200);
    expect(prisma.member.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ role: "ADMIN" }),
    }));
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "admin.member.updated",
        actorMemberId: "admin1",
        subjectMemberId: "m1",
        category: "admin",
        severity: "critical",
        metadata: expect.objectContaining({
          changedFields: ["role"],
          accessChanges: [
            {
              field: "role",
              before: "MEMBER",
              after: "ADMIN",
            },
          ],
        }),
      }),
    });
  });

  it("updates finance access level", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...baseMember,
      financeAccessLevel: "MANAGER",
      xeroContactId: null,
    } as any);

    const res = await updateMember(
      makePutRequest("m1", { financeAccessLevel: "MANAGER" }),
      { params: Promise.resolve({ id: "m1" }) }
    );
    expect(res.status).toBe(200);
    expect(prisma.member.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ financeAccessLevel: "MANAGER" }),
      })
    );
  });

  it("forces finance access to NONE when updating a LODGE member", async () => {
    const lodgeMember = {
      ...baseMember,
      id: "lodge-1",
      role: "LODGE",
      financeAccessLevel: "VIEWER",
    };
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(lodgeMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...lodgeMember,
      firstName: "Lodge",
      financeAccessLevel: "NONE",
      xeroContactId: null,
    } as any);

    const res = await updateMember(
      makePutRequest("lodge-1", {
        firstName: "Lodge",
        financeAccessLevel: "MANAGER",
      }),
      { params: Promise.resolve({ id: "lodge-1" }) }
    );

    expect(res.status).toBe(200);
    expect(prisma.member.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "lodge-1" },
        data: expect.objectContaining({
          firstName: "Lodge",
          financeAccessLevel: "NONE",
        }),
      })
    );
  });

  it("sets forcePasswordChange to true", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({ ...baseMember, forcePasswordChange: true, xeroContactId: null } as any);

    const res = await updateMember(makePutRequest("m1", { forcePasswordChange: true }), { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(200);
    expect(prisma.member.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ forcePasswordChange: true }),
    }));
  });

  it("deactivates member successfully", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({ ...baseMember, active: false, xeroContactId: null } as any);

    const res = await updateMember(makePutRequest("m1", { active: false }), { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(200);
    // No cascade deactivation — family group model replaces parent/dependent
    expect(prisma.member.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "admin.member.deactivated",
        actorMemberId: "admin1",
        subjectMemberId: "m1",
        metadata: expect.objectContaining({
          changedFields: ["active"],
          accessChanges: [
            {
              field: "active",
              before: true,
              after: false,
            },
          ],
        }),
      }),
    });
  });

  it("clears dateOfBirth when empty string is passed", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({ ...baseMember, dateOfBirth: null, xeroContactId: null } as any);

    const res = await updateMember(makePutRequest("m1", { dateOfBirth: "" }), { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(200);
    expect(prisma.member.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ dateOfBirth: null }),
    }));
  });

  it("updates dateOfBirth and recomputes ageTier", async () => {
    const { computeAgeTier } = await import("@/lib/age-tier");
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({ ...baseMember, xeroContactId: null } as any);

    await updateMember(makePutRequest("m1", { dateOfBirth: "2010-06-15" }), { params: Promise.resolve({ id: "m1" }) });

    expect(computeAgeTier).toHaveBeenCalled();
    expect(prisma.member.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ dateOfBirth: new Date("2010-06-15"), ageTier: "ADULT" }),
    }));
  });

  it("trims whitespace from firstName and lastName", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({ ...baseMember, firstName: "Bob", lastName: "Jones", xeroContactId: null } as any);

    await updateMember(makePutRequest("m1", { firstName: "  Bob  ", lastName: "  Jones  " }), { params: Promise.resolve({ id: "m1" }) });

    expect(prisma.member.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ firstName: "Bob", lastName: "Jones" }),
    }));
  });

  it("calls updateXeroContact when member has xeroContactId and Xero is connected", async () => {
    const { isXeroConnected, updateXeroContact } = await import("@/lib/xero");
    vi.mocked(isXeroConnected).mockResolvedValue(true);

    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({ ...baseMember, firstName: "Bob", xeroContactId: "xc1" } as any);

    await updateMember(makePutRequest("m1", { firstName: "Bob" }), { params: Promise.resolve({ id: "m1" }) });

    expect(updateXeroContact).toHaveBeenCalledWith(
      "xc1",
      expect.objectContaining({ firstName: "Bob" }),
      expect.objectContaining({
        localModel: "Member",
        localId: "m1",
        createdByMemberId: "admin1",
      })
    );
  });

  it("does not call updateXeroContact when only local-only fields change", async () => {
    const {
      isXeroConnected,
      syncManagedXeroContactGroupForMember,
      updateXeroContact,
    } = await import("@/lib/xero");

    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({ ...baseMember, xeroContactId: "xc1" } as any);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...baseMember,
      role: "ADMIN",
      xeroContactId: "xc1",
    } as any);

    await updateMember(makePutRequest("m1", { role: "ADMIN" }), { params: Promise.resolve({ id: "m1" }) });

    expect(isXeroConnected).not.toHaveBeenCalled();
    expect(updateXeroContact).not.toHaveBeenCalled();
    expect(syncManagedXeroContactGroupForMember).not.toHaveBeenCalled();
  });

  it("does not call updateXeroContact when Xero is not connected", async () => {
    const {
      isXeroConnected,
      syncManagedXeroContactGroupForMember,
      updateXeroContact,
    } = await import("@/lib/xero");
    vi.mocked(isXeroConnected).mockResolvedValue(false);

    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(baseMember as any);
    vi.mocked(prisma.member.update).mockResolvedValue({ ...baseMember, xeroContactId: "xc1" } as any);

    await updateMember(makePutRequest("m1", { firstName: "Bob" }), { params: Promise.resolve({ id: "m1" }) });

    expect(updateXeroContact).not.toHaveBeenCalled();
    expect(syncManagedXeroContactGroupForMember).not.toHaveBeenCalled();
  });

  it("syncs managed Xero contact groups when the member age tier changes", async () => {
    const { isXeroConnected, syncManagedXeroContactGroupForMember } = await import("@/lib/xero");
    vi.mocked(isXeroConnected).mockResolvedValue(true);

    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      ...baseMember,
      xeroContactId: "xc1",
      ageTier: "CHILD",
    } as any);
    vi.mocked(prisma.member.update).mockResolvedValue({
      ...baseMember,
      xeroContactId: "xc1",
      ageTier: "YOUTH",
    } as any);

    await updateMember(makePutRequest("m1", { ageTier: "YOUTH" }), {
      params: Promise.resolve({ id: "m1" }),
    });

    expect(syncManagedXeroContactGroupForMember).toHaveBeenCalledWith("m1", {
      createdByMemberId: "admin1",
    });
  });

  it("blocks self-demotion via the API", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({ ...baseMember, id: "admin1", role: "ADMIN" } as any);

    const res = await updateMember(makePutRequest("admin1", { role: "MEMBER" }), { params: Promise.resolve({ id: "admin1" }) });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringMatching(/demote your own admin account/i),
    });
    expect(prisma.member.update).not.toHaveBeenCalled();
  });

  it("blocks self-deactivation via the API", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({ ...baseMember, id: "admin1", role: "ADMIN" } as any);

    const res = await updateMember(makePutRequest("admin1", { active: false }), { params: Promise.resolve({ id: "admin1" }) });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringMatching(/deactivate your own account/i),
    });
    expect(prisma.member.update).not.toHaveBeenCalled();
  });

  it("blocks disabling login for the current admin", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({ ...baseMember, id: "admin1", role: "ADMIN", canLogin: true } as any);

    const res = await updateMember(makePutRequest("admin1", { canLogin: false }), { params: Promise.resolve({ id: "admin1" }) });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringMatching(/disable login/i),
    });
    expect(prisma.member.update).not.toHaveBeenCalled();
  });

  // ── GET endpoint ──

  it("GET returns forcePasswordChange field", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      ...baseMember,
      forcePasswordChange: true,
      subscriptions: [],
      familyGroupMemberships: [],
    } as any);
    vi.mocked(prisma.booking.findMany).mockResolvedValue([]);
    vi.mocked(prisma.auditLog.findMany).mockResolvedValue([]);
    vi.mocked(prisma.booking.aggregate).mockResolvedValue({
      _sum: { finalPriceCents: null }, _count: 0, _max: { checkOut: null },
    } as any);

    const req = new NextRequest("http://localhost/api/admin/members/m1");
    const res = await getMemberDetail(req, { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.forcePasswordChange).toBe(true);
  });
});
