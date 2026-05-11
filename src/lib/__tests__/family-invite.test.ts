import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { count: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
    familyGroup: { findUnique: vi.fn() },
    familyGroupJoinRequest: { findFirst: vi.fn(), create: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    familyGroupMember: { upsert: vi.fn() },
    $transaction: vi.fn(),
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
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn().mockReturnValue(null),
  rateLimiters: { familyGroupJoinRequest: {} },
}));
vi.mock("@/lib/email", () => ({
  sendFamilyGroupInvitationEmail: vi.fn().mockResolvedValue(undefined),
  sendFamilyGroupInviteAcceptedEmail: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { POST as inviteMember } from "@/app/api/members/family/invite/route";
import { GET as getInvitations, PUT as respondInvitation } from "@/app/api/members/family/invitations/route";

const mockedAuth = vi.mocked(auth);

const adultSession = { user: { id: "adult1", role: "MEMBER" } } as any;
const inviteeSession = { user: { id: "adult2", role: "MEMBER" } } as any;

function makePostRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/members/family/invite", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function makePutRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/members/family/invitations", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("POST /api/members/family/invite", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns 401 for unauthenticated requests", async () => {
    mockedAuth.mockResolvedValue(null as any);
    const res = await inviteMember(makePostRequest({ email: "test@test.com", familyGroupId: "g1" }));
    expect(res.status).toBe(401);
  });

  it("rejects non-adult inviters", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "adult1", active: true, ageTier: "YOUTH", canLogin: false,
      familyGroupMemberships: [{ familyGroupId: "g1" }],
    } as any);

    const res = await inviteMember(makePostRequest({ email: "bob@test.com", familyGroupId: "g1" }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/only adults/i);
  });

  it("rejects if inviter not in the specified group", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "adult1", active: true, ageTier: "ADULT", canLogin: true,
      familyGroupMemberships: [],
    } as any);

    const res = await inviteMember(makePostRequest({ email: "bob@test.com", familyGroupId: "g1" }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/not a member/i);
  });

  it("returns clear error when invitee email not found", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "adult1", active: true, ageTier: "ADULT", canLogin: true,
      familyGroupMemberships: [{ familyGroupId: "g1" }],
    } as any);
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null);

    const res = await inviteMember(makePostRequest({ email: "nonmember@test.com", familyGroupId: "g1" }));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not a registered member/i);
    expect(body.error).toMatch(/membership process/i);
  });

  it("rejects inviting self", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "adult1", active: true, ageTier: "ADULT", canLogin: true,
      familyGroupMemberships: [{ familyGroupId: "g1" }],
    } as any);
    vi.mocked(prisma.member.findFirst).mockResolvedValue({
      id: "adult1", ageTier: "ADULT", familyGroupMemberships: [],
    } as any);

    const res = await inviteMember(makePostRequest({ email: "me@test.com", familyGroupId: "g1" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/yourself/i);
  });

  it("rejects inviting an infant/child/youth directly", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "adult1", active: true, ageTier: "ADULT", canLogin: true,
      familyGroupMemberships: [{ familyGroupId: "g1" }],
    } as any);
    vi.mocked(prisma.member.findFirst).mockResolvedValue({
      id: "child1", ageTier: "CHILD", familyGroupMemberships: [],
    } as any);

    const res = await inviteMember(makePostRequest({ email: "child@test.com", familyGroupId: "g1" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/infants, children, or youth/i);
  });

  it("rejects if target already in group", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "adult1", active: true, ageTier: "ADULT", canLogin: true,
      familyGroupMemberships: [{ familyGroupId: "g1" }],
    } as any);
    vi.mocked(prisma.member.findFirst).mockResolvedValue({
      id: "adult2", ageTier: "ADULT", familyGroupMemberships: [{ familyGroupId: "g1" }],
    } as any);

    const res = await inviteMember(makePostRequest({ email: "bob@test.com", familyGroupId: "g1" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/already in/i);
  });

  it("creates invitation successfully", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "adult1", active: true, ageTier: "ADULT", canLogin: true,
      familyGroupMemberships: [{ familyGroupId: "g1" }],
    } as any);
    vi.mocked(prisma.member.findFirst).mockResolvedValue({
      id: "adult2", firstName: "Bob", lastName: "Jones", ageTier: "ADULT",
      familyGroupMemberships: [],
    } as any);
    vi.mocked(prisma.familyGroupJoinRequest.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.familyGroupJoinRequest.create).mockResolvedValue({ id: "inv1" } as any);
    vi.mocked(prisma.familyGroup.findUnique).mockResolvedValue({ name: "Test Family" } as any);

    const res = await inviteMember(makePostRequest({ email: "bob@test.com", familyGroupId: "g1" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.invitationId).toBe("inv1");
    expect(body.message).toMatch(/Bob Jones/);

    expect(prisma.familyGroupJoinRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        familyGroupId: "g1",
        requesterId: "adult1",
        type: "ADULT_INVITE",
        invitedMemberId: "adult2",
      }),
    });
  });

  it("rejects duplicate pending invitation", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "adult1", active: true, ageTier: "ADULT", canLogin: true,
      familyGroupMemberships: [{ familyGroupId: "g1" }],
    } as any);
    vi.mocked(prisma.member.findFirst).mockResolvedValue({
      id: "adult2", ageTier: "ADULT", familyGroupMemberships: [],
    } as any);
    vi.mocked(prisma.familyGroupJoinRequest.findFirst).mockResolvedValue({ id: "existing" } as any);

    const res = await inviteMember(makePostRequest({ email: "bob@test.com", familyGroupId: "g1" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/already pending/i);
  });
});

describe("GET /api/members/family/invitations", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("returns pending invitations for the user", async () => {
    mockedAuth.mockResolvedValue(inviteeSession);
    vi.mocked(prisma.familyGroupJoinRequest.findMany).mockResolvedValue([
      {
        id: "inv1", type: "ADULT_INVITE", status: "PENDING",
        familyGroup: { id: "g1", name: "Smith Family" },
        requester: { id: "adult1", firstName: "Alice", lastName: "Smith" },
      },
    ] as any);

    const res = await getInvitations();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.invitations).toHaveLength(1);
    expect(body.invitations[0].familyGroup.name).toBe("Smith Family");
  });
});

describe("PUT /api/members/family/invitations", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("accepts an invitation and adds member to group", async () => {
    mockedAuth.mockResolvedValue(inviteeSession);
    vi.mocked(prisma.familyGroupJoinRequest.findFirst).mockResolvedValue({
      id: "inv1", familyGroupId: "g1", invitedMemberId: "adult2",
      type: "ADULT_INVITE", status: "PENDING",
      familyGroup: { id: "g1", name: "Smith Family" },
      requester: { id: "adult1", firstName: "Jane", lastName: "Doe", email: "jane@test.com" },
    } as any);
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
      const tx = {
        familyGroupMember: { upsert: vi.fn() },
        familyGroupJoinRequest: { update: vi.fn() },
      };
      return fn(tx);
    });
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      firstName: "Bob", lastName: "Smith",
    } as any);

    const res = await respondInvitation(makePutRequest({ invitationId: "inv1", action: "accept" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toMatch(/joined.*Smith Family/i);
  });

  it("declines an invitation", async () => {
    mockedAuth.mockResolvedValue(inviteeSession);
    vi.mocked(prisma.familyGroupJoinRequest.findFirst).mockResolvedValue({
      id: "inv1", familyGroupId: "g1", invitedMemberId: "adult2",
      type: "ADULT_INVITE", status: "PENDING",
      familyGroup: { id: "g1", name: "Smith Family" },
    } as any);
    vi.mocked(prisma.familyGroupJoinRequest.update).mockResolvedValue({} as any);

    const res = await respondInvitation(makePutRequest({ invitationId: "inv1", action: "decline" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toMatch(/declined/i);

    expect(prisma.familyGroupJoinRequest.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "REJECTED" }),
    }));
  });

  it("returns 404 for non-existent invitation", async () => {
    mockedAuth.mockResolvedValue(inviteeSession);
    vi.mocked(prisma.familyGroupJoinRequest.findFirst).mockResolvedValue(null);

    const res = await respondInvitation(makePutRequest({ invitationId: "nonexistent", action: "accept" }));
    expect(res.status).toBe(404);
  });
});
