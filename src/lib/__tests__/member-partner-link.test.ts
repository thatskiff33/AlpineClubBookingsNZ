import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    familyGroupMember: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    familyGroupJoinRequest: { create: vi.fn() },
    memberPartnerLink: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    partnerInviteToken: { findUnique: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
  },
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/email", () => ({
  sendPartnerLinkRequestEmail: vi.fn().mockResolvedValue(undefined),
  sendPartnerLinkConfirmedEmail: vi.fn().mockResolvedValue(undefined),
  sendPartnerLinkRemovedEmail: vi.fn().mockResolvedValue(undefined),
  sendFamilyGroupInviteAcceptedEmail: vi.fn().mockResolvedValue(undefined),
  sendPartnerInviteClaimedEmail: vi.fn().mockResolvedValue(undefined),
  sendAdminPartnerShareSweptAlert: vi.fn().mockResolvedValue(undefined),
}));
// #1756: the dissolve paths sweep the pair's future shared-double allocations
// through this helper; the sweep's own behaviour is covered in
// bed-allocation-lifecycle.test.ts, so here it is a spy.
const mockAcquireFuturePartnerSharedAllocationLocks = vi
  .fn()
  .mockResolvedValue(undefined);
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  acquireFuturePartnerSharedAllocationLocks: (...args: unknown[]) =>
    mockAcquireFuturePartnerSharedAllocationLocks(...args),
  sweepFuturePartnerSharedAllocationsWithLocksHeld: vi.fn().mockResolvedValue([]),
  partnerShareSweepNights: vi.fn(() => [new Date("2026-08-01T00:00:00.000Z")]),
  describePartnerSharedSweepReason: vi.fn(() => "Partner link dissolved"),
}));

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import {
  sendPartnerLinkRequestEmail,
  sendPartnerLinkConfirmedEmail,
  sendPartnerLinkRemovedEmail,
  sendAdminPartnerShareSweptAlert,
} from "@/lib/email";
import { sweepFuturePartnerSharedAllocationsWithLocksHeld } from "@/lib/bed-allocation-lifecycle";
import {
  canonicalPartnerPair,
  listOneStepPartnerCandidates,
  PARTNER_REQUEST_SENT_GENERIC_MESSAGE,
  requestPartnerLink,
  respondToPartnerLink,
  removeOwnPartnerLink,
  adminAssignPartnerLink,
  adminRemovePartnerLink,
  formPartnerLinkOnClaim,
  getPartnerLinkState,
} from "@/lib/member-partner-link";
import { claimPartnerInviteToken } from "@/lib/partner-invite-token";
import { issueActionToken } from "@/lib/action-tokens";

const adultA = {
  id: "member-a",
  firstName: "Alice",
  lastName: "Ash",
  email: "alice@example.nz",
  active: true,
  canLogin: true,
  ageTier: "ADULT",
  detailsConfirmedByMemberId: null as string | null,
};
const adultB = {
  id: "member-b",
  firstName: "Ben",
  lastName: "Birch",
  email: "ben@example.nz",
  active: true,
  canLogin: true,
  ageTier: "ADULT",
  detailsConfirmedByMemberId: null as string | null,
};
const nonLoginAdultC = {
  id: "member-c",
  firstName: "Cora",
  lastName: "Ash",
  email: "alice@example.nz", // shares the family login holder's email
  active: true,
  canLogin: false,
  ageTier: "ADULT",
  // #2284 (S4): Alice (adultA) is CURRENTLY the recorded voucher for Cora's
  // details, so she may one-step declare a partnership over Cora. This is not a
  // lone designation: the voucher pointer is self-assignable by any adult login
  // co-member sharing Cora's group (via the delegated-details route), so any such
  // adult can become the voucher and gain the same one-step power — the equal
  // "all adults in a family group" boundary #2284 recorded. The gate keys on the
  // pointer's CURRENT value; these fixtures fix it at member-a.
  detailsConfirmedByMemberId: "member-a" as string | null,
};

function mockMemberLookup(members: Array<typeof adultA>) {
  vi.mocked(prisma.member.findUnique).mockImplementation((async (args: {
    where: { id?: string };
  }) => members.find((member) => member.id === args.where.id) ?? null) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.$transaction).mockImplementation((async (fn: unknown) =>
    (fn as (tx: typeof prisma) => Promise<unknown>)(prisma)) as never);
  vi.mocked(prisma.$executeRaw).mockResolvedValue(0 as never);
  vi.mocked(prisma.memberPartnerLink.findFirst).mockResolvedValue(null as never);
  vi.mocked(prisma.memberPartnerLink.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.memberPartnerLink.findUnique).mockResolvedValue(null as never);
  vi.mocked(prisma.memberPartnerLink.deleteMany).mockResolvedValue({ count: 0 } as never);
  vi.mocked(sweepFuturePartnerSharedAllocationsWithLocksHeld).mockResolvedValue(
    [],
  );
});

describe("canonicalPartnerPair", () => {
  it("orders the pair by member id regardless of argument order", () => {
    expect(canonicalPartnerPair("member-b", "member-a")).toEqual({
      memberAId: "member-a",
      memberBId: "member-b",
    });
    expect(canonicalPartnerPair("member-a", "member-b")).toEqual({
      memberAId: "member-a",
      memberBId: "member-b",
    });
  });
});

describe("listOneStepPartnerCandidates (#2284 S4)", () => {
  it("returns the non-login adult co-members this member is the recorded voucher for", async () => {
    vi.mocked(prisma.familyGroupMember.findMany).mockResolvedValue([
      { familyGroupId: "g1" },
      { familyGroupId: "g2" },
    ] as never);
    vi.mocked(prisma.member.findMany).mockResolvedValue([
      {
        id: "member-c",
        firstName: "Cora",
        lastName: "Ash",
        canLogin: false,
      },
    ] as never);

    const result = await listOneStepPartnerCandidates("member-a");

    expect(result).toEqual([
      { id: "member-c", firstName: "Cora", lastName: "Ash", canLogin: false },
    ]);
    // The candidate query keys on the voucher pointer + shared group + no-login
    // adult, and NOT on any family-group role.
    const memberFindManyArgs = vi.mocked(prisma.member.findMany).mock
      .calls[0][0] as { where: Record<string, unknown> };
    expect(memberFindManyArgs.where).toMatchObject({
      canLogin: false,
      active: true,
      ageTier: "ADULT",
      detailsConfirmedByMemberId: "member-a",
      familyGroupMemberships: { some: { familyGroupId: { in: ["g1", "g2"] } } },
    });
    expect(JSON.stringify(memberFindManyArgs.where)).not.toContain("ADMIN");
  });

  it("returns nothing when the member is in no family group", async () => {
    vi.mocked(prisma.familyGroupMember.findMany).mockResolvedValue([] as never);

    const result = await listOneStepPartnerCandidates("member-a");

    expect(result).toEqual([]);
    expect(prisma.member.findMany).not.toHaveBeenCalled();
  });

  it("excludes a vouchered member who already has a CONFIRMED partner", async () => {
    vi.mocked(prisma.familyGroupMember.findMany).mockResolvedValue([
      { familyGroupId: "g1" },
    ] as never);
    vi.mocked(prisma.member.findMany).mockResolvedValue([
      { id: "member-c", firstName: "Cora", lastName: "Ash", canLogin: false },
    ] as never);
    vi.mocked(prisma.memberPartnerLink.findMany).mockResolvedValue([
      { memberAId: "member-c", memberBId: "member-x" },
    ] as never);

    const result = await listOneStepPartnerCandidates("member-a");

    expect(result).toEqual([]);
  });
});

describe("requestPartnerLink", () => {
  it("creates a PENDING link and emails the target (request→confirm path)", async () => {
    mockMemberLookup([adultA]);
    vi.mocked(prisma.member.findFirst).mockResolvedValue(adultB as never);
    vi.mocked(prisma.memberPartnerLink.create).mockResolvedValue({
      id: "link-1",
    } as never);

    const result = await requestPartnerLink({
      initiatorMemberId: adultA.id,
      targetEmail: "Ben@Example.nz",
    });

    expect(result.ok).toBe(true);
    expect(prisma.memberPartnerLink.create).toHaveBeenCalledWith({
      data: {
        memberAId: "member-a",
        memberBId: "member-b",
        status: "PENDING",
        initiatedByMemberId: "member-a",
        confirmedAt: null,
      },
    });
    expect(sendPartnerLinkRequestEmail).toHaveBeenCalledWith(
      "ben@example.nz",
      "Alice Ash"
    );
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "MEMBER_PARTNER_LINK_REQUESTED" })
    );
  });

  it("rejects partnering yourself", async () => {
    mockMemberLookup([adultA]);
    vi.mocked(prisma.member.findFirst).mockResolvedValue(adultA as never);

    const result = await requestPartnerLink({
      initiatorMemberId: adultA.id,
      targetEmail: adultA.email,
    });

    expect(result).toMatchObject({ ok: false, status: 422 });
  });

  it("rejects a non-adult target", async () => {
    mockMemberLookup([adultA]);
    vi.mocked(prisma.member.findFirst).mockResolvedValue({
      ...adultB,
      ageTier: "YOUTH",
    } as never);

    const result = await requestPartnerLink({
      initiatorMemberId: adultA.id,
      targetEmail: adultB.email,
    });

    expect(result).toMatchObject({ ok: false, status: 422 });
    expect(prisma.memberPartnerLink.create).not.toHaveBeenCalled();
  });

  it("rejects a non-adult initiator", async () => {
    mockMemberLookup([{ ...adultA, ageTier: "YOUTH" }]);

    const result = await requestPartnerLink({
      initiatorMemberId: adultA.id,
      targetEmail: adultB.email,
    });

    expect(result).toMatchObject({ ok: false, status: 422 });
  });

  it("fails fast when the initiator already has a confirmed partner", async () => {
    mockMemberLookup([adultA]);
    vi.mocked(prisma.member.findFirst).mockResolvedValue(adultB as never);
    vi.mocked(prisma.memberPartnerLink.findFirst).mockResolvedValueOnce({
      id: "existing-confirmed",
    } as never);

    const result = await requestPartnerLink({
      initiatorMemberId: adultA.id,
      targetEmail: adultB.email,
    });

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(prisma.memberPartnerLink.create).not.toHaveBeenCalled();
  });

  it("suppresses a by-email request to an already-partnered target into the generic reply (D9)", async () => {
    mockMemberLookup([adultA]);
    vi.mocked(prisma.member.findFirst).mockResolvedValue(adultB as never);
    // findFirst order: initiator confirmed → outstanding outgoing → target confirmed.
    vi.mocked(prisma.memberPartnerLink.findFirst)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce({ id: "existing-confirmed" } as never);

    const result = await requestPartnerLink({
      initiatorMemberId: adultA.id,
      targetEmail: adultB.email,
    });

    expect(result).toMatchObject({
      ok: true,
      linkId: null,
      suppressed: true,
      message: PARTNER_REQUEST_SENT_GENERIC_MESSAGE,
    });
    expect(prisma.memberPartnerLink.create).not.toHaveBeenCalled();
    expect(sendPartnerLinkRequestEmail).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "MEMBER_PARTNER_LINK_REQUEST_SUPPRESSED" })
    );
  });

  it("returns the same generic message for a real by-email request as for a suppressed one (D9)", async () => {
    mockMemberLookup([adultA]);
    vi.mocked(prisma.member.findFirst).mockResolvedValue(adultB as never);
    vi.mocked(prisma.memberPartnerLink.create).mockResolvedValue({
      id: "link-1",
    } as never);

    const result = await requestPartnerLink({
      initiatorMemberId: adultA.id,
      targetEmail: adultB.email,
    });

    expect(result).toMatchObject({
      ok: true,
      linkId: "link-1",
      message: PARTNER_REQUEST_SENT_GENERIC_MESSAGE,
    });
  });

  it("keeps the 409 when a family co-member target already has a confirmed partner", async () => {
    mockMemberLookup([adultA, adultB]);
    vi.mocked(prisma.memberPartnerLink.findFirst)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce({ id: "existing-confirmed" } as never);

    const result = await requestPartnerLink({
      initiatorMemberId: adultA.id,
      targetMemberId: adultB.id,
    });

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(result.ok === false && result.error).toMatch(/already has a confirmed partner/i);
    expect(prisma.memberPartnerLink.create).not.toHaveBeenCalled();
  });

  it("points at the counter-request when the target already asked", async () => {
    mockMemberLookup([adultA]);
    vi.mocked(prisma.member.findFirst).mockResolvedValue(adultB as never);
    vi.mocked(prisma.memberPartnerLink.findUnique).mockResolvedValue({
      id: "their-request",
      initiatedByMemberId: adultB.id,
    } as never);

    const result = await requestPartnerLink({
      initiatorMemberId: adultA.id,
      targetEmail: adultB.email,
    });

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(result.ok === false && result.error).toMatch(/respond to their request/i);
  });

  it("one-steps to CONFIRMED when the recorded voucher declares a no-login member (#2284 S4)", async () => {
    mockMemberLookup([adultA, nonLoginAdultC]);
    // Shared-group probe succeeds; the voucher check keys on the target's
    // detailsConfirmedByMemberId (adultA), not the family-group role.
    vi.mocked(prisma.familyGroupMember.findFirst).mockResolvedValue({
      familyGroupId: "group-1",
    } as never);
    vi.mocked(prisma.memberPartnerLink.create).mockResolvedValue({
      id: "link-2",
    } as never);

    const result = await requestPartnerLink({
      initiatorMemberId: adultA.id,
      targetMemberId: nonLoginAdultC.id,
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.status).toBe("CONFIRMED");
    // The shared-group probe no longer filters on role: "ADMIN".
    const findFirstArgs = vi.mocked(prisma.familyGroupMember.findFirst).mock
      .calls[0][0] as { where: Record<string, unknown> };
    expect(findFirstArgs.where).toMatchObject({ memberId: adultA.id });
    expect(findFirstArgs.where).not.toHaveProperty("role");
    expect(prisma.memberPartnerLink.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "CONFIRMED",
        initiatedByMemberId: adultA.id,
      }),
    });
    // No consent request email — but the target's address is told the link
    // was recorded (one-step forms it without their own consent).
    expect(sendPartnerLinkRequestEmail).not.toHaveBeenCalled();
    expect(sendPartnerLinkConfirmedEmail).toHaveBeenCalledWith(
      "alice@example.nz",
      "Alice Ash"
    );
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "MEMBER_PARTNER_LINK_CONFIRMED" })
    );
  });

  it("refuses the one-step for a no-login member when the initiator is NOT their recorded voucher (#2284 S4)", async () => {
    // Cora's details were confirmed by someone else, so adultA is not entitled
    // to declare the partnership in one step. The shared-group probe must never
    // even run (the voucher check short-circuits).
    mockMemberLookup([
      adultA,
      { ...nonLoginAdultC, detailsConfirmedByMemberId: "someone-else" },
    ]);
    vi.mocked(prisma.familyGroupMember.findFirst).mockResolvedValue(null as never);

    const result = await requestPartnerLink({
      initiatorMemberId: adultA.id,
      targetMemberId: nonLoginAdultC.id,
    });

    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(prisma.familyGroupMember.findFirst).not.toHaveBeenCalled();
    expect(prisma.memberPartnerLink.create).not.toHaveBeenCalled();
  });

  it("refuses the one-step when the recorded voucher no longer shares a family group with the target (#2284 S4)", async () => {
    mockMemberLookup([adultA, nonLoginAdultC]);
    // adultA IS the voucher, but the shared-group probe finds nothing — a stale
    // voucher pointer left behind after the target left the group grants nothing.
    vi.mocked(prisma.familyGroupMember.findFirst).mockResolvedValue(null as never);

    const result = await requestPartnerLink({
      initiatorMemberId: adultA.id,
      targetMemberId: nonLoginAdultC.id,
    });

    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(prisma.familyGroupMember.findFirst).toHaveBeenCalled();
    expect(prisma.memberPartnerLink.create).not.toHaveBeenCalled();
  });

  it("creates a PENDING link (not one-step) for a login-holding family member", async () => {
    mockMemberLookup([adultA, adultB]);
    vi.mocked(prisma.memberPartnerLink.create).mockResolvedValue({
      id: "link-3",
    } as never);

    const result = await requestPartnerLink({
      initiatorMemberId: adultA.id,
      targetMemberId: adultB.id,
    });

    expect(result.ok && result.status).toBe("PENDING");
    // The voucher/shared-group check is never consulted for login holders.
    expect(prisma.familyGroupMember.findFirst).not.toHaveBeenCalled();
  });

  it("allows only one outstanding outgoing request", async () => {
    mockMemberLookup([adultA]);
    vi.mocked(prisma.member.findFirst).mockResolvedValue(adultB as never);
    // initiator-confirmed check passes, then the outstanding-outgoing probe
    // hits (it runs before the target-confirmed check — see D9 ordering)
    vi.mocked(prisma.memberPartnerLink.findFirst)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce({ id: "other-outgoing" } as never);

    const result = await requestPartnerLink({
      initiatorMemberId: adultA.id,
      targetEmail: adultB.email,
    });

    expect(result).toMatchObject({ ok: false, status: 422 });
  });
});

describe("respondToPartnerLink", () => {
  const pendingLink = {
    id: "link-1",
    status: "PENDING",
    memberAId: "member-a",
    memberBId: "member-b",
    initiatedByMemberId: "member-a",
    assignedByAdminId: null,
    confirmedAt: null,
    createdAt: new Date(),
    memberA: adultA,
    memberB: adultB,
  };

  it("confirms a pending request, prunes other pendings, and emails the initiator", async () => {
    vi.mocked(prisma.memberPartnerLink.findFirst)
      .mockResolvedValueOnce(pendingLink as never) // link lookup
      .mockResolvedValue(null as never); // invariant checks
    vi.mocked(prisma.memberPartnerLink.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.memberPartnerLink.deleteMany).mockResolvedValue({ count: 2 } as never);

    const result = await respondToPartnerLink({
      memberId: adultB.id,
      linkId: "link-1",
      action: "accept",
    });

    expect(result.ok).toBe(true);
    expect(prisma.memberPartnerLink.updateMany).toHaveBeenCalledWith({
      where: { id: "link-1", status: "PENDING" },
      data: expect.objectContaining({
        status: "CONFIRMED",
        confirmedByMemberId: adultB.id,
      }),
    });
    expect(prisma.memberPartnerLink.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { not: "link-1" }, status: "PENDING" }),
      })
    );
    expect(sendPartnerLinkConfirmedEmail).toHaveBeenCalledWith(
      "alice@example.nz",
      "Ben Birch"
    );
  });

  it("declines by hard-deleting the row without email", async () => {
    vi.mocked(prisma.memberPartnerLink.findFirst).mockResolvedValueOnce(
      pendingLink as never
    );
    vi.mocked(prisma.memberPartnerLink.deleteMany).mockResolvedValue({ count: 1 } as never);

    const result = await respondToPartnerLink({
      memberId: adultB.id,
      linkId: "link-1",
      action: "decline",
    });

    expect(result.ok).toBe(true);
    expect(prisma.memberPartnerLink.deleteMany).toHaveBeenCalledWith({
      where: { id: "link-1", status: "PENDING" },
    });
    expect(sendPartnerLinkConfirmedEmail).not.toHaveBeenCalled();
    expect(sendPartnerLinkRemovedEmail).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "MEMBER_PARTNER_LINK_DECLINED" })
    );
  });

  it("cannot be answered by the initiator (request not addressed to them)", async () => {
    vi.mocked(prisma.memberPartnerLink.findFirst).mockResolvedValueOnce(null as never);

    const result = await respondToPartnerLink({
      memberId: adultA.id,
      linkId: "link-1",
      action: "accept",
    });

    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("refuses to confirm a stale request from a member who is no longer an active adult", async () => {
    vi.mocked(prisma.memberPartnerLink.findFirst).mockResolvedValueOnce({
      ...pendingLink,
      memberA: { ...adultA, active: false },
    } as never);

    const result = await respondToPartnerLink({
      memberId: adultB.id,
      linkId: "link-1",
      action: "accept",
    });

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(prisma.memberPartnerLink.updateMany).not.toHaveBeenCalled();
  });

  it("re-checks the one-confirmed-partner invariant at confirm time", async () => {
    vi.mocked(prisma.memberPartnerLink.findFirst).mockResolvedValueOnce(
      pendingLink as never // link lookup
    );
    // The confirmer already holds a CONFIRMED link elsewhere.
    vi.mocked(prisma.memberPartnerLink.findMany).mockResolvedValueOnce([
      { memberAId: adultB.id, memberBId: "member-x" },
    ] as never);

    const result = await respondToPartnerLink({
      memberId: adultB.id,
      linkId: "link-1",
      action: "accept",
    });

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(result.ok === false && result.error).toMatch(/You already have/);
    expect(prisma.memberPartnerLink.updateMany).not.toHaveBeenCalled();
  });

  it("refuses confirmation when the initiator gained a partner in the meantime", async () => {
    vi.mocked(prisma.memberPartnerLink.findFirst).mockResolvedValueOnce(
      pendingLink as never // link lookup
    );
    // Only the initiator (member-a) is conflicted, not the confirmer.
    vi.mocked(prisma.memberPartnerLink.findMany).mockResolvedValueOnce([
      { memberAId: adultA.id, memberBId: "member-x" },
    ] as never);

    const result = await respondToPartnerLink({
      memberId: adultB.id,
      linkId: "link-1",
      action: "accept",
    });

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(result.ok === false && result.error).toMatch(
      /member already has a confirmed partner/i
    );
    expect(prisma.memberPartnerLink.updateMany).not.toHaveBeenCalled();
  });

  it("loses the race gracefully when the row changed under the update guard", async () => {
    vi.mocked(prisma.memberPartnerLink.findFirst)
      .mockResolvedValueOnce(pendingLink as never)
      .mockResolvedValue(null as never);
    vi.mocked(prisma.memberPartnerLink.updateMany).mockResolvedValue({ count: 0 } as never);

    const result = await respondToPartnerLink({
      memberId: adultB.id,
      linkId: "link-1",
      action: "accept",
    });

    expect(result).toMatchObject({ ok: false, status: 409 });
  });
});

describe("removeOwnPartnerLink", () => {
  it("withdraws own pending request without email", async () => {
    vi.mocked(prisma.memberPartnerLink.findFirst).mockResolvedValueOnce({
      id: "link-1",
      status: "PENDING",
      memberAId: "member-a",
      memberBId: "member-b",
      initiatedByMemberId: "member-a",
      memberA: adultA,
      memberB: adultB,
    } as never);
    vi.mocked(prisma.memberPartnerLink.deleteMany).mockResolvedValue({ count: 1 } as never);

    const result = await removeOwnPartnerLink({ memberId: adultA.id, linkId: "link-1" });

    expect(result.ok).toBe(true);
    expect(sendPartnerLinkRemovedEmail).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "MEMBER_PARTNER_LINK_WITHDRAWN" })
    );
  });

  it("refuses to let the requested member delete a pending request (decline instead)", async () => {
    vi.mocked(prisma.memberPartnerLink.findFirst).mockResolvedValueOnce({
      id: "link-1",
      status: "PENDING",
      memberAId: "member-a",
      memberBId: "member-b",
      initiatedByMemberId: "member-a",
      memberA: adultA,
      memberB: adultB,
    } as never);

    const result = await removeOwnPartnerLink({ memberId: adultB.id, linkId: "link-1" });

    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("dissolves a confirmed partnership and notifies the other partner", async () => {
    vi.mocked(prisma.memberPartnerLink.findFirst).mockResolvedValueOnce({
      id: "link-1",
      status: "CONFIRMED",
      memberAId: "member-a",
      memberBId: "member-b",
      initiatedByMemberId: "member-a",
      memberA: adultA,
      memberB: adultB,
    } as never);
    vi.mocked(prisma.memberPartnerLink.deleteMany).mockResolvedValue({ count: 1 } as never);

    const result = await removeOwnPartnerLink({ memberId: adultB.id, linkId: "link-1" });

    expect(result.ok).toBe(true);
    expect(sendPartnerLinkRemovedEmail).toHaveBeenCalledWith(
      "alice@example.nz",
      "Ben Birch"
    );
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "MEMBER_PARTNER_LINK_DISSOLVED" })
    );
  });

  it("sweeps the pair's future shared-double allocations on dissolve and alerts admins (#1756)", async () => {
    vi.mocked(prisma.memberPartnerLink.findFirst).mockResolvedValueOnce({
      id: "link-1",
      status: "CONFIRMED",
      memberAId: "member-a",
      memberBId: "member-b",
      initiatedByMemberId: "member-a",
      memberA: adultA,
      memberB: adultB,
    } as never);
    vi.mocked(prisma.memberPartnerLink.deleteMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(
      sweepFuturePartnerSharedAllocationsWithLocksHeld,
    ).mockResolvedValueOnce([
      {
        allocationId: "alloc-2nd",
        bookingId: "booking-b",
        bookingGuestId: "guest-b",
        bedId: "bed-double",
        roomId: "room-1",
        stayDate: new Date("2026-08-01T00:00:00.000Z"),
        secondOccupantMemberId: "member-b",
        secondOccupantName: "Ben Birch",
        primaryBookingId: "booking-a",
        primaryMemberId: "member-a",
        primaryName: "Alice Ash",
      },
    ]);

    const result = await removeOwnPartnerLink({ memberId: adultA.id, linkId: "link-1" });

    expect(result.ok).toBe(true);
    expect(sweepFuturePartnerSharedAllocationsWithLocksHeld).toHaveBeenCalledWith({
      memberId: "member-a",
      partnerMemberId: "member-b",
      reason: "partner_link_dissolved",
      db: prisma,
      // #3123: the club's day, resolved before the transaction opened.
      today: expect.any(Date),
    });
    expect(mockAcquireFuturePartnerSharedAllocationLocks).toHaveBeenCalledWith(
      prisma,
      ["member-a", "member-b"],
      expect.any(Date),
    );
    // ONE day for the whole transaction: the lodge set that is LOCKED and the
    // rows the sweep JUDGES must be derived from the same club day, or a
    // dissolve straddling club midnight locks one set and sweeps another.
    expect(
      mockAcquireFuturePartnerSharedAllocationLocks.mock.calls[0]?.[2],
    ).toEqual(
      vi.mocked(sweepFuturePartnerSharedAllocationsWithLocksHeld).mock.calls[0]?.[0]
        .today,
    );
    const acquireOrder =
      mockAcquireFuturePartnerSharedAllocationLocks.mock.invocationCallOrder[0];
    const memberLockOrder = vi.mocked(prisma.$executeRaw).mock
      .invocationCallOrder[0];
    const deleteOrder = vi.mocked(prisma.memberPartnerLink.deleteMany).mock
      .invocationCallOrder[0];
    const heldSweepOrder = vi.mocked(
      sweepFuturePartnerSharedAllocationsWithLocksHeld,
    ).mock.invocationCallOrder[0];
    expect(acquireOrder).toBeLessThan(memberLockOrder);
    expect(memberLockOrder).toBeLessThan(deleteOrder);
    expect(deleteOrder).toBeLessThan(heldSweepOrder);
    expect(sendAdminPartnerShareSweptAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        memberName: "Alice Ash",
        partnerName: "Ben Birch",
        reason: "Partner link dissolved",
      })
    );
  });

  it("does not sweep and does not alert when withdrawing a PENDING request (#1756)", async () => {
    vi.mocked(prisma.memberPartnerLink.findFirst).mockResolvedValueOnce({
      id: "link-1",
      status: "PENDING",
      memberAId: "member-a",
      memberBId: "member-b",
      initiatedByMemberId: "member-a",
      memberA: adultA,
      memberB: adultB,
    } as never);
    vi.mocked(prisma.memberPartnerLink.deleteMany).mockResolvedValue({ count: 1 } as never);

    const result = await removeOwnPartnerLink({ memberId: adultA.id, linkId: "link-1" });

    expect(result.ok).toBe(true);
    expect(sweepFuturePartnerSharedAllocationsWithLocksHeld).not.toHaveBeenCalled();
    expect(sendAdminPartnerShareSweptAlert).not.toHaveBeenCalled();
  });

  it("dissolves without an admin alert when the sweep removed nothing (#1756)", async () => {
    vi.mocked(prisma.memberPartnerLink.findFirst).mockResolvedValueOnce({
      id: "link-1",
      status: "CONFIRMED",
      memberAId: "member-a",
      memberBId: "member-b",
      initiatedByMemberId: "member-a",
      memberA: adultA,
      memberB: adultB,
    } as never);
    vi.mocked(prisma.memberPartnerLink.deleteMany).mockResolvedValue({ count: 1 } as never);

    const result = await removeOwnPartnerLink({ memberId: adultA.id, linkId: "link-1" });

    expect(result.ok).toBe(true);
    expect(sweepFuturePartnerSharedAllocationsWithLocksHeld).toHaveBeenCalledTimes(
      1,
    );
    expect(sendAdminPartnerShareSweptAlert).not.toHaveBeenCalled();
  });
});

describe("adminAssignPartnerLink", () => {
  it("creates a CONFIRMED link recording the admin and emails both members", async () => {
    mockMemberLookup([adultA, adultB]);
    vi.mocked(prisma.memberPartnerLink.create).mockResolvedValue({ id: "link-1" } as never);

    const result = await adminAssignPartnerLink({
      adminMemberId: "admin-1",
      memberOneId: adultB.id,
      memberTwoId: adultA.id,
    });

    expect(result.ok).toBe(true);
    expect(prisma.memberPartnerLink.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        memberAId: "member-a",
        memberBId: "member-b",
        status: "CONFIRMED",
        assignedByAdminId: "admin-1",
      }),
    });
    expect(sendPartnerLinkConfirmedEmail).toHaveBeenCalledTimes(2);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "MEMBER_PARTNER_LINK_ADMIN_ASSIGNED" })
    );
  });

  it("suppresses the emails and audits the choice when notifyMember is false (#1769a)", async () => {
    mockMemberLookup([adultA, adultB]);
    vi.mocked(prisma.memberPartnerLink.create).mockResolvedValue({ id: "link-1" } as never);

    const result = await adminAssignPartnerLink({
      adminMemberId: "admin-1",
      memberOneId: adultB.id,
      memberTwoId: adultA.id,
      notifyMember: false,
    });

    expect(result.ok).toBe(true);
    expect(sendPartnerLinkConfirmedEmail).not.toHaveBeenCalled();
    const call = vi
      .mocked(logAudit)
      .mock.calls.find((c) => c[0].action === "MEMBER_PARTNER_LINK_ADMIN_ASSIGNED")?.[0];
    expect(call?.metadata).toMatchObject({ notifyMember: false });
  });

  it("emails both and records no notify field when notifyMember is true (#1769a)", async () => {
    mockMemberLookup([adultA, adultB]);
    vi.mocked(prisma.memberPartnerLink.create).mockResolvedValue({ id: "link-1" } as never);

    const result = await adminAssignPartnerLink({
      adminMemberId: "admin-1",
      memberOneId: adultB.id,
      memberTwoId: adultA.id,
      notifyMember: true,
    });

    expect(result.ok).toBe(true);
    expect(sendPartnerLinkConfirmedEmail).toHaveBeenCalledTimes(2);
    const call = vi
      .mocked(logAudit)
      .mock.calls.find((c) => c[0].action === "MEMBER_PARTNER_LINK_ADMIN_ASSIGNED")?.[0];
    expect(call?.metadata).not.toHaveProperty("notifyMember");
  });

  it("promotes an existing pending request instead of duplicating", async () => {
    mockMemberLookup([adultA, adultB]);
    vi.mocked(prisma.memberPartnerLink.findUnique).mockResolvedValue({
      id: "pending-1",
      status: "PENDING",
    } as never);
    vi.mocked(prisma.memberPartnerLink.update).mockResolvedValue({ id: "pending-1" } as never);

    const result = await adminAssignPartnerLink({
      adminMemberId: "admin-1",
      memberOneId: adultA.id,
      memberTwoId: adultB.id,
    });

    expect(result.ok).toBe(true);
    expect(prisma.memberPartnerLink.update).toHaveBeenCalledWith({
      where: { id: "pending-1" },
      data: expect.objectContaining({
        status: "CONFIRMED",
        assignedByAdminId: "admin-1",
      }),
    });
    expect(prisma.memberPartnerLink.create).not.toHaveBeenCalled();
  });

  it("rejects when the pair is already confirmed", async () => {
    mockMemberLookup([adultA, adultB]);
    vi.mocked(prisma.memberPartnerLink.findUnique).mockResolvedValue({
      id: "link-1",
      status: "CONFIRMED",
    } as never);

    const result = await adminAssignPartnerLink({
      adminMemberId: "admin-1",
      memberOneId: adultA.id,
      memberTwoId: adultB.id,
    });

    expect(result).toMatchObject({ ok: false, status: 422 });
  });

  it("enforces the one-confirmed-partner invariant", async () => {
    mockMemberLookup([adultA, adultB]);
    vi.mocked(prisma.memberPartnerLink.findMany).mockResolvedValueOnce([
      { memberAId: adultA.id, memberBId: "member-x" },
    ] as never);

    const result = await adminAssignPartnerLink({
      adminMemberId: "admin-1",
      memberOneId: adultA.id,
      memberTwoId: adultB.id,
    });

    expect(result).toMatchObject({ ok: false, status: 409 });
    // The error names the member whose existing partnership blocks the assign.
    expect(result.ok === false && result.error).toMatch(/Alice Ash/);
  });

  it("rejects self-partnering and non-adult members", async () => {
    const selfResult = await adminAssignPartnerLink({
      adminMemberId: "admin-1",
      memberOneId: adultA.id,
      memberTwoId: adultA.id,
    });
    expect(selfResult).toMatchObject({ ok: false, status: 422 });

    mockMemberLookup([adultA, { ...adultB, ageTier: "CHILD" }]);
    const childResult = await adminAssignPartnerLink({
      adminMemberId: "admin-1",
      memberOneId: adultA.id,
      memberTwoId: adultB.id,
    });
    expect(childResult).toMatchObject({ ok: false, status: 422 });
  });
});

describe("adminRemovePartnerLink", () => {
  it("removes a confirmed link and emails both members", async () => {
    vi.mocked(prisma.memberPartnerLink.findFirst).mockResolvedValueOnce({
      id: "link-1",
      status: "CONFIRMED",
      memberAId: "member-a",
      memberBId: "member-b",
      memberA: adultA,
      memberB: adultB,
    } as never);
    vi.mocked(prisma.memberPartnerLink.deleteMany).mockResolvedValue({ count: 1 } as never);

    const result = await adminRemovePartnerLink({
      adminMemberId: "admin-1",
      linkId: "link-1",
    });

    expect(result.ok).toBe(true);
    expect(sendPartnerLinkRemovedEmail).toHaveBeenCalledTimes(2);
  });

  it("removes a pending link silently", async () => {
    vi.mocked(prisma.memberPartnerLink.findFirst).mockResolvedValueOnce({
      id: "link-1",
      status: "PENDING",
      memberAId: "member-a",
      memberBId: "member-b",
      memberA: adultA,
      memberB: adultB,
    } as never);
    vi.mocked(prisma.memberPartnerLink.deleteMany).mockResolvedValue({ count: 1 } as never);

    const result = await adminRemovePartnerLink({
      adminMemberId: "admin-1",
      linkId: "link-1",
    });

    expect(result.ok).toBe(true);
    expect(sendPartnerLinkRemovedEmail).not.toHaveBeenCalled();
  });

  it("suppresses the removal emails and audits the choice for a CONFIRMED link (#1769a)", async () => {
    vi.mocked(prisma.memberPartnerLink.findFirst).mockResolvedValueOnce({
      id: "link-1",
      status: "CONFIRMED",
      memberAId: "member-a",
      memberBId: "member-b",
      memberA: adultA,
      memberB: adultB,
    } as never);
    vi.mocked(prisma.memberPartnerLink.deleteMany).mockResolvedValue({ count: 1 } as never);

    const result = await adminRemovePartnerLink({
      adminMemberId: "admin-1",
      linkId: "link-1",
      notifyMember: false,
    });

    expect(result.ok).toBe(true);
    expect(sendPartnerLinkRemovedEmail).not.toHaveBeenCalled();
    const call = vi
      .mocked(logAudit)
      .mock.calls.find((c) => c[0].action === "MEMBER_PARTNER_LINK_ADMIN_REMOVED")?.[0];
    expect(call?.metadata).toMatchObject({ notifyMember: false });
  });

  it("emails both and records no notify field for a CONFIRMED remove with notifyMember true (#1769a)", async () => {
    vi.mocked(prisma.memberPartnerLink.findFirst).mockResolvedValueOnce({
      id: "link-1",
      status: "CONFIRMED",
      memberAId: "member-a",
      memberBId: "member-b",
      memberA: adultA,
      memberB: adultB,
    } as never);
    vi.mocked(prisma.memberPartnerLink.deleteMany).mockResolvedValue({ count: 1 } as never);

    const result = await adminRemovePartnerLink({
      adminMemberId: "admin-1",
      linkId: "link-1",
      notifyMember: true,
    });

    expect(result.ok).toBe(true);
    expect(sendPartnerLinkRemovedEmail).toHaveBeenCalledTimes(2);
    const call = vi
      .mocked(logAudit)
      .mock.calls.find((c) => c[0].action === "MEMBER_PARTNER_LINK_ADMIN_REMOVED")?.[0];
    expect(call?.metadata).not.toHaveProperty("notifyMember");
  });

  it("records no notify field for a PENDING removal even when notifyMember is false (#1769a honesty rule)", async () => {
    vi.mocked(prisma.memberPartnerLink.findFirst).mockResolvedValueOnce({
      id: "link-1",
      status: "PENDING",
      memberAId: "member-a",
      memberBId: "member-b",
      memberA: adultA,
      memberB: adultB,
    } as never);
    vi.mocked(prisma.memberPartnerLink.deleteMany).mockResolvedValue({ count: 1 } as never);

    const result = await adminRemovePartnerLink({
      adminMemberId: "admin-1",
      linkId: "link-1",
      notifyMember: false,
    });

    expect(result.ok).toBe(true);
    expect(sendPartnerLinkRemovedEmail).not.toHaveBeenCalled();
    const call = vi
      .mocked(logAudit)
      .mock.calls.find((c) => c[0].action === "MEMBER_PARTNER_LINK_ADMIN_REMOVED")?.[0];
    expect(call?.metadata).not.toHaveProperty("notifyMember");
  });

  it("sweeps the pair's future shared-double allocations on admin dissolve (#1756)", async () => {
    vi.mocked(prisma.memberPartnerLink.findFirst).mockResolvedValueOnce({
      id: "link-1",
      status: "CONFIRMED",
      memberAId: "member-a",
      memberBId: "member-b",
      memberA: adultA,
      memberB: adultB,
    } as never);
    vi.mocked(prisma.memberPartnerLink.deleteMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(
      sweepFuturePartnerSharedAllocationsWithLocksHeld,
    ).mockResolvedValueOnce([
      {
        allocationId: "alloc-2nd",
        bookingId: "booking-b",
        bookingGuestId: "guest-b",
        bedId: "bed-double",
        roomId: "room-1",
        stayDate: new Date("2026-08-01T00:00:00.000Z"),
        secondOccupantMemberId: "member-b",
        secondOccupantName: "Ben Birch",
        primaryBookingId: "booking-a",
        primaryMemberId: "member-a",
        primaryName: "Alice Ash",
      },
    ]);

    const result = await adminRemovePartnerLink({
      adminMemberId: "admin-1",
      linkId: "link-1",
    });

    expect(result.ok).toBe(true);
    expect(sweepFuturePartnerSharedAllocationsWithLocksHeld).toHaveBeenCalledWith({
      memberId: "member-a",
      partnerMemberId: "member-b",
      reason: "partner_link_dissolved",
      db: prisma,
      // #3123: the club's day, resolved before the transaction opened.
      today: expect.any(Date),
    });
    expect(sendAdminPartnerShareSweptAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        memberName: "Alice Ash",
        partnerName: "Ben Birch",
      })
    );
  });

  it("does not sweep when removing a PENDING link (#1756)", async () => {
    vi.mocked(prisma.memberPartnerLink.findFirst).mockResolvedValueOnce({
      id: "link-1",
      status: "PENDING",
      memberAId: "member-a",
      memberBId: "member-b",
      memberA: adultA,
      memberB: adultB,
    } as never);
    vi.mocked(prisma.memberPartnerLink.deleteMany).mockResolvedValue({ count: 1 } as never);

    const result = await adminRemovePartnerLink({
      adminMemberId: "admin-1",
      linkId: "link-1",
    });

    expect(result.ok).toBe(true);
    expect(sweepFuturePartnerSharedAllocationsWithLocksHeld).not.toHaveBeenCalled();
    expect(sendAdminPartnerShareSweptAlert).not.toHaveBeenCalled();
  });

  it("scopes the lookup to the given member when memberScopeId is set", async () => {
    vi.mocked(prisma.memberPartnerLink.findFirst).mockResolvedValueOnce(null as never);

    const result = await adminRemovePartnerLink({
      adminMemberId: "admin-1",
      linkId: "link-1",
      memberScopeId: "member-z",
    });

    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(prisma.memberPartnerLink.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "link-1",
          OR: [{ memberAId: "member-z" }, { memberBId: "member-z" }],
        }),
      })
    );
    expect(prisma.memberPartnerLink.deleteMany).not.toHaveBeenCalled();
  });
});

describe("getPartnerLinkState", () => {
  it("splits links into confirmed, incoming, and outgoing views", async () => {
    vi.mocked(prisma.memberPartnerLink.findMany).mockResolvedValue([
      {
        id: "confirmed-1",
        status: "CONFIRMED",
        memberAId: "member-a",
        memberBId: "member-b",
        initiatedByMemberId: "member-b",
        assignedByAdminId: null,
        confirmedAt: new Date(),
        createdAt: new Date(),
        memberA: adultA,
        memberB: adultB,
      },
      {
        id: "incoming-1",
        status: "PENDING",
        memberAId: "member-a",
        memberBId: "member-z",
        initiatedByMemberId: "member-z",
        assignedByAdminId: null,
        confirmedAt: null,
        createdAt: new Date(),
        memberA: adultA,
        memberB: { ...adultB, id: "member-z", firstName: "Zoe" },
      },
    ] as never);

    const state = await getPartnerLinkState("member-a");

    expect(state.confirmed?.partner.id).toBe("member-b");
    expect(state.confirmed?.initiatedByMe).toBe(false);
    expect(state.pendingIncoming).toHaveLength(1);
    expect(state.pendingIncoming[0].partner.firstName).toBe("Zoe");
    expect(state.pendingOutgoing).toHaveLength(0);
  });
});

describe("formPartnerLinkOnClaim", () => {
  it("forms a CONFIRMED link between inviter and claimer", async () => {
    mockMemberLookup([adultA, adultB]);
    vi.mocked(prisma.memberPartnerLink.create).mockResolvedValue({ id: "link-9" } as never);

    const outcome = await formPartnerLinkOnClaim({
      tx: prisma as never,
      inviterMemberId: adultA.id,
      claimerMemberId: adultB.id,
      now: new Date(),
    });

    expect(outcome).toMatchObject({ formed: true, linkId: "link-9" });
    expect(prisma.memberPartnerLink.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        memberAId: "member-a",
        memberBId: "member-b",
        status: "CONFIRMED",
        initiatedByMemberId: adultA.id,
        confirmedByMemberId: adultB.id,
      }),
    });
  });

  it("skips without throwing when either side already has a confirmed partner", async () => {
    mockMemberLookup([adultA, adultB]);
    vi.mocked(prisma.memberPartnerLink.findMany).mockResolvedValueOnce([
      { memberAId: adultA.id, memberBId: "member-x" },
    ] as never);

    const outcome = await formPartnerLinkOnClaim({
      tx: prisma as never,
      inviterMemberId: adultA.id,
      claimerMemberId: adultB.id,
      now: new Date(),
    });

    expect(outcome).toEqual({ formed: false, reason: "existing_confirmed_partner" });
    expect(prisma.memberPartnerLink.create).not.toHaveBeenCalled();
  });

  it("skips when the inviter is no longer an active login adult", async () => {
    mockMemberLookup([{ ...adultA, active: false }, adultB]);
    const inactive = await formPartnerLinkOnClaim({
      tx: prisma as never,
      inviterMemberId: adultA.id,
      claimerMemberId: adultB.id,
      now: new Date(),
    });
    expect(inactive).toEqual({ formed: false, reason: "inviter_ineligible" });

    mockMemberLookup([{ ...adultA, canLogin: false }, adultB]);
    const noLogin = await formPartnerLinkOnClaim({
      tx: prisma as never,
      inviterMemberId: adultA.id,
      claimerMemberId: adultB.id,
      now: new Date(),
    });
    expect(noLogin).toEqual({ formed: false, reason: "inviter_ineligible" });
  });

  it("skips when the claimer is not an eligible adult", async () => {
    mockMemberLookup([adultA, { ...adultB, ageTier: "YOUTH" }]);

    const outcome = await formPartnerLinkOnClaim({
      tx: prisma as never,
      inviterMemberId: adultA.id,
      claimerMemberId: adultB.id,
      now: new Date(),
    });

    expect(outcome).toEqual({ formed: false, reason: "claimer_ineligible" });
    expect(prisma.memberPartnerLink.create).not.toHaveBeenCalled();
  });
});

describe("claimPartnerInviteToken with createPartnerLink (#1742)", () => {
  function tokenRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "token-1",
      tokenHash: "hash",
      familyGroupId: "group-1",
      invitedEmail: "ben@example.nz",
      createdById: adultA.id,
      expiresAt: new Date(Date.now() + 86_400_000),
      confirmedAt: null,
      createPartnerLink: true,
      familyGroup: { id: "group-1", name: "Ash Family" },
      createdBy: {
        id: adultA.id,
        email: adultA.email,
        firstName: adultA.firstName,
        lastName: adultA.lastName,
      },
      ...overrides,
    };
  }

  it("forms the partner link inside the claim and reports it", async () => {
    const { token } = issueActionToken();
    vi.mocked(prisma.partnerInviteToken.findUnique).mockResolvedValue(
      tokenRow() as never
    );
    mockMemberLookup([adultA, adultB]);
    vi.mocked(prisma.familyGroupMember.count).mockResolvedValue(1 as never);
    vi.mocked(prisma.partnerInviteToken.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.familyGroupMember.findUnique).mockResolvedValue(null as never);
    vi.mocked(prisma.familyGroupMember.upsert).mockResolvedValue({} as never);
    vi.mocked(prisma.familyGroupJoinRequest.create).mockResolvedValue({} as never);
    vi.mocked(prisma.memberPartnerLink.create).mockResolvedValue({ id: "link-9" } as never);

    const result = await claimPartnerInviteToken({
      rawToken: token,
      memberId: adultB.id,
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.partnerLinkFormed).toBe(true);
    expect(prisma.memberPartnerLink.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "CONFIRMED",
        initiatedByMemberId: adultA.id,
        confirmedByMemberId: adultB.id,
      }),
    });
    expect(sendPartnerLinkConfirmedEmail).toHaveBeenCalledWith(
      "alice@example.nz",
      "Ben Birch"
    );
  });

  it("still joins the family group when the link cannot form", async () => {
    const { token } = issueActionToken();
    vi.mocked(prisma.partnerInviteToken.findUnique).mockResolvedValue(
      tokenRow() as never
    );
    mockMemberLookup([adultA, adultB]);
    vi.mocked(prisma.familyGroupMember.count).mockResolvedValue(1 as never);
    vi.mocked(prisma.partnerInviteToken.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.familyGroupMember.findUnique).mockResolvedValue(null as never);
    vi.mocked(prisma.familyGroupMember.upsert).mockResolvedValue({} as never);
    vi.mocked(prisma.familyGroupJoinRequest.create).mockResolvedValue({} as never);
    // Inviter already has a confirmed partner elsewhere.
    vi.mocked(prisma.memberPartnerLink.findMany).mockResolvedValueOnce([
      { memberAId: adultA.id, memberBId: "member-x" },
    ] as never);

    const result = await claimPartnerInviteToken({
      rawToken: token,
      memberId: adultB.id,
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.partnerLinkFormed).toBe(false);
    expect(result.ok && result.alreadyMember).toBe(false);
    expect(prisma.memberPartnerLink.create).not.toHaveBeenCalled();
    expect(sendPartnerLinkConfirmedEmail).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "MEMBER_PARTNER_LINK_CLAIM_SKIPPED" })
    );
  });

  it("does not touch partner links for tokens minted without the flag", async () => {
    const { token } = issueActionToken();
    vi.mocked(prisma.partnerInviteToken.findUnique).mockResolvedValue(
      tokenRow({ createPartnerLink: false }) as never
    );
    mockMemberLookup([adultA, adultB]);
    vi.mocked(prisma.familyGroupMember.count).mockResolvedValue(1 as never);
    vi.mocked(prisma.partnerInviteToken.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.familyGroupMember.findUnique).mockResolvedValue(null as never);
    vi.mocked(prisma.familyGroupMember.upsert).mockResolvedValue({} as never);
    vi.mocked(prisma.familyGroupJoinRequest.create).mockResolvedValue({} as never);

    const result = await claimPartnerInviteToken({
      rawToken: token,
      memberId: adultB.id,
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.partnerLinkFormed).toBe(false);
    expect(prisma.memberPartnerLink.create).not.toHaveBeenCalled();
    expect(prisma.memberPartnerLink.findFirst).not.toHaveBeenCalled();
    expect(prisma.memberPartnerLink.findMany).not.toHaveBeenCalled();
  });
});
