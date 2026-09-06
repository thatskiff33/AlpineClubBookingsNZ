/**
 * Issue #1681 (W6-9) — admin review of member-initiated GROUP_CREATE requests.
 *
 * Covered here (service-level, mirroring the family-groups.test.ts mock-prisma
 * patterns):
 *   - approve creates the requester's membership (and, since #2520, writes no
 *     `role` — the column is dropped, so there is no rank to seed)
 *   - approve auto-files the partner ADULT_INVITE + invitation email
 *   - approve skips the invite (audited) when the partner became ineligible
 *   - approve 422s when the requester joined another group meanwhile
 *   - CHILD_REQUEST approval 422s while the group is memberless and succeeds
 *     once the GROUP_CREATE approval has created the membership
 *   - reject cascade-rejects sibling pending CHILD_REQUESTs and keeps the
 *     memberless FamilyGroup row
 *   - ADULT_INVITE remains 422 on admin review
 *   - REVIEWED_REQUEST_TYPES includes GROUP_CREATE (admin queue + counts)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    familyGroup: { findUnique: vi.fn(), delete: vi.fn() },
    familyGroupMember: {
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      upsert: vi.fn(),
    },
    familyGroupJoinRequest: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/email", () => ({
  sendChildRequestApprovedEmail: vi.fn().mockResolvedValue(undefined),
  sendChildRequestRejectedEmail: vi.fn().mockResolvedValue(undefined),
  sendFamilyGroupInvitationEmail: vi.fn().mockResolvedValue(undefined),
  sendGroupCreateApprovedEmail: vi.fn().mockResolvedValue(undefined),
  sendGroupCreateRejectedEmail: vi.fn().mockResolvedValue(undefined),
}));

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import {
  sendChildRequestApprovedEmail,
  sendFamilyGroupInvitationEmail,
  sendGroupCreateApprovedEmail,
  sendGroupCreateRejectedEmail,
} from "@/lib/email";
import { MEMBER_PARENT_PARTNER_CONFLICT_MESSAGE } from "@/lib/member-parent-partner-exclusivity";
import {
  reviewAdminFamilyGroupRequest,
  REVIEWED_REQUEST_TYPES,
} from "@/lib/admin-family-group-requests-service";

const mockedPrisma = vi.mocked(prisma, true);

const ADMIN_ID = "admin-1";

function groupCreateRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-gc",
    familyGroupId: "fg-new",
    requesterId: "member-1",
    type: "GROUP_CREATE",
    status: "PENDING",
    invitedMemberId: null,
    subjectMemberId: null,
    requester: {
      id: "member-1",
      firstName: "Alice",
      lastName: "Smith",
      email: "alice@test.com",
      ageTier: "ADULT",
      active: true,
      archivedAt: null,
      inheritEmailFromId: null,
    },
    familyGroup: { id: "fg-new", name: "Smith Family" },
    subjectMember: null,
    ...overrides,
  };
}

function eligiblePartner(overrides: Record<string, unknown> = {}) {
  return {
    id: "partner-1",
    firstName: "Bob",
    lastName: "Jones",
    email: "bob@test.com",
    active: true,
    archivedAt: null,
    canLogin: true,
    ageTier: "ADULT",
    familyGroupMemberships: [],
    ...overrides,
  };
}

function mockGroupCreateTransaction() {
  const txMembershipCreate = vi.fn();
  const txRequestUpdate = vi.fn();
  const txRequestCreate = vi.fn().mockResolvedValue({ id: "inv-1" });
  const txRequestFindMany = vi.fn().mockResolvedValue([]);
  const txRequestUpdateMany = vi.fn();
  const txTokenFindMany = vi.fn().mockResolvedValue([]);
  const txTokenDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
  // #1936: the approve transaction takes a member-lifecycle advisory lock on
  // the requester before creating the FamilyGroupMember row.
  const txExecuteRaw = vi.fn().mockResolvedValue(undefined);
  mockedPrisma.$transaction.mockImplementation(async (fn: any) =>
    fn({
      $executeRaw: txExecuteRaw,
      familyGroupMember: { create: txMembershipCreate },
      familyGroupJoinRequest: {
        update: txRequestUpdate,
        create: txRequestCreate,
        findMany: txRequestFindMany,
        updateMany: txRequestUpdateMany,
      },
      partnerInviteToken: {
        findMany: txTokenFindMany,
        deleteMany: txTokenDeleteMany,
      },
    })
  );
  return {
    txMembershipCreate,
    txRequestUpdate,
    txRequestCreate,
    txRequestFindMany,
    txRequestUpdateMany,
    txTokenFindMany,
    txTokenDeleteMany,
    txExecuteRaw,
  };
}

describe("reviewAdminFamilyGroupRequest — GROUP_CREATE", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps GROUP_CREATE in the reviewed types (admin queue + pending counts)", () => {
    expect(REVIEWED_REQUEST_TYPES).toContain("GROUP_CREATE");
  });

  it("approve creates the requester's membership and writes no role (#2520)", async () => {
    mockedPrisma.familyGroupJoinRequest.findUnique.mockResolvedValue(
      groupCreateRequest() as any
    );
    mockedPrisma.familyGroupMember.findFirst.mockResolvedValue(null);
    const { txMembershipCreate, txRequestUpdate, txRequestCreate, txExecuteRaw } =
      mockGroupCreateTransaction();

    const result = await reviewAdminFamilyGroupRequest({
      adminMemberId: ADMIN_ID,
      data: { requestId: "req-gc", action: "approve" },
    });

    expect(result.init).toBeUndefined();
    expect(result.body).toEqual({ success: true, action: "approve" });
    // #1936: the requester's member-lifecycle advisory lock is taken in-tx so
    // the group link serializes with application-approval mapping.
    expect(txExecuteRaw).toHaveBeenCalledTimes(1);
    expect(txExecuteRaw.mock.calls[0].flat().join(" ")).toContain(
      "member-lifecycle:member-1"
    );
    // #2520: exactly these two columns. The dropped `role` is not written —
    // asserted by the exact-shape match, so re-adding it reddens this test. The
    // `select` narrows the write's implicit RETURNING (#2130 house rule).
    expect(txMembershipCreate).toHaveBeenCalledWith({
      data: {
        familyGroupId: "fg-new",
        memberId: "member-1",
      },
      select: { id: true },
    });
    expect(txRequestUpdate).toHaveBeenCalledWith({
      where: { id: "req-gc" },
      data: expect.objectContaining({
        status: "APPROVED",
        reviewedBy: ADMIN_ID,
      }),
    });
    // No partner, so no ADULT_INVITE row is filed.
    expect(txRequestCreate).not.toHaveBeenCalled();
    expect(sendGroupCreateApprovedEmail).toHaveBeenCalledWith(
      "alice@test.com",
      "Alice",
      "Smith Family"
    );
    expect(sendFamilyGroupInvitationEmail).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "FAMILY_GROUP_CREATE_APPROVED" })
    );
  });

  it("approve files the partner ADULT_INVITE and sends the invitation email", async () => {
    mockedPrisma.familyGroupJoinRequest.findUnique.mockResolvedValue(
      groupCreateRequest({ invitedMemberId: "partner-1" }) as any
    );
    mockedPrisma.familyGroupMember.findFirst.mockResolvedValue(null);
    mockedPrisma.member.findUnique.mockResolvedValue(eligiblePartner() as any);
    // No pending ADULT_INVITE for this group/partner.
    mockedPrisma.familyGroupJoinRequest.findFirst.mockResolvedValue(null);
    const { txMembershipCreate, txRequestCreate } = mockGroupCreateTransaction();

    const result = await reviewAdminFamilyGroupRequest({
      adminMemberId: ADMIN_ID,
      data: { requestId: "req-gc", action: "approve" },
    });

    expect(result.body).toEqual({ success: true, action: "approve" });
    expect(txMembershipCreate).toHaveBeenCalledWith({
      data: { familyGroupId: "fg-new", memberId: "member-1" },
      select: { id: true },
    });
    // The auto-filed invite is anchored on the ORIGINAL requester.
    expect(txRequestCreate).toHaveBeenCalledWith({
      data: {
        familyGroupId: "fg-new",
        requesterId: "member-1",
        type: "ADULT_INVITE",
        invitedMemberId: "partner-1",
      },
      select: { id: true },
    });
    expect(sendFamilyGroupInvitationEmail).toHaveBeenCalledWith(
      "bob@test.com",
      "Alice Smith",
      "Smith Family"
    );
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "FAMILY_GROUP_INVITE_SENT",
        entityId: "inv-1",
      })
    );
  });

  it.each([
    ["inactive", { active: false }, "partner_not_active"],
    ["non-login", { canLogin: false }, "partner_cannot_login"],
    ["non-adult", { ageTier: "YOUTH" }, "partner_not_adult"],
    [
      "already in the group",
      { familyGroupMemberships: [{ familyGroupId: "fg-new" }] },
      "partner_already_in_group",
    ],
  ])(
    "approve skips the invite when the partner became %s, with an audited reason",
    async (_label, partnerOverrides, expectedReason) => {
      mockedPrisma.familyGroupJoinRequest.findUnique.mockResolvedValue(
        groupCreateRequest({ invitedMemberId: "partner-1" }) as any
      );
      mockedPrisma.familyGroupMember.findFirst.mockResolvedValue(null);
      mockedPrisma.member.findUnique.mockResolvedValue(
        eligiblePartner(partnerOverrides as Record<string, unknown>) as any
      );
      mockedPrisma.familyGroupJoinRequest.findFirst.mockResolvedValue(null);
      const { txMembershipCreate, txRequestCreate } = mockGroupCreateTransaction();

      const result = await reviewAdminFamilyGroupRequest({
        adminMemberId: ADMIN_ID,
        data: { requestId: "req-gc", action: "approve" },
      });

      // Group approval is unaffected — only the invite is skipped.
      expect(result.body).toEqual({ success: true, action: "approve" });
      expect(txMembershipCreate).toHaveBeenCalled();
      expect(txRequestCreate).not.toHaveBeenCalled();
      expect(sendFamilyGroupInvitationEmail).not.toHaveBeenCalled();
      expect(logAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "FAMILY_GROUP_CREATE_APPROVED",
          metadata: expect.objectContaining({
            partnerInviteSkipped: true,
            partnerInviteSkippedReason: expectedReason,
          }),
        })
      );
    }
  );

  it("approve skips the invite when an ADULT_INVITE is already pending", async () => {
    mockedPrisma.familyGroupJoinRequest.findUnique.mockResolvedValue(
      groupCreateRequest({ invitedMemberId: "partner-1" }) as any
    );
    mockedPrisma.familyGroupMember.findFirst.mockResolvedValue(null);
    mockedPrisma.member.findUnique.mockResolvedValue(eligiblePartner() as any);
    mockedPrisma.familyGroupJoinRequest.findFirst.mockResolvedValue({
      id: "inv-existing",
    } as any);
    const { txRequestCreate } = mockGroupCreateTransaction();

    const result = await reviewAdminFamilyGroupRequest({
      adminMemberId: ADMIN_ID,
      data: { requestId: "req-gc", action: "approve" },
    });

    expect(result.body).toEqual({ success: true, action: "approve" });
    expect(txRequestCreate).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "FAMILY_GROUP_CREATE_APPROVED",
        metadata: expect.objectContaining({
          partnerInviteSkippedReason: "invite_already_pending",
        }),
      })
    );
  });

  it("approve 422s when the requester joined another group meanwhile", async () => {
    mockedPrisma.familyGroupJoinRequest.findUnique.mockResolvedValue(
      groupCreateRequest() as any
    );
    mockedPrisma.familyGroupMember.findFirst.mockResolvedValue({
      familyGroupId: "other-group",
    } as any);

    const result = await reviewAdminFamilyGroupRequest({
      adminMemberId: ADMIN_ID,
      data: { requestId: "req-gc", action: "approve" },
    });

    expect(result.init?.status).toBe(422);
    expect((result.body as { error: string }).error).toMatch(
      /joined a family group/i
    );
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("approve 422s when the requester is no longer an active adult", async () => {
    mockedPrisma.familyGroupJoinRequest.findUnique.mockResolvedValue(
      groupCreateRequest({
        requester: {
          id: "member-1",
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@test.com",
          ageTier: "ADULT",
          active: false,
          archivedAt: null,
          inheritEmailFromId: null,
        },
      }) as any
    );

    const result = await reviewAdminFamilyGroupRequest({
      adminMemberId: ADMIN_ID,
      data: { requestId: "req-gc", action: "approve" },
    });

    expect(result.init?.status).toBe(422);
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("converts a concurrent double-approve P2002 into a 422 instead of a 500", async () => {
    mockedPrisma.familyGroupJoinRequest.findUnique.mockResolvedValue(
      groupCreateRequest() as any
    );
    mockedPrisma.familyGroupMember.findFirst.mockResolvedValue(null);
    // Second admin's transaction hits the (familyGroupId, memberId) unique
    // constraint because the first admin's approval already committed.
    mockedPrisma.$transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "0.0.0",
      })
    );

    const result = await reviewAdminFamilyGroupRequest({
      adminMemberId: ADMIN_ID,
      data: { requestId: "req-gc", action: "approve" },
    });

    expect(result.init?.status).toBe(422);
    expect((result.body as { error: string }).error).toMatch(
      /already has a membership in this family group/i
    );
    // No approval side effects fire for the losing admin.
    expect(sendGroupCreateApprovedEmail).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("still rethrows non-P2002 transaction failures", async () => {
    mockedPrisma.familyGroupJoinRequest.findUnique.mockResolvedValue(
      groupCreateRequest() as any
    );
    mockedPrisma.familyGroupMember.findFirst.mockResolvedValue(null);
    mockedPrisma.$transaction.mockRejectedValue(new Error("connection lost"));

    await expect(
      reviewAdminFamilyGroupRequest({
        adminMemberId: ADMIN_ID,
        data: { requestId: "req-gc", action: "approve" },
      })
    ).rejects.toThrow("connection lost");
  });

  it("reject cascade-rejects sibling pending child requests and keeps the memberless group", async () => {
    mockedPrisma.familyGroupJoinRequest.findUnique.mockResolvedValue(
      groupCreateRequest() as any
    );
    const {
      txRequestUpdate,
      txRequestFindMany,
      txRequestUpdateMany,
      txMembershipCreate,
    } = mockGroupCreateTransaction();
    txRequestFindMany.mockResolvedValue([{ id: "child-req-1" }, { id: "child-req-2" }]);

    const result = await reviewAdminFamilyGroupRequest({
      adminMemberId: ADMIN_ID,
      data: {
        requestId: "req-gc",
        action: "reject",
        rejectionReason: "Duplicate of an existing family",
      },
    });

    expect(result.body).toEqual({ success: true, action: "reject" });
    expect(txRequestUpdate).toHaveBeenCalledWith({
      where: { id: "req-gc" },
      data: expect.objectContaining({ status: "REJECTED", reviewedBy: ADMIN_ID }),
    });
    expect(txRequestFindMany).toHaveBeenCalledWith({
      where: {
        familyGroupId: "fg-new",
        requesterId: "member-1",
        type: "CHILD_REQUEST",
        status: "PENDING",
      },
      select: { id: true },
    });
    expect(txRequestUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["child-req-1", "child-req-2"] } },
      data: expect.objectContaining({ status: "REJECTED", reviewedBy: ADMIN_ID }),
    });
    // No membership is ever created and the memberless FamilyGroup row stays
    // (deleting it would cascade away the request history).
    expect(txMembershipCreate).not.toHaveBeenCalled();
    expect(mockedPrisma.familyGroup.delete).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "FAMILY_GROUP_CREATE_REJECTED",
        metadata: expect.objectContaining({
          cascadeRejectedChildRequestIds: ["child-req-1", "child-req-2"],
          rejectionReason: "Duplicate of an existing family",
        }),
      })
    );
    expect(sendGroupCreateRejectedEmail).toHaveBeenCalledWith(
      "alice@test.com",
      "Alice",
      "Smith Family",
      "Duplicate of an existing family"
    );
  });

  it("reject revokes any outstanding partner-invite token for the group (#1682)", async () => {
    mockedPrisma.familyGroupJoinRequest.findUnique.mockResolvedValue(
      groupCreateRequest() as any
    );
    const { txTokenFindMany, txTokenDeleteMany } = mockGroupCreateTransaction();
    txTokenFindMany.mockResolvedValue([
      { id: "pit-1", invitedEmail: "ghost@test.com" },
    ]);

    const result = await reviewAdminFamilyGroupRequest({
      adminMemberId: ADMIN_ID,
      data: { requestId: "req-gc", action: "reject" },
    });

    expect(result.body).toEqual({ success: true, action: "reject" });
    expect(txTokenFindMany).toHaveBeenCalledWith({
      where: { familyGroupId: "fg-new", confirmedAt: null },
      select: { id: true, invitedEmail: true },
    });
    expect(txTokenDeleteMany).toHaveBeenCalledWith({
      where: { familyGroupId: "fg-new", confirmedAt: null },
    });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "FAMILY_GROUP_PARTNER_INVITE_REVOKED",
        entityId: "pit-1",
        metadata: expect.objectContaining({ cause: "group_create_rejected" }),
      })
    );
  });

  it("reject leaves a claimed token untouched (none outstanding to revoke)", async () => {
    mockedPrisma.familyGroupJoinRequest.findUnique.mockResolvedValue(
      groupCreateRequest() as any
    );
    const { txTokenFindMany, txTokenDeleteMany } = mockGroupCreateTransaction();
    // A claimed token has confirmedAt set, so the confirmedAt:null query returns
    // nothing and no delete/revoke-audit happens.
    txTokenFindMany.mockResolvedValue([]);

    const result = await reviewAdminFamilyGroupRequest({
      adminMemberId: ADMIN_ID,
      data: { requestId: "req-gc", action: "reject" },
    });

    expect(result.body).toEqual({ success: true, action: "reject" });
    expect(txTokenDeleteMany).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "FAMILY_GROUP_PARTNER_INVITE_REVOKED" })
    );
  });

  // #1789: admin per-decision email choice. The requester's approval/rejection
  // email is suppressible; the token-bearing partner invite is always sent.
  it("approve with notifyMember false suppresses the requester email but still creates the group, files the invite, sends the partner invitation, and audits the choice", async () => {
    mockedPrisma.familyGroupJoinRequest.findUnique.mockResolvedValue(
      groupCreateRequest({ invitedMemberId: "partner-1" }) as any
    );
    mockedPrisma.familyGroupMember.findFirst.mockResolvedValue(null);
    mockedPrisma.member.findUnique.mockResolvedValue(eligiblePartner() as any);
    mockedPrisma.familyGroupJoinRequest.findFirst.mockResolvedValue(null);
    const { txMembershipCreate, txRequestCreate } = mockGroupCreateTransaction();

    const result = await reviewAdminFamilyGroupRequest({
      adminMemberId: ADMIN_ID,
      data: { requestId: "req-gc", action: "approve", notifyMember: false },
    });

    expect(result.body).toEqual({ success: true, action: "approve" });
    // Group/membership state change is still applied.
    expect(txMembershipCreate).toHaveBeenCalledWith({
      data: { familyGroupId: "fg-new", memberId: "member-1" },
      select: { id: true },
    });
    expect(txRequestCreate).toHaveBeenCalled();
    // Requester notice suppressed...
    expect(sendGroupCreateApprovedEmail).not.toHaveBeenCalled();
    // ...but the partner invitation is ALWAYS sent (carve-out).
    expect(sendFamilyGroupInvitationEmail).toHaveBeenCalledWith(
      "bob@test.com",
      "Alice Smith",
      "Smith Family"
    );
    // Suppression is audited on the create-approved record.
    const approvedAudit = vi
      .mocked(logAudit)
      .mock.calls.find((c) => c[0].action === "FAMILY_GROUP_CREATE_APPROVED")?.[0];
    expect(approvedAudit?.metadata).toMatchObject({ notifyMember: false });
  });

  it("approve with notifyMember true emails the requester and records no notify field", async () => {
    mockedPrisma.familyGroupJoinRequest.findUnique.mockResolvedValue(
      groupCreateRequest() as any
    );
    mockedPrisma.familyGroupMember.findFirst.mockResolvedValue(null);
    mockGroupCreateTransaction();

    const result = await reviewAdminFamilyGroupRequest({
      adminMemberId: ADMIN_ID,
      data: { requestId: "req-gc", action: "approve", notifyMember: true },
    });

    expect(result.body).toEqual({ success: true, action: "approve" });
    expect(sendGroupCreateApprovedEmail).toHaveBeenCalledWith(
      "alice@test.com",
      "Alice",
      "Smith Family"
    );
    const approvedAudit = vi
      .mocked(logAudit)
      .mock.calls.find((c) => c[0].action === "FAMILY_GROUP_CREATE_APPROVED")?.[0];
    expect(approvedAudit?.metadata).not.toHaveProperty("notifyMember");
  });

  it("reject with notifyMember false suppresses the requester email but still rejects and audits the choice", async () => {
    mockedPrisma.familyGroupJoinRequest.findUnique.mockResolvedValue(
      groupCreateRequest() as any
    );
    const { txRequestUpdate } = mockGroupCreateTransaction();

    const result = await reviewAdminFamilyGroupRequest({
      adminMemberId: ADMIN_ID,
      data: { requestId: "req-gc", action: "reject", notifyMember: false },
    });

    expect(result.body).toEqual({ success: true, action: "reject" });
    // Reject state change still applied.
    expect(txRequestUpdate).toHaveBeenCalledWith({
      where: { id: "req-gc" },
      data: expect.objectContaining({ status: "REJECTED", reviewedBy: ADMIN_ID }),
    });
    expect(sendGroupCreateRejectedEmail).not.toHaveBeenCalled();
    const rejectedAudit = vi
      .mocked(logAudit)
      .mock.calls.find((c) => c[0].action === "FAMILY_GROUP_CREATE_REJECTED")?.[0];
    expect(rejectedAudit?.metadata).toMatchObject({ notifyMember: false });
  });

  it("reject with notifyMember true emails the requester and records no notify field", async () => {
    mockedPrisma.familyGroupJoinRequest.findUnique.mockResolvedValue(
      groupCreateRequest() as any
    );
    mockGroupCreateTransaction();

    const result = await reviewAdminFamilyGroupRequest({
      adminMemberId: ADMIN_ID,
      data: { requestId: "req-gc", action: "reject", notifyMember: true },
    });

    expect(result.body).toEqual({ success: true, action: "reject" });
    expect(sendGroupCreateRejectedEmail).toHaveBeenCalled();
    const rejectedAudit = vi
      .mocked(logAudit)
      .mock.calls.find((c) => c[0].action === "FAMILY_GROUP_CREATE_REJECTED")?.[0];
    expect(rejectedAudit?.metadata).not.toHaveProperty("notifyMember");
  });
});

describe("reviewAdminFamilyGroupRequest — CHILD_REQUEST memberless-group guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function childRequest() {
    return {
      id: "req-child",
      familyGroupId: "fg-new",
      requesterId: "member-1",
      type: "CHILD_REQUEST",
      status: "PENDING",
      childFirstName: "Sam",
      childLastName: "Smith",
      childDateOfBirth: new Date("2018-03-15T00:00:00.000Z"),
      requester: {
        id: "member-1",
        firstName: "Alice",
        lastName: "Smith",
        email: "alice@test.com",
        ageTier: "ADULT",
        active: true,
        archivedAt: null,
        inheritEmailFromId: null,
      },
      familyGroup: { id: "fg-new", name: "Smith Family" },
      subjectMember: null,
    };
  }

  it("422s while the family group has zero memberships and a pending GROUP_CREATE", async () => {
    mockedPrisma.familyGroupJoinRequest.findUnique.mockResolvedValue(
      childRequest() as any
    );
    mockedPrisma.familyGroupMember.count.mockResolvedValue(0);
    // The bundled case: the group's GROUP_CREATE request is still pending.
    mockedPrisma.familyGroupJoinRequest.findFirst.mockResolvedValue({
      id: "req-gc",
    } as any);

    const result = await reviewAdminFamilyGroupRequest({
      adminMemberId: ADMIN_ID,
      data: { requestId: "req-child", action: "approve", linkedMemberId: "child-1" },
    });

    expect(result.init?.status).toBe(422);
    expect((result.body as { error: string }).error).toBe(
      "Approve the group creation request for this family group first."
    );
    expect(mockedPrisma.familyGroupJoinRequest.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          familyGroupId: "fg-new",
          type: "GROUP_CREATE",
          status: "PENDING",
        },
      })
    );
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("422s a legacy empty group (no pending GROUP_CREATE) with actionable copy", async () => {
    mockedPrisma.familyGroupJoinRequest.findUnique.mockResolvedValue(
      childRequest() as any
    );
    mockedPrisma.familyGroupMember.count.mockResolvedValue(0);
    // Legacy case: a group emptied by removals with no creation request —
    // "approve the group creation request first" would be un-followable.
    mockedPrisma.familyGroupJoinRequest.findFirst.mockResolvedValue(null);

    const result = await reviewAdminFamilyGroupRequest({
      adminMemberId: ADMIN_ID,
      data: { requestId: "req-child", action: "approve", linkedMemberId: "child-1" },
    });

    expect(result.init?.status).toBe(422);
    expect((result.body as { error: string }).error).toBe(
      "This family group has no members; reject this request or re-establish the group first."
    );
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("succeeds once the GROUP_CREATE approval has created a membership", async () => {
    mockedPrisma.familyGroupJoinRequest.findUnique.mockResolvedValue(
      childRequest() as any
    );
    mockedPrisma.familyGroupMember.count.mockResolvedValue(1);
    mockedPrisma.member.findUnique.mockResolvedValue({
      id: "child-1",
      active: true,
      archivedAt: null,
      ageTier: "CHILD",
      canLogin: false,
      parentMemberId: null,
      secondaryParentId: null,
      inheritEmailFromId: null,
      parent: null,
      secondaryParent: null,
      dependents: [],
      secondaryDependents: [],
    } as any);

    const txUpsert = vi.fn();
    const txUpdate = vi.fn();
    const txMemberUpdate = vi.fn();
    const txExecuteRaw = vi.fn().mockResolvedValue(undefined);
    mockedPrisma.$transaction.mockImplementation(async (fn: any) =>
      fn({
        $executeRaw: txExecuteRaw,
        member: {
          // #2716: the notification mailbox is decided by ONE read of the
          // chosen parent, and `isUsableEmailSource` disqualifies a parent who
          // is themselves inheriting on EITHER column. `inheritEmailChoiceId`
          // is in `EMAIL_SOURCE_SELECT`, so a real row always has it; a fixture
          // that omits it yields `undefined`, which is not `null`, and the
          // requester reads as an inheritor rather than a mailbox.
          findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
            where.id === "child-1"
              ? {
                  id: "child-1",
                  active: true,
                  ageTier: "CHILD",
                  canLogin: false,
                  email: null,
                  archivedAt: null,
                  parentMemberId: null,
                  secondaryParentId: null,
                  inheritEmailFromId: null,
                  inheritEmailChoiceId: null,
                  parent: null,
                  secondaryParent: null,
                }
              : {
                  id: "member-1",
                  active: true,
                  ageTier: "ADULT",
                  email: "member-1@test.com",
                  archivedAt: null,
                  parentMemberId: null,
                  secondaryParentId: null,
                  inheritEmailFromId: null,
                  inheritEmailChoiceId: null,
                },
          ),
          // #2255: the approval walks the family chain (four-generation LINK
          // cap + cycle guard) through `member.findMany`. That cap is unchanged
          // by #2716 — it governs the tree, never the address hop. Nobody here
          // has a parent, so the walk terminates on the requester.
          findMany: vi.fn().mockImplementation(async ({ where }: any) =>
            where?.id?.in
              ? where.id.in.map((id: string) => ({
                  id,
                  email: `${id}@test.com`,
                  ageTier: "ADULT",
                  archivedAt: null,
                  inheritEmailFromId: null,
                  parentMemberId: null,
                  secondaryParentId: null,
                }))
              : []
          ),
          update: txMemberUpdate,
        },
        memberPartnerLink: { findUnique: vi.fn().mockResolvedValue(null) },
        familyGroupMember: { upsert: txUpsert },
        familyGroupJoinRequest: { update: txUpdate },
      })
    );

    const result = await reviewAdminFamilyGroupRequest({
      adminMemberId: ADMIN_ID,
      data: { requestId: "req-child", action: "approve", linkedMemberId: "child-1" },
    });

    expect(result.init).toBeUndefined();
    expect(result.body).toEqual({ success: true, action: "approve" });
    // #1936: the linked member's member-lifecycle advisory lock is taken in-tx
    // so the group link serializes with application-approval mapping.
    expect(txExecuteRaw).toHaveBeenCalledTimes(4);
    const lockTexts = txExecuteRaw.mock.calls.map((call) =>
      call.flat().join(" "),
    );
    expect(lockTexts.slice(0, 2).every((text) =>
      text.includes("member-lifecycle:"),
    )).toBe(true);
    expect(lockTexts.slice(2).every((text) =>
      text.includes("member-partner-link:"),
    )).toBe(true);
    expect(txUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        // #2520: membership only — no `role` is written any more.
        create: { familyGroupId: "fg-new", memberId: "child-1" },
      })
    );
  });

  it.each([
    {
      status: "PENDING",
      orientation: "child is canonical member A",
      childId: "a-child",
      pair: { memberAId: "a-child", memberBId: "member-1" },
    },
    {
      status: "CONFIRMED",
      orientation: "child is canonical member B",
      childId: "z-child",
      pair: { memberAId: "member-1", memberBId: "z-child" },
    },
  ])(
    "refuses an existing $status partner row in either orientation before all success effects ($orientation)",
    async ({ status, childId, pair }) => {
      mockedPrisma.familyGroupJoinRequest.findUnique.mockResolvedValue(
        childRequest() as any,
      );
      mockedPrisma.familyGroupMember.count.mockResolvedValue(1);
      mockedPrisma.member.findUnique.mockResolvedValue({
        id: childId,
        active: true,
        archivedAt: null,
        ageTier: "CHILD",
        canLogin: false,
        parentMemberId: null,
        secondaryParentId: null,
        inheritEmailFromId: null,
        parent: null,
        secondaryParent: null,
      } as any);

      const txMemberUpdate = vi.fn();
      const txMembershipUpsert = vi.fn();
      const txRequestUpdate = vi.fn();
      const txPartnerFind = vi.fn().mockResolvedValue({
        id: `link-${status.toLowerCase()}`,
        status,
      });
      mockedPrisma.$transaction.mockImplementation(async (fn: any) =>
        fn({
          $executeRaw: vi.fn().mockResolvedValue(undefined),
          member: {
            findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
              where.id === "member-1"
                ? {
                    id: "member-1",
                    active: true,
                    archivedAt: null,
                    ageTier: "ADULT",
                    inheritEmailFromId: null,
                  }
                : {
                    id: childId,
                    active: true,
                    archivedAt: null,
                    ageTier: "CHILD",
                    canLogin: false,
                    parentMemberId: null,
                    secondaryParentId: null,
                    inheritEmailFromId: null,
                    parent: null,
                    secondaryParent: null,
                  },
            ),
            update: txMemberUpdate,
          },
          memberPartnerLink: { findUnique: txPartnerFind },
          familyGroupMember: { upsert: txMembershipUpsert },
          familyGroupJoinRequest: { update: txRequestUpdate },
        }),
      );

      const result = await reviewAdminFamilyGroupRequest({
        adminMemberId: ADMIN_ID,
        data: {
          requestId: "req-child",
          action: "approve",
          linkedMemberId: childId,
        },
      });

      expect(result.init?.status).toBe(422);
      expect((result.body as { error: string }).error).toBe(
        MEMBER_PARENT_PARTNER_CONFLICT_MESSAGE,
      );
      expect(txPartnerFind).toHaveBeenCalledWith({
        where: {
          memberAId_memberBId: pair,
        },
        select: { id: true },
      });
      expect(txMemberUpdate).not.toHaveBeenCalled();
      expect(txMembershipUpsert).not.toHaveBeenCalled();
      expect(txRequestUpdate).not.toHaveBeenCalled();
      expect(logAudit).not.toHaveBeenCalled();
      expect(sendChildRequestApprovedEmail).not.toHaveBeenCalled();
    },
  );

  /**
   * THE REQUESTER-ADULT GATE ON APPROVAL (#2282 review).
   *
   * #2282 relaxed the age rule on ADMIN-recorded parentage, and left every
   * RESPONSIBILITY gate alone — including this one, which the issue names as a
   * blocker that must not be relaxed: a minor cannot have the club create or
   * adopt a child member on their strength. The member-side gates that stop a
   * minor RAISING such a request were covered; the APPROVAL side, where an admin
   * acts on it, had no test at all. Replacing both
   * `request.requester.ageTier !== "ADULT"` checks with `false` passed 448 tests
   * across 28 files, so the safeguarding claim rested on nothing here.
   *
   * Two checks, two paths: the pre-transaction one guards `createNewMember`;
   * the existing-child path must re-read after its lifecycle lock so requester
   * eligibility cannot drift between preflight and commit.
   */
  it("422s approval of a child request raised by a NON-ADULT requester (create path)", async () => {
    const request = childRequest();
    request.requester.ageTier = "YOUTH";
    mockedPrisma.familyGroupJoinRequest.findUnique.mockResolvedValue(
      request as any
    );
    mockedPrisma.familyGroupMember.count.mockResolvedValue(1);

    const result = await reviewAdminFamilyGroupRequest({
      adminMemberId: ADMIN_ID,
      data: { requestId: "req-child", action: "approve", createNewMember: true },
    });

    expect(result.init?.status).toBe(422);
    expect((result.body as { error: string }).error).toBe(
      "Child requests can only be approved for active adult requesters."
    );
    expect(mockedPrisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    {
      drift: "inactive",
      requester: { active: false, archivedAt: null, ageTier: "ADULT" },
    },
    {
      drift: "archived",
      requester: {
        active: true,
        archivedAt: new Date("2026-06-01T00:00:00.000Z"),
        ageTier: "ADULT",
      },
    },
    {
      drift: "non-adult",
      requester: { active: true, archivedAt: null, ageTier: "YOUTH" },
    },
  ])(
    "422s existing-child approval when the locked requester has become $drift",
    async ({ requester: lockedRequester }) => {
      const request = childRequest();
      mockedPrisma.familyGroupJoinRequest.findUnique.mockResolvedValue(
        request as any
      );
      mockedPrisma.familyGroupMember.count.mockResolvedValue(1);
      mockedPrisma.member.findUnique.mockResolvedValue({
        id: "child-1",
        active: true,
        archivedAt: null,
        ageTier: "CHILD",
        canLogin: false,
        parentMemberId: null,
        secondaryParentId: null,
        inheritEmailFromId: null,
        parent: null,
        secondaryParent: null,
        dependents: [],
        secondaryDependents: [],
      } as any);

      const txMemberUpdate = vi.fn();
      const txUpsert = vi.fn();
      const txRequestUpdate = vi.fn();
      const txPartnerFind = vi.fn();
      mockedPrisma.$transaction.mockImplementation(async (fn: any) =>
        fn({
          $executeRaw: vi.fn().mockResolvedValue(undefined),
          member: {
            findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
              where.id === "member-1"
                ? {
                    id: "member-1",
                    ...lockedRequester,
                    inheritEmailFromId: null,
                  }
                : {
                    id: "child-1",
                    active: true,
                    canLogin: false,
                    ageTier: "CHILD",
                    email: null,
                    archivedAt: null,
                    parentMemberId: null,
                    secondaryParentId: null,
                    inheritEmailFromId: null,
                    inheritEmailChoiceId: null,
                    parent: null,
                    secondaryParent: null,
                  }
            ),
            findMany: vi.fn().mockResolvedValue([]),
            update: txMemberUpdate,
          },
          memberPartnerLink: { findUnique: txPartnerFind },
          familyGroupMember: { upsert: txUpsert },
          familyGroupJoinRequest: { update: txRequestUpdate },
        })
      );

      const result = await reviewAdminFamilyGroupRequest({
        adminMemberId: ADMIN_ID,
        data: {
          requestId: "req-child",
          action: "approve",
          linkedMemberId: "child-1",
        },
      });

      expect(result.init?.status).toBe(422);
      expect((result.body as { error: string }).error).toBe(
        "Child requests can only be approved for active adult requesters."
      );
      expect(txPartnerFind).not.toHaveBeenCalled();
      expect(txMemberUpdate).not.toHaveBeenCalled();
      expect(txUpsert).not.toHaveBeenCalled();
      expect(txRequestUpdate).not.toHaveBeenCalled();
      expect(logAudit).not.toHaveBeenCalled();
      expect(sendChildRequestApprovedEmail).not.toHaveBeenCalled();
    }
  );
});

describe("reviewAdminFamilyGroupRequest — ADULT_INVITE stays self-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("still 422s an ADULT_INVITE on admin review", async () => {
    mockedPrisma.familyGroupJoinRequest.findUnique.mockResolvedValue({
      id: "inv-1",
      familyGroupId: "fg-new",
      requesterId: "member-1",
      type: "ADULT_INVITE",
      status: "PENDING",
      invitedMemberId: "partner-1",
      requester: {
        id: "member-1",
        firstName: "Alice",
        lastName: "Smith",
        email: "alice@test.com",
        ageTier: "ADULT",
        active: true,
        archivedAt: null,
        inheritEmailFromId: null,
      },
      familyGroup: { id: "fg-new", name: "Smith Family" },
      subjectMember: null,
    } as any);

    const result = await reviewAdminFamilyGroupRequest({
      adminMemberId: ADMIN_ID,
      data: { requestId: "inv-1", action: "approve" },
    });

    expect(result.init?.status).toBe(422);
    expect((result.body as { error: string }).error).toMatch(/invited member/i);
  });
});
