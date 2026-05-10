import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  memberApplicationFindMany: vi.fn(),
  memberApplicationCount: vi.fn(),
  memberFindMany: vi.fn(),
  parseApplicationAddress: vi.fn(),
  parseApplicationFamilyMembers: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    memberApplication: {
      findMany: mocks.memberApplicationFindMany,
      count: mocks.memberApplicationCount,
    },
    member: {
      findMany: mocks.memberFindMany,
    },
  },
}));

vi.mock("@/lib/nomination", () => ({
  parseApplicationAddress: mocks.parseApplicationAddress,
  parseApplicationFamilyMembers: mocks.parseApplicationFamilyMembers,
}));

import { GET } from "@/app/api/admin/member-applications/route";

describe("GET /api/admin/member-applications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN" },
    });
    mocks.requireActiveSessionUser.mockResolvedValue(null);
    mocks.memberApplicationFindMany.mockResolvedValue([]);
    mocks.memberApplicationCount.mockResolvedValue(0);
    mocks.memberFindMany.mockResolvedValue([]);
    mocks.parseApplicationAddress.mockImplementation((value) => value);
    mocks.parseApplicationFamilyMembers.mockImplementation((value) => value);
  });

  it("blocks deactivated admin sessions", async () => {
    mocks.requireActiveSessionUser.mockResolvedValue(
      NextResponse.json({ error: "Account is deactivated" }, { status: 403 })
    );

    const response = await GET(
      new NextRequest("http://localhost/api/admin/member-applications")
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Account is deactivated",
    });
    expect(mocks.memberApplicationFindMany).not.toHaveBeenCalled();
  });

  it("returns an empty queue for active admins", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/admin/member-applications")
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      data: [],
      applications: [],
      pendingCount: 0,
      page: 1,
      pageSize: 25,
      total: 0,
    });
    expect(mocks.requireActiveSessionUser).toHaveBeenCalledWith("admin-1");
    expect(mocks.memberApplicationFindMany).toHaveBeenCalledWith({
      orderBy: { createdAt: "desc" },
      where: undefined,
      take: 25,
      skip: 0,
    });
    expect(mocks.memberApplicationCount).toHaveBeenCalledWith({ where: undefined });
    expect(mocks.memberApplicationCount).toHaveBeenCalledWith({
      where: { status: "PENDING_ADMIN" },
    });
    expect(mocks.memberFindMany).not.toHaveBeenCalled();
  });
});
