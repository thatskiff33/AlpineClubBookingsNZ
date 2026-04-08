import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    committeeMember: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { GET as listMembers, POST as createMember } from "@/app/api/admin/committee/route";
import { PUT as updateMember, DELETE as deleteMember } from "@/app/api/admin/committee/[id]/route";

const mockedAuth = vi.mocked(auth);

const adminSession = { user: { id: "admin1", role: "ADMIN" } } as any;
const memberSession = { user: { id: "m1", role: "MEMBER" } } as any;

const sampleMember = {
  id: "cm1",
  role: "President",
  name: "John Smith",
  phone: "+64 21 123 4567",
  email: "john@example.com",
  contactKey: "president",
  description: "Chairs meetings and oversees club operations.",
  sortOrder: 0,
  active: true,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

describe("Committee Admin API - GET /api/admin/committee", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns 403 for non-admin users", async () => {
    mockedAuth.mockResolvedValue(memberSession);
    const res = await listMembers();
    expect(res.status).toBe(403);
  });

  it("returns 403 for unauthenticated requests", async () => {
    mockedAuth.mockResolvedValue(null as any);
    const res = await listMembers();
    expect(res.status).toBe(403);
  });

  it("returns committee members for admin", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.committeeMember.findMany).mockResolvedValue([sampleMember] as any);

    const res = await listMembers();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.members).toHaveLength(1);
    expect(body.members[0].role).toBe("President");
    expect(body.members[0].name).toBe("John Smith");
  });

  it("returns empty array when no members exist", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.committeeMember.findMany).mockResolvedValue([]);

    const res = await listMembers();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.members).toHaveLength(0);
  });
});

describe("Committee Admin API - POST /api/admin/committee", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns 403 for non-admin users", async () => {
    mockedAuth.mockResolvedValue(memberSession);
    const req = new NextRequest("http://localhost/api/admin/committee", {
      method: "POST",
      body: JSON.stringify({ role: "President", name: "Test", phone: "+64", description: "Desc" }),
    });
    const res = await createMember(req);
    expect(res.status).toBe(403);
  });

  it("returns 400 for invalid input", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    const req = new NextRequest("http://localhost/api/admin/committee", {
      method: "POST",
      body: JSON.stringify({ role: "" }),
    });
    const res = await createMember(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    const req = new NextRequest("http://localhost/api/admin/committee", {
      method: "POST",
      body: "not json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await createMember(req);
    expect(res.status).toBe(400);
  });

  it("creates a committee member with valid data", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.committeeMember.create).mockResolvedValue(sampleMember as any);

    const req = new NextRequest("http://localhost/api/admin/committee", {
      method: "POST",
      body: JSON.stringify({
        role: "President",
        name: "John Smith",
        phone: "+64 21 123 4567",
        email: "john@example.com",
        contactKey: "president",
        description: "Chairs meetings and oversees club operations.",
        sortOrder: 0,
      }),
    });

    const res = await createMember(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.member.id).toBe("cm1");
    expect(prisma.committeeMember.create).toHaveBeenCalledOnce();
  });

  it("creates a member without optional fields", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    const noOptionals = { ...sampleMember, email: null, contactKey: null };
    vi.mocked(prisma.committeeMember.create).mockResolvedValue(noOptionals as any);

    const req = new NextRequest("http://localhost/api/admin/committee", {
      method: "POST",
      body: JSON.stringify({
        role: "Secretary",
        name: "Jane Doe",
        phone: "+64 21 999 8888",
        description: "Manages correspondence.",
      }),
    });

    const res = await createMember(req);
    expect(res.status).toBe(201);
    const createCall = vi.mocked(prisma.committeeMember.create).mock.calls[0][0];
    expect(createCall.data.email).toBeNull();
    expect(createCall.data.contactKey).toBeNull();
  });
});

describe("Committee Admin API - PUT /api/admin/committee/[id]", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const makeParams = (id: string) => Promise.resolve({ id });

  it("returns 403 for non-admin users", async () => {
    mockedAuth.mockResolvedValue(memberSession);
    const req = new NextRequest("http://localhost/api/admin/committee/cm1", {
      method: "PUT",
      body: JSON.stringify({ name: "Updated" }),
    });
    const res = await updateMember(req, { params: makeParams("cm1") });
    expect(res.status).toBe(403);
  });

  it("returns 404 for non-existent member", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.committeeMember.findUnique).mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/admin/committee/nope", {
      method: "PUT",
      body: JSON.stringify({ name: "Updated" }),
    });
    const res = await updateMember(req, { params: makeParams("nope") });
    expect(res.status).toBe(404);
  });

  it("updates committee member fields", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.committeeMember.findUnique).mockResolvedValue(sampleMember as any);
    vi.mocked(prisma.committeeMember.update).mockResolvedValue({
      ...sampleMember,
      name: "Updated Name",
      phone: "+64 22 000 0000",
    } as any);

    const req = new NextRequest("http://localhost/api/admin/committee/cm1", {
      method: "PUT",
      body: JSON.stringify({ name: "Updated Name", phone: "+64 22 000 0000" }),
    });
    const res = await updateMember(req, { params: makeParams("cm1") });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.member.name).toBe("Updated Name");
  });

  it("can toggle active status", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.committeeMember.findUnique).mockResolvedValue(sampleMember as any);
    vi.mocked(prisma.committeeMember.update).mockResolvedValue({
      ...sampleMember,
      active: false,
    } as any);

    const req = new NextRequest("http://localhost/api/admin/committee/cm1", {
      method: "PUT",
      body: JSON.stringify({ active: false }),
    });
    const res = await updateMember(req, { params: makeParams("cm1") });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.member.active).toBe(false);
  });

  it("returns 400 for invalid input", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    const req = new NextRequest("http://localhost/api/admin/committee/cm1", {
      method: "PUT",
      body: JSON.stringify({ email: "not-an-email" }),
    });
    const res = await updateMember(req, { params: makeParams("cm1") });
    expect(res.status).toBe(400);
  });
});

describe("Committee Admin API - DELETE /api/admin/committee/[id]", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const makeParams = (id: string) => Promise.resolve({ id });

  it("returns 403 for non-admin users", async () => {
    mockedAuth.mockResolvedValue(memberSession);
    const req = new NextRequest("http://localhost/api/admin/committee/cm1", { method: "DELETE" });
    const res = await deleteMember(req, { params: makeParams("cm1") });
    expect(res.status).toBe(403);
  });

  it("returns 404 for non-existent member", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.committeeMember.findUnique).mockResolvedValue(null);

    const req = new NextRequest("http://localhost/api/admin/committee/nope", { method: "DELETE" });
    const res = await deleteMember(req, { params: makeParams("nope") });
    expect(res.status).toBe(404);
  });

  it("deletes a committee member", async () => {
    mockedAuth.mockResolvedValue(adminSession);
    vi.mocked(prisma.committeeMember.findUnique).mockResolvedValue(sampleMember as any);
    vi.mocked(prisma.committeeMember.delete).mockResolvedValue(sampleMember as any);

    const req = new NextRequest("http://localhost/api/admin/committee/cm1", { method: "DELETE" });
    const res = await deleteMember(req, { params: makeParams("cm1") });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(prisma.committeeMember.delete).toHaveBeenCalledWith({ where: { id: "cm1" } });
  });
});

describe("Committee Public API - GET /api/committee", () => {
  it("returns only active members", async () => {
    const { GET } = await import("@/app/api/committee/route");
    vi.mocked(prisma.committeeMember.findMany).mockResolvedValue([
      { ...sampleMember, id: "cm1" },
      { ...sampleMember, id: "cm2", role: "Secretary", name: "Jane Doe" },
    ] as any);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.members).toHaveLength(2);

    // Verify the query filtered by active
    expect(prisma.committeeMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { active: true } })
    );
  });
});
