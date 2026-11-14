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
const mockRequireActiveSessionUser = vi.fn<(...args: unknown[]) => Promise<Response | null>>(async () => null);
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: (...args: Parameters<typeof mockRequireActiveSessionUser>) => mockRequireActiveSessionUser(...args),
}));
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
  sendAdminFamilyGroupRequestAlert: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import logger from "@/lib/logger";
import { POST as requestChild } from "@/app/api/members/family/request-child/route";
import { DATE_OF_BIRTH_INVALID_MESSAGE } from "@/lib/date-only-schema";

const mockedAuth = vi.mocked(auth);

const adultSession = { user: { id: "adult1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any;

function nextYearDateOnly() {
  return `${new Date().getUTCFullYear() + 1}-01-01`;
}

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

    const res = await requestChild(makeRequest({
      familyGroupId: "g1",
      firstName: "Sam",
      lastName: "Smith",
      dateOfBirth: "2018-03-15",
    }));
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

    const res = await requestChild(makeRequest({
      familyGroupId: "g1",
      firstName: "Sam",
      lastName: "Smith",
      dateOfBirth: "2018-03-15",
    }));
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

  it("rejects missing dateOfBirth", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    const res = await requestChild(makeRequest({
      familyGroupId: "g1", firstName: "Sam", lastName: "Smith",
    }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(JSON.stringify(body)).toMatch(/date/i);
  });

  // Caught at the schema (ALP-574), before the requester is even looked up:
  // a non-existent day such as Feb 31 never reaches the route's own
  // parseDateOnly NaN check.
  it("rejects impossible dateOfBirth", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    const res = await requestChild(makeRequest({
      familyGroupId: "g1", firstName: "Sam", lastName: "Smith", dateOfBirth: "2026-02-31",
    }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.details.dateOfBirth).toEqual([DATE_OF_BIRTH_INVALID_MESSAGE]);
    expect(prisma.member.findUnique).not.toHaveBeenCalled();
    expect(prisma.familyGroupJoinRequest.create).not.toHaveBeenCalled();
  });

  it("rejects future dateOfBirth", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    const res = await requestChild(makeRequest({
      familyGroupId: "g1", firstName: "Sam", lastName: "Smith", dateOfBirth: nextYearDateOnly(),
    }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/future/i);
  });

  it("rejects adult-tier dateOfBirth", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    const res = await requestChild(makeRequest({
      familyGroupId: "g1", firstName: "Sam", lastName: "Smith", dateOfBirth: "1990-03-15",
    }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/adult request flow/i);
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
        childDateOfBirth: new Date("2018-03-15T00:00:00.000Z"),
      }),
    });
  });

  // INV-PRIV-011 (#2683 review finding 3). This route logged
  // `childName: "${firstName} ${lastName}"` — a MINOR's full name, written on
  // an ordinary self-service success path rather than on an error path. The
  // audit row above still records it, where reading it needs the permission.
  it("does not log the child's name on the success path", async () => {
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
      familyGroupId: "g1", firstName: "Ravensworth", lastName: "Quillfeather", dateOfBirth: "2018-03-15",
    }));
    expect(res.status).toBe(201);

    const logged = JSON.stringify(vi.mocked(logger.info).mock.calls);
    expect(logged).not.toContain("Ravensworth");
    expect(logged).not.toContain("Quillfeather");
    // The request id is still logged, so the line still identifies the row.
    expect(logged).toContain("req1");
  });

  it("rejects duplicate pending request for same child", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "adult1", active: true, ageTier: "ADULT",
      familyGroupMemberships: [{ familyGroupId: "g1" }],
    } as any);
    vi.mocked(prisma.familyGroupJoinRequest.findFirst).mockResolvedValue({ id: "existing" } as any);

    const res = await requestChild(makeRequest({
      familyGroupId: "g1",
      firstName: "Sam",
      lastName: "Smith",
      dateOfBirth: "2018-03-15",
    }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/already pending/i);
  });

  it("returns 403 for inactive member", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    mockRequireActiveSessionUser.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Account is deactivated" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      })
    );

    const res = await requestChild(makeRequest({
      familyGroupId: "g1", firstName: "Sam", lastName: "Smith", dateOfBirth: "2018-03-15",
    }));
    expect(res.status).toBe(403);
  });
});
