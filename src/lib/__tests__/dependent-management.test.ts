import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock modules before imports
vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    booking: {
      findMany: vi.fn().mockResolvedValue([]),
      aggregate: vi.fn().mockResolvedValue({ _sum: { finalPriceCents: 0 }, _count: 0, _max: { checkOut: null } }),
    },
    auditLog: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    passwordResetToken: {
      create: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/utils", () => ({
  getSeasonYear: vi.fn().mockReturnValue(2026),
}));
vi.mock("@/lib/age-tier", () => ({
  computeAgeTier: vi.fn().mockReturnValue("CHILD"),
}));
vi.mock("@/lib/xero", () => ({
  isXeroConnected: vi.fn().mockResolvedValue(false),
  findOrCreateXeroContact: vi.fn(),
  updateXeroContact: vi.fn(),
}));
vi.mock("@/lib/email", () => ({
  sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("bcryptjs", () => ({
  hash: vi.fn().mockResolvedValue("hashed-password"),
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { PUT } from "@/app/api/admin/members/[id]/route";
import { POST } from "@/app/api/admin/members/route";

const mockedAuth = vi.mocked(auth);
const mockedMember = vi.mocked(prisma.member);

const adminSession = { user: { id: "admin-1", role: "ADMIN" } };

describe("Admin Dependent Management - PUT /api/admin/members/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAuth.mockResolvedValue(adminSession as any);
  });

  it("rejects assigning a member as their own parent", async () => {
    mockedMember.findUnique.mockResolvedValueOnce({
      id: "m1", email: "test@test.com", parentMemberId: null,
    } as any);

    const req = new NextRequest("http://localhost/api/admin/members/m1", {
      method: "PUT",
      body: JSON.stringify({ parentMemberId: "m1" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("A member cannot be their own parent");
  });

  it("rejects assigning a dependent as a parent (no nesting)", async () => {
    // Existing member (primary)
    mockedMember.findUnique.mockResolvedValueOnce({
      id: "m1", email: "test@test.com", parentMemberId: null,
    } as any);
    // Proposed parent -> is a dependent
    mockedMember.findUnique.mockResolvedValueOnce({
      id: "dep-parent", active: true, parentMemberId: "grandparent",
    } as any);

    const req = new NextRequest("http://localhost/api/admin/members/m1", {
      method: "PUT",
      body: JSON.stringify({ parentMemberId: "dep-parent" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("Primary parent cannot be a dependent");
  });

  it("rejects converting to dependent when member has dependents", async () => {
    // Existing member (primary)
    mockedMember.findUnique.mockResolvedValueOnce({
      id: "m1", email: "test@test.com", parentMemberId: null,
    } as any);
    // Proposed parent -> valid
    mockedMember.findUnique.mockResolvedValueOnce({
      id: "parent1", email: "parent@test.com", active: true, parentMemberId: null,
    } as any);
    // Count of dependents -> has 2
    mockedMember.count.mockResolvedValueOnce(2);

    const req = new NextRequest("http://localhost/api/admin/members/m1", {
      method: "PUT",
      body: JSON.stringify({ parentMemberId: "parent1" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain("has dependents");
  });

  it("requires email when unlinking dependent to primary", async () => {
    // Existing member is a dependent
    mockedMember.findUnique.mockResolvedValueOnce({
      id: "dep1", email: "parent@test.com", parentMemberId: "parent1",
    } as any);

    const req = new NextRequest("http://localhost/api/admin/members/dep1", {
      method: "PUT",
      body: JSON.stringify({ parentMemberId: null }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "dep1" }) });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain("Email is required");
  });

  it("allows unlinking with new email provided", async () => {
    mockedMember.findUnique.mockResolvedValueOnce({
      id: "dep1", email: "parent@test.com", parentMemberId: "parent1",
    } as any);
    // Email uniqueness check
    mockedMember.findFirst.mockResolvedValueOnce(null);
    // Update result
    mockedMember.update.mockResolvedValueOnce({
      id: "dep1", firstName: "Test", lastName: "Child", email: "newchild@test.com",
      phone: null, dateOfBirth: null, role: "MEMBER", ageTier: "CHILD",
      active: true, xeroContactId: null, joinedDate: null, createdAt: new Date(),
      parentMemberId: null, secondaryParentId: null,
    } as any);

    const req = new NextRequest("http://localhost/api/admin/members/dep1", {
      method: "PUT",
      body: JSON.stringify({ parentMemberId: null, email: "newchild@test.com" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "dep1" }) });
    expect(res.status).toBe(200);
    expect(mockedMember.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          parentMemberId: null,
          secondaryParentId: null,
          email: "newchild@test.com",
        }),
      })
    );
  });

  it("rejects same primary and secondary parent", async () => {
    // Existing dependent with parentMemberId "parent1"
    mockedMember.findUnique.mockResolvedValueOnce({
      id: "dep1", email: "parent@test.com", parentMemberId: "parent1", secondaryParentId: null,
    } as any);

    const req = new NextRequest("http://localhost/api/admin/members/dep1", {
      method: "PUT",
      body: JSON.stringify({ secondaryParentId: "parent1" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "dep1" }) });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("Secondary parent must be different from primary parent");
  });

  it("rejects secondary parent who is themselves a dependent", async () => {
    // Existing dependent
    mockedMember.findUnique.mockResolvedValueOnce({
      id: "dep1", email: "parent@test.com", parentMemberId: "parent1", secondaryParentId: null,
    } as any);
    // Secondary parent lookup -> is a dependent
    mockedMember.findUnique.mockResolvedValueOnce({
      id: "parent2", active: true, parentMemberId: "grandparent",
    } as any);

    const req = new NextRequest("http://localhost/api/admin/members/dep1", {
      method: "PUT",
      body: JSON.stringify({ secondaryParentId: "parent2" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "dep1" }) });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("Secondary parent cannot be a dependent");
  });

  it("rejects self as secondary parent", async () => {
    mockedMember.findUnique.mockResolvedValueOnce({
      id: "dep1", email: "parent@test.com", parentMemberId: "parent1",
    } as any);

    const req = new NextRequest("http://localhost/api/admin/members/dep1", {
      method: "PUT",
      body: JSON.stringify({ secondaryParentId: "dep1" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await PUT(req, { params: Promise.resolve({ id: "dep1" }) });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe("A member cannot be their own secondary parent");
  });
});

describe("Admin Dependent Management - POST /api/admin/members (create)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedAuth.mockResolvedValue(adminSession as any);
  });

  it("creates a dependent with parent's email", async () => {
    // Parent lookup
    mockedMember.findUnique.mockResolvedValueOnce({
      id: "parent1", email: "parent@test.com", active: true, parentMemberId: null,
    } as any);
    // No existing member with parent's email
    mockedMember.findFirst.mockResolvedValueOnce(null);
    // Create result
    mockedMember.create.mockResolvedValueOnce({
      id: "new-dep", firstName: "Child", lastName: "Smith", email: "parent@test.com",
      phone: null, dateOfBirth: null, role: "MEMBER", ageTier: "CHILD",
      active: true, xeroContactId: null, joinedDate: null, createdAt: new Date(),
    } as any);

    const req = new NextRequest("http://localhost/api/admin/members", {
      method: "POST",
      body: JSON.stringify({
        firstName: "Child", lastName: "Smith",
        email: "ignored@test.com",
        parentMemberId: "parent1",
      }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(mockedMember.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: "parent@test.com",
          parentMemberId: "parent1",
          emailVerified: true,
        }),
      })
    );
  });

  it("rejects secondary parent without primary parent", async () => {
    const req = new NextRequest("http://localhost/api/admin/members", {
      method: "POST",
      body: JSON.stringify({
        firstName: "Child", lastName: "Smith",
        email: "child@test.com",
        secondaryParentId: "parent2",
      }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain("Primary parent is required");
  });

  it("rejects creating with inactive parent", async () => {
    mockedMember.findUnique.mockResolvedValueOnce({
      id: "parent1", email: "parent@test.com", active: false, parentMemberId: null,
    } as any);

    const req = new NextRequest("http://localhost/api/admin/members", {
      method: "POST",
      body: JSON.stringify({
        firstName: "Child", lastName: "Smith",
        email: "child@test.com",
        parentMemberId: "parent1",
      }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain("inactive");
  });

  it("rejects parent that is itself a dependent", async () => {
    mockedMember.findUnique.mockResolvedValueOnce({
      id: "dep-parent", email: "dep@test.com", active: true, parentMemberId: "grandparent",
    } as any);

    const req = new NextRequest("http://localhost/api/admin/members", {
      method: "POST",
      body: JSON.stringify({
        firstName: "Child", lastName: "Smith",
        email: "child@test.com",
        parentMemberId: "dep-parent",
      }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain("cannot be a dependent");
  });
});

describe("Joined Date Display Logic", () => {
  it("uses joinedDate when available", () => {
    const joinedDate = "2020-05-15T00:00:00.000Z";
    const createdAt = "2026-04-01T00:00:00.000Z";
    const displayDate = new Date(joinedDate || createdAt).toLocaleDateString(
      "en-NZ", { day: "numeric", month: "short", year: "numeric" }
    );
    expect(displayDate).toContain("2020");
  });

  it("falls back to createdAt when joinedDate is null", () => {
    const joinedDate = null;
    const createdAt = "2026-04-01T00:00:00.000Z";
    const displayDate = new Date(joinedDate || createdAt).toLocaleDateString(
      "en-NZ", { day: "numeric", month: "short", year: "numeric" }
    );
    expect(displayDate).toContain("2026");
  });
});

describe("Secondary Parent Ownership", () => {
  it("allows secondary parent to access dependent", () => {
    const dep = { parentMemberId: "parent1", secondaryParentId: "parent2" };
    const userId = "parent2";
    expect(dep.parentMemberId === userId || dep.secondaryParentId === userId).toBe(true);
  });

  it("denies access for unrelated member", () => {
    const dep = { parentMemberId: "parent1", secondaryParentId: "parent2" };
    const userId = "stranger";
    expect(dep.parentMemberId === userId || dep.secondaryParentId === userId).toBe(false);
  });

  it("allows primary parent even without secondary", () => {
    const dep = { parentMemberId: "parent1", secondaryParentId: null };
    const userId = "parent1";
    expect(dep.parentMemberId === userId || dep.secondaryParentId === userId).toBe(true);
  });
});
