import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPrisma = vi.hoisted(() => {
  const countDelegate = () => ({ count: vi.fn().mockResolvedValue(0) });

  return {
    accessRoleDefinition: {
      // Empty definitions: resolution falls back to legacy bundles.
      findMany: vi.fn().mockResolvedValue([]),
    },
    member: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    mediaImage: {
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    memberLifecycleActionRequest: {
      count: vi.fn().mockResolvedValue(0),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
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
    membershipSubscriptionCharge: countDelegate(),
    promoRedemption: countDelegate(),
    promoRedemptionAllocation: countDelegate(),
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
    bookingChangeRequest: countDelegate(),
    deletionRequest: countDelegate(),
    xeroObjectLink: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn(),
    },
    // #2859: the hard delete removes the member's cached Xero contact in the
    // same transaction. Deleted rather than nulled — a row that exists holding
    // `null` reads to the outbound guard as "we looked, Xero's NZBN field is
    // empty", which is its permission to write a birthday there.
    xeroContactCache: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    xeroSyncOperation: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    auditLog: {
      create: vi.fn(),
    },
    $transaction: vi.fn(),
    $executeRaw: vi.fn().mockResolvedValue(1),
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
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
  auth: vi.fn().mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } }),
}));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: vi.fn().mockResolvedValue(null),
  requireAdmin: vi.fn().mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } },
  }),
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
// #2576 §8: the lifecycle change records the coverage re-evaluation it owes.
const hostingMocks = vi.hoisted(() => ({
  fanout: vi.fn(async (...args: unknown[]) => {
    void args;
    return 1;
  }),
  drain: vi.fn(async (...args: unknown[]) => {
    void args;
  }),
}));

// #2576 §8. "Membership becoming inactive, lapsed, cancelled or archived" is the FIRST
// change class the owner's decision names, and only the evaluator half of it was
// automatic — an archived or cancelled member correctly stops qualifying as an adult
// host, while nothing told the club to go and look at the bookings that had been relying
// on them. The lifecycle paths now record that obligation inside their own transaction,
// which means they read the bookings this person ATTENDS through the caller's `tx` — and
// this suite drives that transaction with a fake carrying only the lifecycle delegates.
//
// Mocked at the module boundary so the assertion here can be about the thing that
// belongs here: that the change RECORDS the re-evaluation and is never refused by it.
// What the re-evaluation then concludes is the hosting suites' subject.
vi.mock("@/lib/adult-member-hosting-review", () => ({
  enqueueHostingCoverageReevaluationForMember: (...args: unknown[]) =>
    hostingMocks.fanout(...args),
}));

vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({
  settleHostingCoverageAfterCommit: (...args: unknown[]) =>
    hostingMocks.drain(...args),
}));


import {
  getAdminMemberArchiveLifecycleRequests,
  getAdminMemberLifecycleRequests,
  createMemberArchiveRequest,
  createMemberDeleteRequest,
  getMemberDeleteEligibility,
  getPendingMemberArchiveReviewCount,
  getPendingMemberDeleteReviewCount,
  MemberLifecycleActionError,
  reviewMemberArchiveRequest,
  reviewMemberDeleteRequest,
} from "@/lib/member-lifecycle-actions";
import { DELETE as directDeleteMember } from "@/app/api/admin/members/[id]/route";
import { createAuditLog } from "@/lib/audit";
import {
  sendAdminMemberDeleteRejectedEmail,
  sendMemberArchiveApprovedEmail,
  sendMemberArchiveRejectedEmail,
} from "@/lib/email";

const mockCreateAuditLog = vi.mocked(createAuditLog);
const mockSendArchiveApproved = vi.mocked(sendMemberArchiveApprovedEmail);
const mockSendArchiveRejected = vi.mocked(sendMemberArchiveRejectedEmail);
const mockSendAdminDeleteRejected = vi.mocked(sendAdminMemberDeleteRejectedEmail);

const now = new Date("2026-05-24T10:00:00.000Z");

const cleanMember = {
  id: "member-1",
  email: "erroneous@example.test",
  photoImageId: "member-photo-img",
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
  accessRoles: [],
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

// #1886 F23: the review paths claim the request via a guarded updateMany and
// then re-load it for the include/return payload. Mirror that by deriving the
// re-loaded row from the data of the most recent claim, the same way the
// update mock derives its return value from args.data.
function lifecycleRequestFromLastClaim(
  base: (overrides?: Record<string, unknown>) => Record<string, unknown>,
) {
  return async () => {
    const lastClaim = mockPrisma.memberLifecycleActionRequest.updateMany.mock.calls.at(
      -1,
    )?.[0] as { data: Record<string, unknown> } | undefined;
    return base({
      ...(lastClaim?.data ?? {}),
      requestedBy: requestedBy(),
      reviewedBy: lastClaim?.data.reviewedByMemberId ? reviewedBy() : null,
    });
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
  mockPrisma.membershipSubscriptionCharge,
  mockPrisma.promoRedemptionAllocation,
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
  mockPrisma.bookingChangeRequest,
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
    mockPrisma.xeroSyncOperation.findFirst.mockResolvedValue(null);
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
    mockPrisma.memberLifecycleActionRequest.updateMany.mockResolvedValue({
      count: 1,
    });
    mockPrisma.memberLifecycleActionRequest.findUniqueOrThrow.mockImplementation(
      lifecycleRequestFromLastClaim(deleteRequest),
    );
    mockPrisma.$transaction.mockImplementation(
      async (callback: (tx: typeof mockPrisma) => Promise<unknown>) =>
        callback(mockPrisma),
    );
    for (const delegate of countDelegates) {
      delegate.count.mockResolvedValue(0);
    }
    // #2255: the hard delete now reads who it is about to detach (before the
    // row goes and `onDelete: SetNull` erases the evidence) and clears the
    // `inheritParentEmail: true` flag those members would otherwise be left
    // holding beside a NULL pointer.
    mockPrisma.member.findMany.mockResolvedValue([]);
    mockPrisma.member.updateMany.mockResolvedValue({ count: 0 });
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

  /**
   * #2255 (D9). Delete eligibility counts DIRECT dependants only — members
   * whose `parentMemberId` or `secondaryParentId` names this member. Four
   * generations do not change that, and the reasoning is worth pinning because
   * "counts direct only" looks like an oversight until you follow it through:
   *
   *  - a MIDDLE generation with dependants of their own is still blocked, so a
   *    delete can never strand a grandchild whose only recorded parent it was;
   *  - a GRANDPARENT is blocked while their child is still linked to them, and
   *    becomes deletable once that one link is cleared — at which point the
   *    grandchildren are untouched, because they were never linked to the
   *    grandparent in the first place. There is nothing dangling to protect.
   *
   * Counting descendants transitively instead would block deleting a
   * great-grandparent who has no remaining link to anyone, for the sake of a
   * relationship the database no longer records.
   */
  describe("dependants blocker at depth (#2255)", () => {
    it("blocks a middle generation who still holds dependants", async () => {
      mockPrisma.member.count.mockResolvedValue(1);

      const eligibility = await getMemberDeleteEligibility({
        memberId: "member-1",
        currentAdminMemberId: "admin-2",
      });

      expect(eligibility.eligible).toBe(false);
      expect(eligibility.blockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "dependants", count: 1 }),
        ]),
      );
    });

    it("counts only DIRECT links, through either parent column", async () => {
      await getMemberDeleteEligibility({
        memberId: "member-1",
        currentAdminMemberId: "admin-2",
      });

      // Not `dependents: { some: { dependents: { some: {} } } }` or any other
      // transitive shape: exactly the two columns that name this member.
      expect(mockPrisma.member.count).toHaveBeenCalledWith({
        where: {
          OR: [
            { parentMemberId: "member-1" },
            { secondaryParentId: "member-1" },
          ],
        },
      });
    });

    it("clears a grandparent once their own child link is gone, grandchildren and all", async () => {
      // No member names this one as a parent any more. Their former child may
      // still head a family of their own; that is that member's business.
      mockPrisma.member.count.mockResolvedValue(0);

      const eligibility = await getMemberDeleteEligibility({
        memberId: "member-1",
        currentAdminMemberId: "admin-2",
      });

      expect(eligibility.blockers).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "dependants" })]),
      );
      expect(eligibility.eligible).toBe(true);
    });
  });

  it("ignores placeholder subscription rows without invoice or payment history", async () => {
    const eligibility = await getMemberDeleteEligibility({
      memberId: "member-1",
      currentAdminMemberId: "admin-2",
    });

    expect(eligibility.eligible).toBe(true);
    expect(eligibility.blockers).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "subscriptions" }),
      ]),
    );
    expect(mockPrisma.memberSubscription.count).toHaveBeenCalledWith({
      where: {
        memberId: "member-1",
        OR: [
          { status: { in: ["UNPAID", "PAID", "OVERDUE"] } },
          { xeroInvoiceId: { not: null } },
          { xeroInvoiceNumber: { not: null } },
          { xeroOnlineInvoiceUrl: { not: null } },
          { paidAt: { not: null } },
          { chargeCoverage: { some: {} } },
        ],
      },
    });
  });

  it("reports subscription blockers when invoice, payment, or immutable charge coverage history exists", async () => {
    mockPrisma.memberSubscription.count.mockResolvedValue(1);

    const eligibility = await getMemberDeleteEligibility({
      memberId: "member-1",
      currentAdminMemberId: "admin-2",
    });

    expect(eligibility.eligible).toBe(false);
    expect(eligibility.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "subscriptions",
          label: "Membership subscriptions with invoice or payment history exist.",
          count: 1,
        }),
      ]),
    );
    expect(mockPrisma.memberSubscription.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        OR: expect.arrayContaining([{ chargeCoverage: { some: {} } }]),
      }),
    });
  });

  it("blocks delete eligibility when subscription charges name the member as invoice recipient (#1886 F34)", async () => {
    // recipientMemberId is a RESTRICT FK: a member who is only the billing
    // recipient of a family subscription charge (e.g. after a group
    // dissolves) must surface as a 409 blocker instead of an unhandled
    // P2003 at member.delete time.
    mockPrisma.membershipSubscriptionCharge.count.mockResolvedValue(2);

    const eligibility = await getMemberDeleteEligibility({
      memberId: "member-1",
      currentAdminMemberId: "admin-2",
    });

    expect(eligibility.eligible).toBe(false);
    expect(eligibility.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "subscription_charge_recipient",
          label:
            "Membership subscription charges name this member as invoice recipient.",
          count: 2,
        }),
      ]),
    );
    expect(mockPrisma.membershipSubscriptionCharge.count).toHaveBeenCalledWith({
      where: { recipientMemberId: "member-1" },
    });
  });

  it("rejects delete approval with 409 before member.delete when the member is a subscription charge recipient (#1886 F34)", async () => {
    mockPrisma.membershipSubscriptionCharge.count.mockResolvedValue(1);

    await expect(
      reviewMemberDeleteRequest({
        requestId: "request-1",
        reviewedByMemberId: "admin-2",
        action: "approve",
      }),
    ).rejects.toMatchObject({
      name: "MemberLifecycleActionError",
      statusCode: 409,
      message: "This member cannot be deleted while blockers exist.",
    } satisfies Partial<MemberLifecycleActionError>);

    expect(mockPrisma.member.delete).not.toHaveBeenCalled();
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
      // Also selects photoImageId so the blob scrub can target the member's photo.
      select: { photoImageId: true },
    });
    // #2859: and the cached Xero contact goes with it. This is the STRONGER of
    // the two erasure paths — the Member row itself is removed — so leaving a
    // XeroContactCache row holding the deleted member's date of birth, name,
    // email, phone and address would be the plainer version of the defect the
    // anonymising path fixes. Deleted, not nulled: a row that exists holding
    // `null` reads to `buildXeroContactCompanyNumberPatch` as "we looked, and
    // Xero's NZBN field is empty", which is its permission to write a birthday
    // into a field Xero still holds a business number in (#2873).
    expect(mockPrisma.xeroContactCache.deleteMany).toHaveBeenCalledWith({
      where: { contactId: "xero-contact-1" },
    });
    // #1886 F23: the approval is written through a status-guarded claim so a
    // concurrently-reviewed request can never be overwritten.
    expect(
      mockPrisma.memberLifecycleActionRequest.updateMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "request-1", status: "REQUESTED" },
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
    // review #4: the member's own MEMBER_PHOTO blob is scrubbed in the same
    // transaction (sparing blobs still referenced by another surviving member),
    // so a hard-delete leaves no orphaned photo bytes.
    expect(mockPrisma.mediaImage.deleteMany).toHaveBeenCalledWith({
      where: {
        kind: "MEMBER_PHOTO",
        OR: [
          { uploadedByMemberId: "member-1" },
          { id: "member-photo-img" },
        ],
        photoOfMembers: { none: { id: { not: "member-1" } } },
      },
    });
  });

  it("refuses hard delete before its review claim when a Xero contact change is unresolved", async () => {
    mockPrisma.xeroSyncOperation.findFirst.mockResolvedValue({
      id: "contact-operation-1",
    });

    await expect(
      reviewMemberDeleteRequest({
        requestId: "request-1",
        reviewedByMemberId: "admin-2",
        action: "approve",
      }),
    ).rejects.toMatchObject({
      name: "XeroContactCreateBlocksDeletionError",
      code: "XERO_CONTACT_CREATE_BLOCKS_DELETION",
      statusCode: 409,
    });

    expect(mockPrisma.memberLifecycleActionRequest.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.xeroObjectLink.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.member.update).not.toHaveBeenCalled();
    expect(mockPrisma.member.delete).not.toHaveBeenCalled();
  });

  /**
   * #2627 defect 1. The Xero contact fence on this path reached a check that
   * refuses ANY member carrying the anonymisation marker — precisely what a
   * completed self-service deletion approval writes. It raised
   * `XeroMemberUnavailableError`, which appears nowhere in
   * `member-lifecycle-actions.ts` and nowhere in the lifecycle action-request
   * route (which maps only the hosting retry, the contact-create blocker, and
   * its own lifecycle error). So a member who had already been through approved
   * deletion could never afterwards be hard deleted, and the operator got a bare
   * 500 with no code and no remedy.
   *
   * Xero availability is also the wrong question about such a member:
   * anonymisation already nulled `Member.xeroContactId` and deactivated every
   * active Member CONTACT ledger row, so there is no contact linkage left to
   * protect. The fence keeps its row lock and its blocker re-check; it simply no
   * longer asks that question.
   */
  it("hard-deletes a member already anonymised by an approved self-service deletion", async () => {
    const anonymised = {
      ...cleanMember,
      firstName: "Deleted",
      lastName: "Member",
      // Both halves of the canonical marker, either of which used to be enough
      // to make this delete impossible.
      email: "deleted-member-1@deleted.invalid",
      passwordHash: "DELETED_ACCOUNT",
      active: false,
      xeroContactId: null,
    };
    mockPrisma.member.findUnique.mockResolvedValue(anonymised);
    mockPrisma.member.update.mockResolvedValue({
      ...anonymised,
      xeroContactId: null,
    });
    mockPrisma.member.delete.mockResolvedValue(anonymised);

    const result = await reviewMemberDeleteRequest({
      requestId: "request-1",
      reviewedByMemberId: "admin-2",
      action: "approve",
      reviewNote: "Duplicate of an already-deleted account",
    });

    expect(result.request.status).toBe("APPROVED");
    expect(mockPrisma.member.delete).toHaveBeenCalledWith({
      where: { id: "member-1" },
    });
    // The rest of the fence is intact: the row was still taken FOR UPDATE and
    // the contact-change blocker still re-checked under it.
    expect(mockPrisma.$executeRaw).toHaveBeenCalled();
    expect(mockPrisma.xeroSyncOperation.findFirst).toHaveBeenCalled();
  });

  /**
   * #2255 (R5a). Hard delete is the FOURTH removal path, and the only one that
   * left the detaching to the database. `onDelete: SetNull` does clear the
   * dependants' parent columns and their `inheritEmailFromId` — but silently,
   * and it leaves `inheritParentEmail: true` standing beside a NULL pointer,
   * a combination no writer produces and no reader expects.
   */
  describe("declares and tidies the family links it detaches (#2255)", () => {
    function detaching(
      dependants: Array<{ id: string; firstName: string; lastName: string; email: string }>,
      inheritors: Array<{ id: string; firstName: string; lastName: string; email: string }> = [],
    ) {
      // #2716: BOTH reads are now `OR` queries — the parent read has always
      // been one (`parentMemberId` / `secondaryParentId`), and the inheritor
      // read became one when it started matching the CHOICE column as well as
      // the pointer. Routing on a top-level `where.inheritEmailFromId` therefore
      // stopped matching anything and sent the inheritor read to the dependant
      // fixture. Route on which COLUMNS the clauses name instead, which is what
      // the two reads have actually always differed by.
      mockPrisma.member.findMany.mockImplementation(async ({ where }: any) => {
        const clauses: Array<Record<string, unknown>> = where?.OR ?? [where ?? {}];
        const readsInheritance = clauses.some(
          (clause) =>
            "inheritEmailFromId" in clause || "inheritEmailChoiceId" in clause,
        );
        return readsInheritance ? inheritors : dependants;
      });
    }

    it("returns and audits the members it detached", async () => {
      detaching(
        [{ id: "kid-1", firstName: "Ana", lastName: "Smith", email: "ana@example.org" }],
        [{ id: "kid-2", firstName: "Ben", lastName: "Smith", email: "ben@example.org" }],
      );

      const result = await reviewMemberDeleteRequest({
        requestId: "request-1",
        reviewedByMemberId: "admin-2",
        action: "approve",
        reviewNote: "Checked",
      });

      expect(result.orphanedLinks.dependants).toEqual([
        { id: "kid-1", name: "Ana Smith", email: "ana@example.org" },
      ]);
      expect(result.orphanedLinks.emailInheritors).toEqual([
        { id: "kid-2", name: "Ben Smith", email: "ben@example.org" },
      ]);
      // #2716: and the inheritor read must ASK about both columns. A member
      // whose chosen source is temporarily unreachable holds the choice with a
      // NULL pointer; they were already waiting on that mailbox, and deleting
      // the member is what makes the wait permanent — so leaving them out of the
      // declaration would be the exact silence this helper exists to end.
      expect(mockPrisma.member.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [
              { inheritEmailFromId: "member-1" },
              { inheritEmailChoiceId: "member-1" },
            ],
          },
        }),
      );
    });

    it("clears the inheritParentEmail flag SetNull would have stranded", async () => {
      detaching(
        [],
        [{ id: "kid-2", firstName: "Ben", lastName: "Smith", email: "ben@example.org" }],
      );

      await reviewMemberDeleteRequest({
        requestId: "request-1",
        reviewedByMemberId: "admin-2",
        action: "approve",
        reviewNote: "Checked",
      });

      // Guarded on the pointer already being NULL, so it can only ever tidy a
      // flag the delete itself stranded — never a live inheritance.
      //
      // #2716 added the second half of that guard: the repair is now scoped on
      // `inheritEmailChoiceId: null` too (it used to test the pointer alone).
      // Both self-relations carry `onDelete: SetNull`, so the deleted row takes
      // the CHOICE with it as well — but a member who still holds a choice has a
      // live decision naming somebody else, and clearing `inheritParentEmail`
      // for them would erase the record of where their mail is meant to go.
      expect(mockPrisma.member.updateMany).toHaveBeenCalledWith({
        where: {
          id: { in: ["kid-2"] },
          inheritEmailFromId: null,
          inheritEmailChoiceId: null,
        },
        data: { inheritParentEmail: false },
      });
    });

    it("reads the links BEFORE the row is deleted", async () => {
      // Afterwards there is nothing left to read: the FK cascade has already
      // nulled every column that named this member.
      detaching([{ id: "kid-1", firstName: "Ana", lastName: "Smith", email: "a@e.org" }]);

      await reviewMemberDeleteRequest({
        requestId: "request-1",
        reviewedByMemberId: "admin-2",
        action: "approve",
        reviewNote: "Checked",
      });

      const readOrder = mockPrisma.member.findMany.mock.invocationCallOrder[0];
      const deleteOrder = mockPrisma.member.delete.mock.invocationCallOrder[0];
      expect(readOrder).toBeLessThan(deleteOrder);
    });

    it("reports empty lists rather than omitting them", async () => {
      const result = await reviewMemberDeleteRequest({
        requestId: "request-1",
        reviewedByMemberId: "admin-2",
        action: "approve",
        reviewNote: "Checked",
      });

      expect(result.orphanedLinks).toEqual({
        dependants: [],
        emailInheritors: [],
      });
    });
  });

  it("bails with 409 and performs no destructive work when the delete approve claim race-loses (#1886 F23)", async () => {
    // Simulate a concurrent reviewer (e.g. a reject) committing after our
    // pre-transaction status read: the guarded review claim matches zero rows.
    mockPrisma.memberLifecycleActionRequest.updateMany.mockResolvedValue({
      count: 0,
    });

    await expect(
      reviewMemberDeleteRequest({
        requestId: "request-1",
        reviewedByMemberId: "admin-2",
        action: "approve",
      }),
    ).rejects.toMatchObject({
      name: "MemberLifecycleActionError",
      statusCode: 409,
      message: "This delete request has already been reviewed.",
    } satisfies Partial<MemberLifecycleActionError>);

    // The losing racer must bail before any destructive write.
    expect(mockPrisma.member.delete).not.toHaveBeenCalled();
    expect(mockPrisma.xeroObjectLink.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.member.update).not.toHaveBeenCalled();
  });

  it("bails with 409 when the delete reject claim race-loses (#1886 F23)", async () => {
    mockPrisma.memberLifecycleActionRequest.updateMany.mockResolvedValue({
      count: 0,
    });

    await expect(
      reviewMemberDeleteRequest({
        requestId: "request-1",
        reviewedByMemberId: "admin-2",
        action: "reject",
      }),
    ).rejects.toMatchObject({
      name: "MemberLifecycleActionError",
      statusCode: 409,
      message: "This delete request has already been reviewed.",
    } satisfies Partial<MemberLifecycleActionError>);

    expect(mockCreateAuditLog).not.toHaveBeenCalled();
    expect(mockSendAdminDeleteRejected).not.toHaveBeenCalled();
  });

  it("still emails the requesting admin on a delete reject when notifyMember is false (#1788 carve-out)", async () => {
    // The delete-flow emails go to the requesting admin, not the target member,
    // so an archive-style suppression must never touch them.
    const result = await reviewMemberDeleteRequest({
      requestId: "request-1",
      reviewedByMemberId: "admin-2",
      action: "reject",
      reviewNote: "Not now",
      notifyMember: false,
    });

    expect(result.request.status).toBe("REJECTED");
    expect(mockSendAdminDeleteRejected).toHaveBeenCalledTimes(1);
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
    mockPrisma.member.findMany.mockResolvedValue([archiveTarget()]);
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
    mockPrisma.memberLifecycleActionRequest.updateMany.mockResolvedValue({
      count: 1,
    });
    mockPrisma.memberLifecycleActionRequest.findUniqueOrThrow.mockImplementation(
      lifecycleRequestFromLastClaim(archiveRequest),
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

  it("lists pending archive requests for admin review", async () => {
    mockPrisma.memberLifecycleActionRequest.findMany.mockResolvedValueOnce([
      archiveRequest(),
    ]);
    mockPrisma.memberLifecycleActionRequest.count
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(3);

    const result = await getAdminMemberArchiveLifecycleRequests({
      status: "REQUESTED",
      page: 1,
      pageSize: 25,
    });

    expect(mockPrisma.memberLifecycleActionRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { action: "ARCHIVE", status: "REQUESTED" },
        take: 25,
      }),
    );
    expect(mockPrisma.member.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["member-1"] } },
      select: expect.objectContaining({ archivedAt: true }),
    });
    expect(result.total).toBe(1);
    expect(result.pendingCount).toBe(3);
    expect(result.requests[0]).toMatchObject({
      id: "archive-request-1",
      member: {
        id: "member-1",
        name: "Former Member",
        email: "former@example.test",
      },
    });
  });

  it("counts pending archive requests for review badges", async () => {
    mockPrisma.memberLifecycleActionRequest.count.mockResolvedValueOnce(2);

    await expect(getPendingMemberArchiveReviewCount()).resolves.toBe(2);
    expect(mockPrisma.memberLifecycleActionRequest.count).toHaveBeenCalledWith({
      where: { action: "ARCHIVE", status: "REQUESTED" },
    });
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

    // #2576 §8, and §17's required test that "source membership lapse or archival causes
    // re-evaluation". An archived member stops qualifying as an adult host, so a
    // confirmed booking that was relying on them is now uncovered - and before this the
    // club was never told: no incident, no owner email, no officer-queue entry, and the
    // booking's own review snapshot still reading "compliant". Worse, the OWNER's next
    // edit was then blamed for it, because "newly uncovered" is judged against exactly
    // that stale snapshot, so they could not cancel or amend the booking that used to
    // supply the cover without being told to fix the other one first.
    //
    // Recorded for the ARCHIVED MEMBER, inside the archive's own transaction, so the two
    // commit or roll back together. It never refuses the archive.
    expect(hostingMocks.fanout).toHaveBeenCalledTimes(1);
    const call = hostingMocks.fanout.mock.calls[0];
    expect(call?.[0]).toBe("member-1");
    expect(call?.[2]).toBeInstanceOf(Date);
    const context = call?.[3];
    expect(context).toMatchObject({
      cause: "SYSTEM_CHANGE",
      actorMemberId: "admin-2",
    });
    // Drained after the commit, and unfiltered: one person can attend bookings owned by
    // several accounts at several lodges, so there is no single owner key to scope to.
    expect(hostingMocks.drain).toHaveBeenCalledTimes(1);
    // #1886 F23: the approval claims the request row guarded on status.
    expect(
      mockPrisma.memberLifecycleActionRequest.updateMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "archive-request-1", status: "REQUESTED" },
        data: expect.objectContaining({ status: "APPROVED" }),
      }),
    );
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
    // #2716: the archive sweep now matches on the CHOICE as well as the pointer
    // and clears BOTH. It used to be `where: { inheritEmailFromId: "member-1" }`
    // / `data: { inheritEmailFromId: null }`, which missed the dependants with
    // most to lose: a member whose chosen source has temporarily gone
    // unreachable holds the choice beside a NULL pointer, so the pointer-only
    // sweep left them recorded as waiting on an address that — since nothing in
    // the product un-archives a member — is never coming back.
    expect(mockPrisma.member.updateMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { inheritEmailFromId: "member-1" },
          { inheritEmailChoiceId: "member-1" },
        ],
      },
      data: { inheritEmailFromId: null, inheritEmailChoiceId: null },
    });
    expect(mockPrisma.member.updateMany).toHaveBeenCalledWith({
      where: { id: "member-1", archivedAt: null },
      data: expect.objectContaining({
        archivedAt: expect.any(Date),
        archivedReason: "Former member confirmed cancellation",
        archivedViaLifecycleActionRequestId: "archive-request-1",
        active: false,
        canLogin: false,
      }),
    });
  });

  it("rejects the approval with 409 when the archive claim race-loses", async () => {
    // Simulate a concurrent approver winning: the archive updateMany
    // matches zero rows because archivedAt is already non-null. The
    // happy-path beforeEach sets member.updateMany to { count: 1 } for
    // the three cleanup updateMany calls; override the fourth (the
    // claim) to { count: 0 }.
    mockPrisma.member.updateMany
      .mockResolvedValueOnce({ count: 1 }) // parentMemberId cleanup
      .mockResolvedValueOnce({ count: 1 }) // secondaryParentId cleanup
      .mockResolvedValueOnce({ count: 1 }) // inheritEmailFromId + choice cleanup
      .mockResolvedValueOnce({ count: 1 }) // billingFamilyGroupId cleanup (#1932, E6)
      .mockResolvedValueOnce({ count: 0 }); // archive claim - LOST

    await expect(
      reviewMemberArchiveRequest({
        requestId: "archive-request-1",
        reviewedByMemberId: "admin-2",
        action: "approve",
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
    } satisfies Partial<MemberLifecycleActionError>);
  });

  it("bails with 409 and performs no archive writes when the archive approve review claim race-loses (#1886 F23)", async () => {
    // Simulate a concurrent reviewer committing first: the guarded review
    // claim on the request row matches zero rows.
    mockPrisma.memberLifecycleActionRequest.updateMany.mockResolvedValue({
      count: 0,
    });

    await expect(
      reviewMemberArchiveRequest({
        requestId: "archive-request-1",
        reviewedByMemberId: "admin-2",
        action: "approve",
      }),
    ).rejects.toMatchObject({
      name: "MemberLifecycleActionError",
      statusCode: 409,
      message: "This archive request has already been reviewed.",
    } satisfies Partial<MemberLifecycleActionError>);

    // The losing racer must bail before any link cleanup or member write.
    expect(mockPrisma.familyGroupMember.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.member.updateMany).not.toHaveBeenCalled();
  });

  it("bails with 409 when the archive reject claim race-loses (#1886 F23)", async () => {
    mockPrisma.memberLifecycleActionRequest.updateMany.mockResolvedValue({
      count: 0,
    });

    await expect(
      reviewMemberArchiveRequest({
        requestId: "archive-request-1",
        reviewedByMemberId: "admin-2",
        action: "reject",
      }),
    ).rejects.toMatchObject({
      name: "MemberLifecycleActionError",
      statusCode: 409,
      message: "This archive request has already been reviewed.",
    } satisfies Partial<MemberLifecycleActionError>);

    expect(mockSendArchiveRejected).not.toHaveBeenCalled();
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

  // #1788: per-review member-email choice on the two target-member sends.
  function archiveRejectedMetadata() {
    return mockCreateAuditLog.mock.calls.find(
      ([entry]) => entry.action === "member_lifecycle.archive_rejected",
    )?.[0].metadata;
  }

  function archiveApprovedMetadata() {
    return mockCreateAuditLog.mock.calls.find(
      ([entry]) => entry.action === "member_lifecycle.archive_approved",
    )?.[0].metadata;
  }

  it("emails the target member and records no notify field on a default reject (#1788)", async () => {
    const result = await reviewMemberArchiveRequest({
      requestId: "archive-request-1",
      reviewedByMemberId: "admin-2",
      action: "reject",
      reviewNote: "Keep active",
    });

    expect(result.request.status).toBe("REJECTED");
    expect(mockSendArchiveRejected).toHaveBeenCalledTimes(1);
    expect(archiveRejectedMetadata()).not.toHaveProperty("notifyMember");
  });

  it("suppresses the reject email and audits the choice when notifyMember is false (#1788)", async () => {
    const result = await reviewMemberArchiveRequest({
      requestId: "archive-request-1",
      reviewedByMemberId: "admin-2",
      action: "reject",
      notifyMember: false,
    });

    // The rejection state change is still applied.
    expect(result.request.status).toBe("REJECTED");
    expect(mockSendArchiveRejected).not.toHaveBeenCalled();
    expect(archiveRejectedMetadata()).toMatchObject({ notifyMember: false });
  });

  it("emails and records no notify field on a reject with notifyMember true (#1788)", async () => {
    await reviewMemberArchiveRequest({
      requestId: "archive-request-1",
      reviewedByMemberId: "admin-2",
      action: "reject",
      notifyMember: true,
    });

    expect(mockSendArchiveRejected).toHaveBeenCalledTimes(1);
    expect(archiveRejectedMetadata()).not.toHaveProperty("notifyMember");
  });

  it("emails the target member and records no notify field on a default approve (#1788)", async () => {
    await reviewMemberArchiveRequest({
      requestId: "archive-request-1",
      reviewedByMemberId: "admin-2",
      action: "approve",
    });

    expect(mockSendArchiveApproved).toHaveBeenCalledTimes(1);
    expect(archiveApprovedMetadata()).not.toHaveProperty("notifyMember");
  });

  it("suppresses the approve email, still archives, and audits the choice when notifyMember is false (#1788)", async () => {
    const result = await reviewMemberArchiveRequest({
      requestId: "archive-request-1",
      reviewedByMemberId: "admin-2",
      action: "approve",
      notifyMember: false,
    });

    expect(result.request.status).toBe("APPROVED");
    // The archive claim (state change) still runs regardless of the choice.
    expect(mockPrisma.member.updateMany).toHaveBeenCalledWith({
      where: { id: "member-1", archivedAt: null },
      data: expect.objectContaining({
        archivedAt: expect.any(Date),
        active: false,
        canLogin: false,
      }),
    });
    expect(mockSendArchiveApproved).not.toHaveBeenCalled();
    expect(archiveApprovedMetadata()).toMatchObject({ notifyMember: false });
  });

  it("records no notify field and sends nothing for a member with no email even when notifyMember is false (#1788 honesty rule)", async () => {
    mockPrisma.member.findUnique.mockResolvedValue(archiveTarget({ email: "" }));

    const result = await reviewMemberArchiveRequest({
      requestId: "archive-request-1",
      reviewedByMemberId: "admin-2",
      action: "reject",
      notifyMember: false,
    });

    expect(result.request.status).toBe("REJECTED");
    expect(mockSendArchiveRejected).not.toHaveBeenCalled();
    expect(archiveRejectedMetadata()).not.toHaveProperty("notifyMember");
  });
});

// Issue #1604: only a Full Admin may archive an account holding a privileged
// role (the privileged-target guard), enforced canLogin-blind at both request
// creation and approval. The last-admin backstop is vacuous on this path
// because archive requires a prior cancellation (which already cleared
// canLogin), so a cancelled admin is never a counted active Full Admin.
describe("member archive admin-account guards (#1604)", () => {
  const cancelledAdmin = () =>
    archiveTarget({
      role: "ADMIN",
      financeAccessLevel: "NONE",
      accessRoles: [{ role: "ADMIN" }],
    });

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.memberLifecycleActionRequest.findFirst.mockResolvedValue(null);
    mockPrisma.memberLifecycleActionRequest.findUnique.mockResolvedValue(
      archiveRequest(),
    );
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
          reviewedBy: reviewedBy(),
        }),
    );
    mockPrisma.memberLifecycleActionRequest.updateMany.mockResolvedValue({
      count: 1,
    });
    mockPrisma.memberLifecycleActionRequest.findUniqueOrThrow.mockImplementation(
      lifecycleRequestFromLastClaim(archiveRequest),
    );
    mockPrisma.member.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.familyGroupMember.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.$transaction.mockImplementation(
      async (callback: (tx: typeof mockPrisma) => Promise<unknown>) =>
        callback(mockPrisma),
    );
  });

  it("privileged-target: a scoped admin cannot request archive of an admin-holding account (403)", async () => {
    mockPrisma.member.findUnique.mockResolvedValue(cancelledAdmin());
    mockPrisma.member.count.mockResolvedValue(0); // requester is not a Full Admin

    await expect(
      createMemberArchiveRequest({
        memberId: "member-1",
        requestedByMemberId: "membership-officer",
        reason: "Cleaning up records",
      }),
    ).rejects.toMatchObject({
      name: "MemberLifecycleActionError",
      statusCode: 403,
    } satisfies Partial<MemberLifecycleActionError>);

    expect(
      mockPrisma.memberLifecycleActionRequest.create,
    ).not.toHaveBeenCalled();
  });

  it("privileged-target: a Full Admin can request archive of an admin-holding account", async () => {
    mockPrisma.member.findUnique.mockResolvedValue(cancelledAdmin());
    mockPrisma.member.count.mockResolvedValue(1); // requester is a Full Admin

    const result = await createMemberArchiveRequest({
      memberId: "member-1",
      requestedByMemberId: "full-admin",
      reason: "Cleaning up records",
    });

    expect(result.request.id).toBe("archive-request-created");
  });

  it("privileged-target: a scoped admin cannot approve archive of an admin-holding account (403)", async () => {
    mockPrisma.member.findUnique.mockResolvedValue(cancelledAdmin());
    mockPrisma.member.count.mockResolvedValue(0); // reviewer is not a Full Admin

    await expect(
      reviewMemberArchiveRequest({
        requestId: "archive-request-1",
        reviewedByMemberId: "membership-officer",
        action: "approve",
      }),
    ).rejects.toMatchObject({
      name: "MemberLifecycleActionError",
      statusCode: 403,
    } satisfies Partial<MemberLifecycleActionError>);

    expect(mockPrisma.member.updateMany).not.toHaveBeenCalled();
  });

  it("privileged-target: a Full Admin can approve archive of an admin-holding account", async () => {
    mockPrisma.member.findUnique.mockResolvedValue(cancelledAdmin());
    // actorIsFullAdmin -> 1; the last-admin target count -> 0 (a cancelled
    // admin is not an active Full Admin), so the backstop short-circuits.
    mockPrisma.member.count
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);

    const result = await reviewMemberArchiveRequest({
      requestId: "archive-request-1",
      reviewedByMemberId: "full-admin",
      action: "approve",
    });

    expect(result.request.status).toBe("APPROVED");
  });
});

// #1938: the admin review list is now parameterised by action. DELETE feeds the
// admin-initiated section on /admin/deletion-requests; the serializer must stay
// snapshot-safe because an APPROVED DELETE has already removed the target row.
describe("admin member lifecycle request list (#1938)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists DELETE requests, carrying the live member and requestedByMemberId", async () => {
    mockPrisma.memberLifecycleActionRequest.findMany.mockResolvedValueOnce([
      deleteRequest(),
    ]);
    mockPrisma.memberLifecycleActionRequest.count
      .mockResolvedValueOnce(1) // total
      .mockResolvedValueOnce(2); // pending (REQUESTED)
    mockPrisma.member.findMany.mockResolvedValueOnce([archiveTarget()]);

    const result = await getAdminMemberLifecycleRequests({
      action: "DELETE",
      status: "REQUESTED",
      page: 1,
      pageSize: 25,
    });

    expect(
      mockPrisma.memberLifecycleActionRequest.findMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { action: "DELETE", status: "REQUESTED" },
      }),
    );
    expect(result.total).toBe(1);
    expect(result.pendingCount).toBe(2);
    expect(result.requests[0]).toMatchObject({
      id: "request-1",
      requestedByMemberId: "admin-1",
      targetName: "Former Member",
      member: { id: "member-1", name: "Former Member" },
    });
  });

  it("falls back to the snapshot name when an approved DELETE target is gone", async () => {
    mockPrisma.memberLifecycleActionRequest.findMany.mockResolvedValueOnce([
      deleteRequest({
        status: "APPROVED",
        memberSnapshot: {
          member: {
            firstName: "Gone",
            lastName: "Away",
            email: "gone@example.test",
          },
        },
      }),
    ]);
    mockPrisma.memberLifecycleActionRequest.count
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);
    // Target already hard-deleted: the member lookup misses.
    mockPrisma.member.findMany.mockResolvedValueOnce([]);

    const result = await getAdminMemberLifecycleRequests({
      action: "DELETE",
      status: "APPROVED",
    });

    expect(result.requests[0].member).toBeNull();
    expect(result.requests[0].targetName).toBe("Gone Away");
  });

  it("maps ALL to an action-only filter", async () => {
    mockPrisma.memberLifecycleActionRequest.findMany.mockResolvedValueOnce([]);
    mockPrisma.memberLifecycleActionRequest.count
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);

    await getAdminMemberLifecycleRequests({ action: "DELETE", status: "ALL" });

    expect(
      mockPrisma.memberLifecycleActionRequest.findMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ where: { action: "DELETE" } }),
    );
  });

  it("keeps the ARCHIVE wrapper querying ARCHIVE for back-compat", async () => {
    mockPrisma.memberLifecycleActionRequest.findMany.mockResolvedValueOnce([]);
    mockPrisma.memberLifecycleActionRequest.count
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);

    await getAdminMemberArchiveLifecycleRequests({ status: "REQUESTED" });

    expect(
      mockPrisma.memberLifecycleActionRequest.findMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { action: "ARCHIVE", status: "REQUESTED" },
      }),
    );
  });

  it("counts pending DELETE requests for the review badge", async () => {
    mockPrisma.memberLifecycleActionRequest.count.mockResolvedValueOnce(4);

    await expect(getPendingMemberDeleteReviewCount()).resolves.toBe(4);
    expect(mockPrisma.memberLifecycleActionRequest.count).toHaveBeenCalledWith({
      where: { action: "DELETE", status: "REQUESTED" },
    });
  });
});
