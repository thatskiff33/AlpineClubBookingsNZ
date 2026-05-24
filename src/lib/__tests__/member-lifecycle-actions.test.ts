import { beforeEach, describe, expect, it, vi } from "vitest";
const mockPrisma = vi.hoisted(() => {
  const countDelegate = () => ({ count: vi.fn().mockResolvedValue(0) });

  return {
    member: {
      findUnique: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    memberLifecycleActionRequest: {
      count: vi.fn().mockResolvedValue(0),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
    },
    booking: countDelegate(),
    bookingGuest: countDelegate(),
    payment: countDelegate(),
    paymentRefund: countDelegate(),
    paymentRecoveryOperation: countDelegate(),
    memberCredit: countDelegate(),
    adminCreditAdjustmentRequest: countDelegate(),
    refundRequest: countDelegate(),
    memberSubscription: countDelegate(),
    promoRedemption: countDelegate(),
    promoCodeAssignment: countDelegate(),
    nominationToken: countDelegate(),
    memberApplication: countDelegate(),
    membershipCancellationRequest: countDelegate(),
    membershipCancellationRequestParticipant: countDelegate(),
    familyGroupJoinRequest: countDelegate(),
    familyGroupMember: {
      count: vi.fn().mockResolvedValue(0),
      deleteMany: vi.fn(),
    },
    hutLeaderAssignment: countDelegate(),
    issueReport: countDelegate(),
    bookingModification: countDelegate(),
    deletionRequest: countDelegate(),
    xeroObjectLink: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  };
});

vi.mock("@prisma/client", async () => {
  const actual = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");

  return {
    ...actual,
    MemberLifecycleAction: { ARCHIVE: "ARCHIVE", DELETE: "DELETE" },
    MemberLifecycleActionRequestStatus: {
      REQUESTED: "REQUESTED",
      APPROVED: "APPROVED",
      REJECTED: "REJECTED",
    },
    Role: {
      MEMBER: "MEMBER",
      ADMIN: "ADMIN",
      LODGE: "LODGE",
    },
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn() }));
vi.mock("@/lib/email", () => ({
  sendAdminMemberArchiveRequestedAlert: vi.fn().mockResolvedValue(undefined),
  sendAdminMemberDeleteApprovedEmail: vi.fn().mockResolvedValue(undefined),
  sendAdminMemberDeleteRejectedEmail: vi.fn().mockResolvedValue(undefined),
  sendAdminMemberDeleteRequestedAlert: vi.fn().mockResolvedValue(undefined),
  sendMemberArchiveApprovedEmail: vi.fn().mockResolvedValue(undefined),
  sendMemberArchiveRejectedEmail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } }),
}));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/xero", () => ({
  getXeroContactGroupMemberships: vi.fn(),
  isXeroConnected: vi.fn(),
  syncManagedXeroContactGroupForMember: vi.fn(),
  updateXeroContact: vi.fn(),
}));
vi.mock("@/lib/xero-contact-sync", () => ({
  buildXeroContactUpdatePayload: vi.fn(),
  hasMemberXeroContactChanges: vi.fn(),
  shouldRepairXeroContactNameOrder: vi.fn(),
}));
vi.mock("@/lib/xero-api-errors", () => ({
  getXeroApiErrorInfo: vi.fn().mockReturnValue({ handled: true }),
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  createMemberArchiveRequest,
  createMemberDeleteRequest,
  getMemberDeleteEligibility,
  MemberLifecycleActionError,
  reviewMemberArchiveRequest,
  reviewMemberDeleteRequest,
} from "@/lib/member-lifecycle-actions";
import { DELETE as directDeleteMember } from "@/app/api/admin/members/[id]/route";
import { createAuditLog } from "@/lib/audit";

const mockCreateAuditLog = vi.mocked(createAuditLog);

const now = new Date("2026-05-24T10:00:00.000Z");

const cleanMember = {
  id: "member-1",
  email: "erroneous@example.test",
  passwordHash: "hash",
  forcePasswordChange: false,
  passwordChangedAt: null,
  lastLoginAt: null,
  emailVerified: false,
  firstName: "Error",
  lastName: "Record",
  dateOfBirth: null,
  phoneCountryCode: null,
  phoneAreaCode: null,
  phoneNumber: null,
  streetAddressLine1: null,
  streetAddressLine2: null,
  streetCity: null,
  streetRegion: null,
  streetPostalCode: null,
  streetCountry: null,
  postalAddressLine1: null,
  postalAddressLine2: null,
  postalCity: null,
  postalRegion: null,
  postalPostalCode: null,
  postalCountry: null,
  role: "MEMBER",
  financeAccessLevel: "NONE",
  ageTier: "ADULT",
  xeroContactId: "xero-contact-1",
  active: true,
  canLogin: false,
  profileCompletedAt: null,
  detailsConfirmedAt: null,
  detailsConfirmedByMemberId: null,
  onboardingConfirmedAt: null,
  joinedDate: null,
  cancelledAt: null,
  cancelledReason: null,
  cancelledViaRequestId: null,
  parentMemberId: null,
  inheritParentEmail: true,
  secondaryParentId: null,
  inheritEmailFromId: null,
  familyGroupId: null,
  createdAt: now,
  updatedAt: now,
};

function requestedBy() {
  return {
    id: "admin-1",
    firstName: "Requesting",
    lastName: "Admin",
    email: "requesting-admin@example.test",
  };
}

function reviewedBy() {
  return {
    id: "admin-2",
    firstName: "Reviewing",
    lastName: "Admin",
    email: "reviewing-admin@example.test",
  };
}

function deleteRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: "request-1",
    memberId: "member-1",
    action: "DELETE",
    status: "REQUESTED",
    reason: "Created in error",
    reviewNote: null,
    memberSnapshot: null,
    requestedByMemberId: "admin-1",
    requestedAt: now,
    reviewedByMemberId: null,
    reviewedAt: null,
    processedAt: null,
    createdAt: now,
    updatedAt: now,
    requestedBy: requestedBy(),
    reviewedBy: null,
    ...overrides,
  };
}

function archiveTarget(overrides: Record<string, unknown> = {}) {
  return {
    id: "member-1",
    firstName: "Former",
    lastName: "Member",
    email: "former@example.test",
    active: false,
    canLogin: false,
    cancelledAt: new Date("2026-05-01T00:00:00.000Z"),
    cancelledReason: "Moved away",
    archivedAt: null,
    archivedReason: null,
    ...overrides,
  };
}

function archiveRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: "archive-request-1",
    memberId: "member-1",
    action: "ARCHIVE",
    status: "REQUESTED",
    reason: "Former member confirmed cancellation",
    reviewNote: null,
    memberSnapshot: null,
    requestedByMemberId: "admin-1",
    requestedAt: now,
    reviewedByMemberId: null,
    reviewedAt: null,
    processedAt: null,
    createdAt: now,
    updatedAt: now,
    requestedBy: requestedBy(),
    reviewedBy: null,
    ...overrides,
  };
}

const countDelegates = [
  mockPrisma.memberLifecycleActionRequest,
  mockPrisma.booking,
  mockPrisma.bookingGuest,
  mockPrisma.payment,
  mockPrisma.paymentRefund,
  mockPrisma.paymentRecoveryOperation,
  mockPrisma.memberCredit,
  mockPrisma.adminCreditAdjustmentRequest,
  mockPrisma.refundRequest,
  mockPrisma.memberSubscription,
  mockPrisma.promoRedemption,
  mockPrisma.promoCodeAssignment,
  mockPrisma.nominationToken,
  mockPrisma.memberApplication,
  mockPrisma.membershipCancellationRequest,
  mockPrisma.membershipCancellationRequestParticipant,
  mockPrisma.familyGroupJoinRequest,
  mockPrisma.familyGroupMember,
  mockPrisma.member,
  mockPrisma.hutLeaderAssignment,
  mockPrisma.issueReport,
  mockPrisma.bookingModification,
  mockPrisma.deletionRequest,
];

describe("member delete lifecycle actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.member.findUnique.mockResolvedValue(cleanMember);
    mockPrisma.xeroObjectLink.findMany.mockResolvedValue([
      {
        id: "link-1",
        localModel: "Member",
        localId: "member-1",
        active: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);
    mockPrisma.xeroObjectLink.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.member.update.mockResolvedValue({ ...cleanMember, xeroContactId: null });
    mockPrisma.member.delete.mockResolvedValue(cleanMember);
    mockPrisma.memberLifecycleActionRequest.findMany.mockResolvedValue([]);
    mockPrisma.memberLifecycleActionRequest.findUnique.mockResolvedValue(deleteRequest());
    mockPrisma.memberLifecycleActionRequest.create.mockImplementation(
      async (args: { data: Record<string, unknown> }) =>
        deleteRequest({
          id: "request-created",
          ...args.data,
          requestedBy: requestedBy(),
        }),
    );
    mockPrisma.memberLifecycleActionRequest.update.mockImplementation(
      async (args: { data: Record<string, unknown> }) =>
        deleteRequest({
          ...args.data,
          status: args.data.status,
          requestedBy: requestedBy(),
          reviewedBy: args.data.reviewedByMemberId ? reviewedBy() : null,
        }),
    );
    mockPrisma.$transaction.mockImplementation(
      async (callback: (tx: typeof mockPrisma) => Promise<unknown>) =>
        callback(mockPrisma),
    );
    for (const delegate of countDelegates) {
      delegate.count.mockResolvedValue(0);
    }
  });

  it("reports blockers for meaningful member history", async () => {
    mockPrisma.booking.count.mockResolvedValue(1);
    mockPrisma.memberCredit.count.mockResolvedValue(2);

    const eligibility = await getMemberDeleteEligibility({
      memberId: "member-1",
      currentAdminMemberId: "admin-2",
    });

    expect(eligibility.eligible).toBe(false);
    expect(eligibility.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "owned_bookings", count: 1 }),
        expect.objectContaining({ code: "credits", count: 2 }),
      ]),
    );
  });

  it("creates a delete request only when the member is eligible", async () => {
    const result = await createMemberDeleteRequest({
      memberId: "member-1",
      requestedByMemberId: "admin-1",
      reason: " Created in error ",
    });

    expect(result.request.id).toBe("request-created");
    expect(mockPrisma.memberLifecycleActionRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "DELETE",
          memberId: "member-1",
          reason: "Created in error",
          requestedByMemberId: "admin-1",
          memberSnapshot: expect.objectContaining({
            member: expect.objectContaining({ id: "member-1" }),
          }),
        }),
      }),
    );
  });

  it("requires a different admin to review a delete request", async () => {
    await expect(
      reviewMemberDeleteRequest({
        requestId: "request-1",
        reviewedByMemberId: "admin-1",
        action: "approve",
      }),
    ).rejects.toMatchObject({
      name: "MemberLifecycleActionError",
      statusCode: 403,
    } satisfies Partial<MemberLifecycleActionError>);

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("approves by snapshotting, deactivating Xero links, clearing local Xero linkage, and hard deleting", async () => {
    const result = await reviewMemberDeleteRequest({
      requestId: "request-1",
      reviewedByMemberId: "admin-2",
      action: "approve",
      reviewNote: "Checked",
    });

    expect(result.request.status).toBe("APPROVED");
    expect(mockPrisma.xeroObjectLink.updateMany).toHaveBeenCalledWith({
      where: { localModel: "Member", localId: "member-1", active: true },
      data: { active: false },
    });
    expect(mockPrisma.member.update).toHaveBeenCalledWith({
      where: { id: "member-1" },
      data: { xeroContactId: null },
    });
    expect(mockPrisma.memberLifecycleActionRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "APPROVED",
          reviewNote: "Checked",
          reviewedByMemberId: "admin-2",
          memberSnapshot: expect.objectContaining({
            member: expect.objectContaining({ id: "member-1" }),
            xeroObjectLinks: expect.arrayContaining([
              expect.objectContaining({ id: "link-1" }),
            ]),
          }),
        }),
      }),
    );
    expect(mockPrisma.member.delete).toHaveBeenCalledWith({
      where: { id: "member-1" },
    });
  });

  it("blocks the legacy direct member DELETE endpoint", async () => {
    const response = await directDeleteMember();

    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toEqual({
      error:
        "Direct member deletion is disabled. Create a member delete lifecycle request and have a different admin approve it.",
    });
    expect(mockPrisma.member.update).not.toHaveBeenCalled();
    expect(mockPrisma.member.delete).not.toHaveBeenCalled();
  });
});

describe("member archive lifecycle actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.member.findUnique.mockResolvedValue(archiveTarget());
    mockPrisma.member.update.mockResolvedValue({
      ...archiveTarget(),
      archivedAt: now,
      archivedReason: "Former member confirmed cancellation",
    });
    mockPrisma.member.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.familyGroupMember.deleteMany.mockResolvedValue({ count: 2 });
    mockPrisma.memberLifecycleActionRequest.findFirst.mockResolvedValue(null);
    mockPrisma.memberLifecycleActionRequest.findUnique.mockResolvedValue(archiveRequest());
    mockPrisma.memberLifecycleActionRequest.create.mockImplementation(
      async (args: { data: Record<string, unknown> }) =>
        archiveRequest({
          id: "archive-request-created",
          ...args.data,
          requestedBy: requestedBy(),
        }),
    );
    mockPrisma.memberLifecycleActionRequest.update.mockImplementation(
      async (args: { data: Record<string, unknown> }) =>
        archiveRequest({
          ...args.data,
          requestedBy: requestedBy(),
          reviewedBy: args.data.reviewedByMemberId ? reviewedBy() : null,
        }),
    );
    mockPrisma.$transaction.mockImplementation(
      async (callback: (tx: typeof mockPrisma) => Promise<unknown>) =>
        callback(mockPrisma),
    );
  });

  it("requires cancellation before an archive request can be created", async () => {
    mockPrisma.member.findUnique.mockResolvedValue(
      archiveTarget({ active: true, canLogin: true, cancelledAt: null }),
    );

    await expect(
      createMemberArchiveRequest({
        memberId: "member-1",
        requestedByMemberId: "admin-1",
        reason: "Former member confirmed cancellation",
      }),
    ).rejects.toMatchObject({
      name: "MemberLifecycleActionError",
      statusCode: 409,
    } satisfies Partial<MemberLifecycleActionError>);

    expect(mockPrisma.memberLifecycleActionRequest.create).not.toHaveBeenCalled();
  });

  it("creates an archive request for a cancelled member", async () => {
    const result = await createMemberArchiveRequest({
      memberId: "member-1",
      requestedByMemberId: "admin-1",
      reason: " Former member confirmed cancellation ",
    });

    expect(result.request.id).toBe("archive-request-created");
    expect(mockPrisma.memberLifecycleActionRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "ARCHIVE",
          memberId: "member-1",
          reason: "Former member confirmed cancellation",
          requestedByMemberId: "admin-1",
        }),
      }),
    );
  });

  it("requires a different admin to review an archive request", async () => {
    await expect(
      reviewMemberArchiveRequest({
        requestId: "archive-request-1",
        reviewedByMemberId: "admin-1",
        action: "approve",
      }),
    ).rejects.toMatchObject({
      name: "MemberLifecycleActionError",
      statusCode: 403,
    } satisfies Partial<MemberLifecycleActionError>);

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("approves an archive request and removes operational family and email links", async () => {
    const result = await reviewMemberArchiveRequest({
      requestId: "archive-request-1",
      reviewedByMemberId: "admin-2",
      action: "approve",
      reviewNote: "Checked",
    });

    expect(result.request.status).toBe("APPROVED");
    expect(mockPrisma.familyGroupMember.deleteMany).toHaveBeenCalledWith({
      where: { memberId: "member-1" },
    });
    expect(mockPrisma.member.updateMany).toHaveBeenCalledWith({
      where: { parentMemberId: "member-1" },
      data: { parentMemberId: null },
    });
    expect(mockPrisma.member.updateMany).toHaveBeenCalledWith({
      where: { secondaryParentId: "member-1" },
      data: { secondaryParentId: null },
    });
    expect(mockPrisma.member.updateMany).toHaveBeenCalledWith({
      where: { inheritEmailFromId: "member-1" },
      data: { inheritEmailFromId: null },
    });
    expect(mockPrisma.member.update).toHaveBeenCalledWith({
      where: { id: "member-1" },
      data: expect.objectContaining({
        archivedAt: expect.any(Date),
        archivedReason: "Former member confirmed cancellation",
        archivedViaLifecycleActionRequestId: "archive-request-1",
        active: false,
        canLogin: false,
      }),
    });
  });

  it("records cleanup link counts in the archive_approved audit log metadata", async () => {
    mockPrisma.familyGroupMember.deleteMany.mockResolvedValueOnce({ count: 3 });
    mockPrisma.member.updateMany
      .mockResolvedValueOnce({ count: 4 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 2 });

    await reviewMemberArchiveRequest({
      requestId: "archive-request-1",
      reviewedByMemberId: "admin-2",
      action: "approve",
      reviewNote: "Checked",
    });

    const archiveApprovedCall = mockCreateAuditLog.mock.calls.find(
      ([entry]) => entry.action === "member_lifecycle.archive_approved",
    );
    expect(archiveApprovedCall).toBeDefined();
    const [archiveApprovedEntry] = archiveApprovedCall!;
    expect(archiveApprovedEntry.metadata).toEqual(
      expect.objectContaining({
        action: "ARCHIVE",
        cleanedFamilyGroupMembers: 3,
        nulledChildren: 4,
        nulledSecondaryParents: 1,
        nulledInheritance: 2,
      }),
    );
  });
});
