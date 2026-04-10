import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { count: vi.fn(), findUnique: vi.fn() },
    familyGroup: { findUnique: vi.fn() },
    familyGroupJoinRequest: { findFirst: vi.fn(), create: vi.fn() },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn().mockReturnValue(null),
  rateLimiters: { familyGroupJoinRequest: {} },
}));
vi.mock("@/lib/email", () => ({
  sendChildRequestSubmittedEmail: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { POST as requestChild } from "@/app/api/members/family/request-child/route";

const mockedAuth = vi.mocked(auth);

const adultSession = { user: { id: "adult1", role: "MEMBER" } } as any;

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/members/family/request-child", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("POST /api/members/family/request-child", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns 401 for unauthenticated requests", async () => {
    mockedAuth.mockResolvedValue(null as any);
    const res = await requestChild(makeRequest({ familyGroupId: "g1", firstName: "Sam", lastName: "Smith" }));
    expect(res.status).toBe(401);
  });

  it("rejects non-adult requesters", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "adult1", active: true, ageTier: "YOUTH",
      familyGroupMemberships: [{ familyGroupId: "g1" }],
    } as any);

    const res = await requestChild(makeRequest({ familyGroupId: "g1", firstName: "Sam", lastName: "Smith" }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/only adults/i);
  });

  it("rejects if requester not in the specified group", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "adult1", active: true, ageTier: "ADULT",
      familyGroupMemberships: [],
    } as any);

    const res = await requestChild(makeRequest({ familyGroupId: "g1", firstName: "Sam", lastName: "Smith" }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/not a member/i);
  });

  it("validates required fields", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    const res = await requestChild(makeRequest({ familyGroupId: "g1" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/validation/i);
  });

  it("validates dateOfBirth format", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    const res = await requestChild(makeRequest({
      familyGroupId: "g1", firstName: "Sam", lastName: "Smith", dateOfBirth: "not-a-date",
    }));
    expect(res.status).toBe(422);
  });

  it("creates child request successfully", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique)
      .mockResolvedValueOnce({
        id: "adult1", firstName: "Alice", lastName: "Smith", active: true, ageTier: "ADULT",
        familyGroupMemberships: [{ familyGroupId: "g1" }],
      } as any)
      .mockResolvedValueOnce({ email: "alice@test.com" } as any);
    vi.mocked(prisma.familyGroupJoinRequest.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.familyGroupJoinRequest.create).mockResolvedValue({ id: "req1" } as any);
    vi.mocked(prisma.familyGroup.findUnique).mockResolvedValue({ name: "Smith Family" } as any);

    const res = await requestChild(makeRequest({
      familyGroupId: "g1", firstName: "Sam", lastName: "Smith", dateOfBirth: "2018-03-15",
    }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.requestId).toBe("req1");
    expect(body.message).toMatch(/admin/i);

    expect(prisma.familyGroupJoinRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        familyGroupId: "g1",
        requesterId: "adult1",
        type: "CHILD_REQUEST",
        childFirstName: "Sam",
        childLastName: "Smith",
      }),
    });
  });

  it("creates child request without dateOfBirth", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique)
      .mockResolvedValueOnce({
        id: "adult1", firstName: "Alice", lastName: "Smith", active: true, ageTier: "ADULT",
        familyGroupMemberships: [{ familyGroupId: "g1" }],
      } as any)
      .mockResolvedValueOnce({ email: "alice@test.com" } as any);
    vi.mocked(prisma.familyGroupJoinRequest.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.familyGroupJoinRequest.create).mockResolvedValue({ id: "req2" } as any);
    vi.mocked(prisma.familyGroup.findUnique).mockResolvedValue({ name: "Smith Family" } as any);

    const res = await requestChild(makeRequest({
      familyGroupId: "g1", firstName: "Jamie", lastName: "Smith",
    }));
    expect(res.status).toBe(201);

    expect(prisma.familyGroupJoinRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        childDateOfBirth: null,
      }),
    });
  });

  it("rejects duplicate pending request for same child", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "adult1", active: true, ageTier: "ADULT",
      familyGroupMemberships: [{ familyGroupId: "g1" }],
    } as any);
    vi.mocked(prisma.familyGroupJoinRequest.findFirst).mockResolvedValue({ id: "existing" } as any);

    const res = await requestChild(makeRequest({
      familyGroupId: "g1", firstName: "Sam", lastName: "Smith",
    }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/already pending/i);
  });

  it("returns 404 for inactive member", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(null);

    const res = await requestChild(makeRequest({
      familyGroupId: "g1", firstName: "Sam", lastName: "Smith",
    }));
    expect(res.status).toBe(404);
  });
});
