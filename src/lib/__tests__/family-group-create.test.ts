import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { count: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
    familyGroup: { create: vi.fn(), findUnique: vi.fn() },
    familyGroupJoinRequest: { findFirst: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
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
  sendGroupCreateRequestConfirmationEmail: vi.fn().mockResolvedValue(undefined),
  sendAdminFamilyGroupRequestAlert: vi.fn().mockResolvedValue(undefined),
  sendPartnerInviteEmail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/member-partner-link", () => ({
  requestPartnerLink: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { applyRateLimit } from "@/lib/rate-limit";
import {
  sendGroupCreateRequestConfirmationEmail,
  sendAdminFamilyGroupRequestAlert,
  sendPartnerInviteEmail,
} from "@/lib/email";
import { requestPartnerLink } from "@/lib/member-partner-link";
import { POST as createGroup } from "@/app/api/members/family/create-group/route";
import { DATE_OF_BIRTH_INVALID_MESSAGE } from "@/lib/date-only-schema";

const mockedAuth = vi.mocked(auth);

const adultSession = { user: { id: "adult1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any;

const CHILD_DOB = "2018-03-15";
const ADULT_DOB = "1990-03-15";

function groupLessRequester(overrides: Record<string, unknown> = {}) {
  return {
    id: "adult1",
    firstName: "Alice",
    lastName: "Smith",
    email: "alice@test.com",
    active: true,
    canLogin: true,
    ageTier: "ADULT",
    familyGroupMemberships: [],
    ...overrides,
  };
}

function nextYearDateOnly() {
  return `${new Date().getUTCFullYear() + 1}-01-01`;
}

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/members/family/create-group", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

/** Wire the transaction mock: memberless group + sequential request rows. */
function mockTransaction() {
  const txGroupCreate = vi.fn().mockImplementation(async ({ data }: any) => ({
    id: "fg-new",
    ...data,
  }));
  let requestCounter = 0;
  const txRequestCreate = vi.fn().mockImplementation(async ({ data }: any) => ({
    id: `req-${++requestCounter}`,
    ...data,
  }));
  const txPartnerInviteCreate = vi.fn().mockResolvedValue({ id: "pit-1" });
  vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) =>
    fn({
      familyGroup: { create: txGroupCreate },
      familyGroupJoinRequest: { create: txRequestCreate },
      partnerInviteToken: { create: txPartnerInviteCreate },
    })
  );
  return { txGroupCreate, txRequestCreate, txPartnerInviteCreate };
}

describe("POST /api/members/family/create-group", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(applyRateLimit).mockResolvedValue(null as any);
  });

  it("returns 401 for unauthenticated requests", async () => {
    mockedAuth.mockResolvedValue(null as any);
    const res = await createGroup(makeRequest({}));
    expect(res.status).toBe(401);
  });

  it("returns 403 for inactive member (session guard)", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    mockRequireActiveSessionUser.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Account is deactivated" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      })
    );

    const res = await createGroup(makeRequest({}));
    expect(res.status).toBe(403);
  });

  it("returns the rate-limit response when the bucket rejects", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(applyRateLimit).mockResolvedValueOnce(
      NextResponse.json({ error: "Too many requests" }, { status: 429 }) as any
    );

    const res = await createGroup(makeRequest({}));
    expect(res.status).toBe(429);
    expect(prisma.member.findUnique).not.toHaveBeenCalled();
  });

  it("rejects non-adult requesters", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(
      groupLessRequester({ ageTier: "YOUTH" }) as any
    );

    const res = await createGroup(makeRequest({}));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/only adults/i);
  });

  it("rejects requesters without a login account", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(
      groupLessRequester({ canLogin: false }) as any
    );

    const res = await createGroup(makeRequest({}));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/login accounts/i);
  });

  it("rejects requesters already in a family group", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(
      groupLessRequester({ familyGroupMemberships: [{ familyGroupId: "g1" }] }) as any
    );

    const res = await createGroup(makeRequest({}));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/already in a family group/i);
  });

  it("rejects when a GROUP_CREATE request is already pending", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(groupLessRequester() as any);
    vi.mocked(prisma.familyGroupJoinRequest.findFirst).mockResolvedValue({
      id: "existing",
      type: "GROUP_CREATE",
    } as any);

    const res = await createGroup(makeRequest({}));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/pending family group creation request/i);
  });

  it("rejects when a JOIN_REQUEST is already pending", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(groupLessRequester() as any);
    vi.mocked(prisma.familyGroupJoinRequest.findFirst).mockResolvedValue({
      id: "existing",
      type: "JOIN_REQUEST",
    } as any);

    const res = await createGroup(makeRequest({}));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/pending join request/i);
  });

  it("mints a partner-invite token and succeeds for an unregistered partner (#1682)", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(groupLessRequester() as any);
    vi.mocked(prisma.familyGroupJoinRequest.findFirst).mockResolvedValue(null);
    // No registered member matches the partner email.
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
    const { txRequestCreate, txPartnerInviteCreate } = mockTransaction();

    const res = await createGroup(makeRequest({ partnerEmail: "Ghost@Test.com" }));

    // Same 201 success as the registered-adult path — no membership-status leak.
    expect(res.status).toBe(201);

    // GROUP_CREATE carries no invitedMemberId for an unregistered partner.
    expect(txRequestCreate).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({ type: "GROUP_CREATE", invitedMemberId: null }),
    });

    // A single-use, hashed token row is created for the normalised email.
    expect(txPartnerInviteCreate).toHaveBeenCalledTimes(1);
    const tokenData = txPartnerInviteCreate.mock.calls[0][0].data;
    expect(tokenData.invitedEmail).toBe("ghost@test.com");
    expect(tokenData.familyGroupId).toBe("fg-new");
    expect(tokenData.createdById).toBe("adult1");
    expect(tokenData.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(tokenData).not.toHaveProperty("token");

    // The invite email is sent to the unregistered address with the raw token.
    expect(sendPartnerInviteEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "ghost@test.com",
        inviterName: "Alice Smith",
        token: expect.stringMatching(/^[a-f0-9]{64}$/),
      })
    );

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "FAMILY_GROUP_CREATE_REQUESTED",
        metadata: expect.objectContaining({
          partnerMemberId: null,
          partnerInviteEmail: "ghost@test.com",
        }),
      })
    );
  });

  const UNIFORM_201_BODY = {
    message: "Request submitted. An admin will review your new family group.",
    requestId: "req-1",
    familyGroupId: "fg-new",
    childRequestIds: [] as string[],
  };

  it("returns a uniform 201 with no token/email for a registered non-adult partner", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(groupLessRequester() as any);
    vi.mocked(prisma.familyGroupJoinRequest.findFirst).mockResolvedValue(null);
    // Active login member, but not an adult → ineligible; no probe differential.
    vi.mocked(prisma.member.findFirst).mockResolvedValue({
      id: "youth1",
      firstName: "Kid",
      lastName: "Smith",
      ageTier: "YOUTH",
    } as any);
    const { txRequestCreate, txPartnerInviteCreate } = mockTransaction();

    const res = await createGroup(makeRequest({ partnerEmail: "kid@test.com" }));
    expect(res.status).toBe(201);
    // Byte-identical to the other 201 paths.
    expect(await res.json()).toEqual(UNIFORM_201_BODY);
    // No invite token, no invite email; GROUP_CREATE carries no invitedMemberId
    // but does note the ineligible partner for the reviewing admin.
    expect(txPartnerInviteCreate).not.toHaveBeenCalled();
    expect(sendPartnerInviteEmail).not.toHaveBeenCalled();
    expect(txRequestCreate).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        type: "GROUP_CREATE",
        invitedMemberId: null,
        requestNotes: expect.stringContaining("kid@test.com"),
      }),
    });
  });

  it("returns a uniform 201 with no token/email for an inactive/non-login member email", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(groupLessRequester() as any);
    vi.mocked(prisma.familyGroupJoinRequest.findFirst).mockResolvedValue(null);
    // No active-login member matches, but a member row exists (deactivated,
    // non-login, or a dependent). Must NOT mint a dead-end token, and must not
    // differ observably from the unregistered path.
    vi.mocked(prisma.member.findFirst)
      .mockResolvedValueOnce(null as any)
      .mockResolvedValueOnce({ id: "inactive1" } as any);
    const { txPartnerInviteCreate } = mockTransaction();

    const res = await createGroup(makeRequest({ partnerEmail: "deactivated@test.com" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual(UNIFORM_201_BODY);
    expect(txPartnerInviteCreate).not.toHaveBeenCalled();
    expect(sendPartnerInviteEmail).not.toHaveBeenCalled();
  });

  it("rejects the requester naming themselves as partner", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(groupLessRequester() as any);
    vi.mocked(prisma.familyGroupJoinRequest.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.member.findFirst).mockResolvedValue({
      id: "adult1",
      firstName: "Alice",
      lastName: "Smith",
      ageTier: "ADULT",
    } as any);

    const res = await createGroup(makeRequest({ partnerEmail: "alice@test.com" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/yourself/i);
  });

  // Caught at the schema (ALP-574), before any member/request lookup: a
  // non-existent day such as Feb 31 never reaches the route's own
  // parseDateOnly NaN check, let alone `prisma.$transaction`.
  it("rejects an impossible child date of birth", async () => {
    mockedAuth.mockResolvedValue(adultSession);

    const res = await createGroup(
      makeRequest({
        children: [{ firstName: "Sam", lastName: "Smith", dateOfBirth: "2026-02-31" }],
      })
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.details.children).toEqual([DATE_OF_BIRTH_INVALID_MESSAGE]);
    expect(prisma.member.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("requires a child date of birth rather than accepting an empty string (ALP-574)", async () => {
    mockedAuth.mockResolvedValue(adultSession);

    const res = await createGroup(
      makeRequest({
        children: [{ firstName: "Sam", lastName: "Smith", dateOfBirth: "" }],
      })
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.details.children).toEqual(["Date of birth is required"]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects a future child date of birth", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(groupLessRequester() as any);
    vi.mocked(prisma.familyGroupJoinRequest.findFirst).mockResolvedValue(null);

    const res = await createGroup(
      makeRequest({
        children: [{ firstName: "Sam", lastName: "Smith", dateOfBirth: nextYearDateOnly() }],
      })
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/future/i);
  });

  it("rejects a child date of birth computing to the adult tier", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(groupLessRequester() as any);
    vi.mocked(prisma.familyGroupJoinRequest.findFirst).mockResolvedValue(null);

    const res = await createGroup(
      makeRequest({
        children: [{ firstName: "Sam", lastName: "Smith", dateOfBirth: ADULT_DOB }],
      })
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/adult request flow/i);
  });

  it("rejects more than 6 children", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    const child = { firstName: "Sam", lastName: "Smith", dateOfBirth: CHILD_DOB };
    const res = await createGroup(makeRequest({ children: Array(7).fill(child) }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/validation/i);
  });

  it("rejects duplicate child rows within one submission (case-insensitive)", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(groupLessRequester() as any);
    vi.mocked(prisma.familyGroupJoinRequest.findFirst).mockResolvedValue(null);

    const res = await createGroup(
      makeRequest({
        children: [
          { firstName: "Sam", lastName: "Smith", dateOfBirth: CHILD_DOB },
          { firstName: "sam", lastName: "SMITH", dateOfBirth: CHILD_DOB },
        ],
      })
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/already included in this submission/i);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("creates memberless group + GROUP_CREATE + child requests in one transaction", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(groupLessRequester() as any);
    vi.mocked(prisma.familyGroupJoinRequest.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.member.findFirst).mockResolvedValue({
      id: "partner1",
      firstName: "Bob",
      lastName: "Jones",
      ageTier: "ADULT",
    } as any);
    const { txGroupCreate, txRequestCreate } = mockTransaction();

    const res = await createGroup(
      makeRequest({
        groupName: "Adventure Family",
        partnerEmail: "Bob@Test.com",
        children: [
          { firstName: "Sam", lastName: "Smith", dateOfBirth: CHILD_DOB },
          { firstName: "Pip", lastName: "Smith", dateOfBirth: "2020-06-01" },
        ],
      })
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.requestId).toBe("req-1");
    expect(body.familyGroupId).toBe("fg-new");
    expect(body.childRequestIds).toEqual(["req-2", "req-3"]);

    // Everything happens in exactly one transaction; the group is created
    // memberless (no FamilyGroupMember create anywhere in this route).
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(txGroupCreate).toHaveBeenCalledWith({ data: { name: "Adventure Family" } });

    // GROUP_CREATE is created first, carrying the resolved partner.
    expect(txRequestCreate).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        familyGroupId: "fg-new",
        requesterId: "adult1",
        type: "GROUP_CREATE",
        invitedMemberId: "partner1",
      }),
    });
    expect(txRequestCreate).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        familyGroupId: "fg-new",
        requesterId: "adult1",
        type: "CHILD_REQUEST",
        childFirstName: "Sam",
        childLastName: "Smith",
        childDateOfBirth: new Date(`${CHILD_DOB}T00:00:00.000Z`),
      }),
    });
    expect(txRequestCreate).toHaveBeenNthCalledWith(3, {
      data: expect.objectContaining({
        type: "CHILD_REQUEST",
        childFirstName: "Pip",
      }),
    });

    // GROUP_CREATE floats above its children in the createdAt asc admin queue.
    const groupCreateCreatedAt = txRequestCreate.mock.calls[0][0].data.createdAt as Date;
    const firstChildCreatedAt = txRequestCreate.mock.calls[1][0].data.createdAt as Date;
    expect(groupCreateCreatedAt.getTime()).toBeLessThan(firstChildCreatedAt.getTime());

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "FAMILY_GROUP_CREATE_REQUESTED",
        entityType: "FamilyGroupJoinRequest",
        entityId: "req-1",
        category: "family",
        metadata: expect.objectContaining({
          familyGroupId: "fg-new",
          groupName: "Adventure Family",
          partnerMemberId: "partner1",
          childCount: 2,
          childRequestIds: ["req-2", "req-3"],
        }),
      })
    );

    expect(sendGroupCreateRequestConfirmationEmail).toHaveBeenCalledWith(
      "alice@test.com",
      "Alice Smith",
      "Adventure Family"
    );
    expect(sendAdminFamilyGroupRequestAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        requestType: "Group Create Request",
        requesterName: "Alice Smith",
        groupName: "Adventure Family",
      })
    );
  });

  it("defaults the group name to '{lastName} Family' and allows no partner/children", async () => {
    mockedAuth.mockResolvedValue(adultSession);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(groupLessRequester() as any);
    vi.mocked(prisma.familyGroupJoinRequest.findFirst).mockResolvedValue(null);
    const { txGroupCreate, txRequestCreate } = mockTransaction();

    const res = await createGroup(makeRequest({}));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.childRequestIds).toEqual([]);
    expect(txGroupCreate).toHaveBeenCalledWith({ data: { name: "Smith Family" } });
    expect(txRequestCreate).toHaveBeenCalledTimes(1);
    expect(txRequestCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: "GROUP_CREATE",
        invitedMemberId: null,
      }),
    });
    // No partner lookup when no partnerEmail was supplied.
    expect(prisma.member.findFirst).not.toHaveBeenCalled();
  });

  describe("declarePartnerLink (#1742)", () => {
    function mockRegisteredPartner() {
      vi.mocked(prisma.member.findFirst).mockResolvedValue({
        id: "partner1",
        firstName: "Bob",
        lastName: "Jones",
        ageTier: "ADULT",
      } as any);
    }

    beforeEach(() => {
      mockedAuth.mockResolvedValue(adultSession);
      vi.mocked(prisma.member.findUnique).mockResolvedValue(groupLessRequester() as any);
      vi.mocked(prisma.familyGroupJoinRequest.findFirst).mockResolvedValue(null);
    });

    it("files a PENDING partner-link request (by email) for a registered declared partner", async () => {
      mockRegisteredPartner();
      mockTransaction();
      vi.mocked(requestPartnerLink).mockResolvedValue({
        ok: true,
        linkId: "link-1",
        status: "PENDING",
        message: "sent",
      });

      const res = await createGroup(
        makeRequest({ partnerEmail: "Bob@Test.com", declarePartnerLink: true })
      );

      expect(res.status).toBe(201);
      expect(requestPartnerLink).toHaveBeenCalledWith({
        initiatorMemberId: "adult1",
        targetEmail: "bob@test.com",
      });
    });

    it("does not file a partner-link request when the flag is off", async () => {
      mockRegisteredPartner();
      mockTransaction();

      const res = await createGroup(makeRequest({ partnerEmail: "bob@test.com" }));

      expect(res.status).toBe(201);
      expect(requestPartnerLink).not.toHaveBeenCalled();
    });

    it("keeps the committed group request alive when the partner-link call throws", async () => {
      mockRegisteredPartner();
      mockTransaction();
      vi.mocked(requestPartnerLink).mockRejectedValue(new Error("db blip"));

      const res = await createGroup(
        makeRequest({ partnerEmail: "bob@test.com", declarePartnerLink: true })
      );

      expect(res.status).toBe(201);
      expect(sendGroupCreateRequestConfirmationEmail).toHaveBeenCalled();
      expect(sendAdminFamilyGroupRequestAlert).toHaveBeenCalled();
    });

    it("marks the minted invite token for an unregistered declared partner", async () => {
      vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
      const { txPartnerInviteCreate } = mockTransaction();

      const res = await createGroup(
        makeRequest({ partnerEmail: "new@test.com", declarePartnerLink: true })
      );

      expect(res.status).toBe(201);
      expect(txPartnerInviteCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          invitedEmail: "new@test.com",
          createPartnerLink: true,
        }),
      });
      expect(requestPartnerLink).not.toHaveBeenCalled();
    });

    it("tells the reviewing admin when a declared partner is a member who cannot be invited", async () => {
      // Email matches an existing member row that is not an active login adult.
      vi.mocked(prisma.member.findFirst)
        .mockResolvedValueOnce(null as any) // no active login member
        .mockResolvedValueOnce({ id: "existing1" } as any); // but a row exists
      const { txRequestCreate, txPartnerInviteCreate } = mockTransaction();

      const res = await createGroup(
        makeRequest({ partnerEmail: "spouse@test.com", declarePartnerLink: true })
      );

      expect(res.status).toBe(201);
      expect(txPartnerInviteCreate).not.toHaveBeenCalled();
      expect(requestPartnerLink).not.toHaveBeenCalled();
      expect(txRequestCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: "GROUP_CREATE",
          requestNotes: expect.stringContaining("declared as the requester's partner"),
        }),
      });
    });
  });
});
