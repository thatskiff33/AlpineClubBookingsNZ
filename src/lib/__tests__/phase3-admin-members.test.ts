import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { PLACEHOLDER_CONTACT_EMAIL_DOMAINS } from "@/lib/placeholder-contact-email";

// Mock dependencies
vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    accessRoleDefinition: {
      // Empty definitions: permission resolution falls back to the legacy
      // hardcoded bundles, matching this suite's pre-definitions behavior.
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn(),
    },
    memberAccessRole: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    booking: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn(),
      aggregate: vi.fn(),
    },
    bookingGuest: { count: vi.fn().mockResolvedValue(0) },
    payment: { count: vi.fn().mockResolvedValue(0) },
    paymentRefund: { count: vi.fn().mockResolvedValue(0) },
    paymentRecoveryOperation: { count: vi.fn().mockResolvedValue(0) },
    memberCredit: { count: vi.fn().mockResolvedValue(0) },
    adminCreditAdjustmentRequest: { count: vi.fn().mockResolvedValue(0) },
    refundRequest: { count: vi.fn().mockResolvedValue(0) },
    memberSubscription: { count: vi.fn().mockResolvedValue(0) },
    seasonalMembershipAssignment: { findUnique: vi.fn().mockResolvedValue(null) },
    membershipSubscriptionCharge: { count: vi.fn().mockResolvedValue(0) },
    membershipSubscriptionBillingSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    auditLog: { create: vi.fn().mockResolvedValue({}), findMany: vi.fn() },
    promoCodeAssignment: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn() },
    promoRedemption: { count: vi.fn().mockResolvedValue(0) },
    nominationToken: { count: vi.fn().mockResolvedValue(0) },
    memberApplication: { count: vi.fn().mockResolvedValue(0) },
    membershipCancellationRequest: { count: vi.fn().mockResolvedValue(0) },
    membershipCancellationRequestParticipant: { count: vi.fn().mockResolvedValue(0), findFirst: vi.fn().mockResolvedValue(null) },
    familyGroupJoinRequest: { count: vi.fn().mockResolvedValue(0) },
    familyGroupMember: { count: vi.fn().mockResolvedValue(0) },
    hutLeaderAssignment: { count: vi.fn().mockResolvedValue(0) },
    issueReport: { count: vi.fn().mockResolvedValue(0) },
    bookingModification: { count: vi.fn().mockResolvedValue(0) },
    bookingChangeRequest: { count: vi.fn().mockResolvedValue(0) },
    deletionRequest: { count: vi.fn().mockResolvedValue(0) },
    xeroSyncOperation: { findFirst: vi.fn().mockResolvedValue(null) },
    memberLifecycleActionRequest: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
    passwordResetToken: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
  enqueueHostingCoverageReevaluationForMember: vi.fn(async () => 1),
}));

vi.mock("@/lib/adult-member-hosting-coverage-drain", () => ({
  settleHostingCoverageAfterCommit: vi.fn(async () => undefined),
}));

vi.mock("@/lib/audit", () => ({
  buildStructuredAuditLogCreateArgs: vi.fn((event) => ({ data: event })),
  getAuditEmailDomain: vi.fn((email?: string | null) =>
    email?.split("@")[1]?.toLowerCase() ?? null
  ),
  getAuditRequestContext: vi.fn(() => ({ ipAddress: "127.0.0.1" })),
  createAuditLog: vi.fn(),
  logAudit: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({ applyRateLimit: vi.fn().mockReturnValue(null) }));
vi.mock("@/lib/age-tier", () => ({
  computeAgeTier: vi.fn().mockResolvedValue("ADULT"),
  getSeasonStartDate: vi.fn().mockReturnValue(new Date("2026-04-01")),
  getAgeTierSettings: vi.fn().mockResolvedValue([
    { tier: "INFANT", label: "Infant", minAge: 0, maxAge: 4, sortOrder: 0, subscriptionRequiredForBooking: false, xeroAcceptedContactGroups: [] },
    { tier: "CHILD", label: "Child", minAge: 5, maxAge: 9, sortOrder: 1, subscriptionRequiredForBooking: false, xeroAcceptedContactGroups: [] },
    { tier: "YOUTH", label: "Youth", minAge: 10, maxAge: 17, sortOrder: 2, subscriptionRequiredForBooking: true, xeroAcceptedContactGroups: [] },
    { tier: "ADULT", label: "Adult", minAge: 18, maxAge: null, sortOrder: 3, subscriptionRequiredForBooking: true, xeroAcceptedContactGroups: [] },
  ]),
}));
const {
  mockIsXeroConnected,
  mockGetXeroContactGroupMemberships,
  mockSyncManagedXeroContactGroupForMember,
  mockUpdateXeroContact,
  mockCreateXeroEntranceFeeInvoice,
  mockEnqueueXeroEntranceFeeInvoiceOperation,
  mockProcessQueuedXeroOutboxOperations,
} = vi.hoisted(() => ({
  mockIsXeroConnected: vi.fn().mockResolvedValue(false),
  mockGetXeroContactGroupMemberships: vi.fn().mockResolvedValue({}),
  mockSyncManagedXeroContactGroupForMember: vi.fn(),
  mockUpdateXeroContact: vi.fn(),
  mockCreateXeroEntranceFeeInvoice: vi.fn().mockResolvedValue(null),
  mockEnqueueXeroEntranceFeeInvoiceOperation: vi.fn().mockResolvedValue({
    queueOperationId: null,
    message: "not queued",
  }),
  mockProcessQueuedXeroOutboxOperations: vi.fn().mockResolvedValue({
    found: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  }),
}));
vi.mock("@/lib/xero", () => ({
  isXeroConnected: mockIsXeroConnected,
  getXeroContactGroupMemberships: mockGetXeroContactGroupMemberships,
  syncManagedXeroContactGroupForMember: mockSyncManagedXeroContactGroupForMember,
  updateXeroContact: mockUpdateXeroContact,
  createXeroEntranceFeeInvoice: mockCreateXeroEntranceFeeInvoice,
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroEntranceFeeInvoiceOperation: mockEnqueueXeroEntranceFeeInvoiceOperation,
  processQueuedXeroOutboxOperations: mockProcessQueuedXeroOutboxOperations,
}));
vi.mock("@/lib/email", () => ({
  sendMemberSetupInviteEmail: vi.fn(),
}));
vi.mock("bcryptjs", () => ({ hash: vi.fn().mockResolvedValue("hashed") }));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { createAuditLog, logAudit } from "@/lib/audit";
import { dependentLinkCandidateWhere } from "@/lib/dependent-link-eligibility";
import { ancestorDepthWithinWhere } from "@/lib/member-family-link-depth";
import { sendMemberSetupInviteEmail } from "@/lib/email";
import { GET as getMembers, POST as createMember } from "@/app/api/admin/members/route";
import { GET as exportMembers } from "@/app/api/admin/members/export/route";
import { POST as importMembers } from "@/app/api/admin/members/import/route";
import { POST as bulkUpdate } from "@/app/api/admin/members/bulk-update/route";
import { GET as getMemberDetail } from "@/app/api/admin/members/[id]/route";
import {
  googleSubCollisionError,
  loginEmailCollisionError,
} from "@/lib/__tests__/helpers";

const mockedAuth = vi.mocked(auth);
const mockedSendMemberSetupInviteEmail = vi.mocked(sendMemberSetupInviteEmail);
const adminSession = { user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as any;
const memberSession = { user: { id: "m1", role: "USER", accessRoles: [{ role: "USER" }] } } as any;
const adminAccessMember = {
  id: "session-member",
  role: "ADMIN",
  financeAccessLevel: "NONE",
  accessRoles: [{ role: "ADMIN" }],
  active: true,
  forcePasswordChange: false,
};
const userAccessMember = {
  id: "session-member",
  role: "USER",
  financeAccessLevel: "NONE",
  accessRoles: [{ role: "USER" }],
  active: true,
  forcePasswordChange: false,
};

function mockSessionAndMemberListCounts(total: number) {
  vi.mocked(prisma.member.count).mockResolvedValue(total);
}

describe("Phase 3: Admin Member Management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsXeroConnected.mockResolvedValue(false);
    mockGetXeroContactGroupMemberships.mockResolvedValue({});
    vi.mocked(prisma.member.count).mockResolvedValue(1);
    vi.mocked(prisma.member.findUnique).mockResolvedValue(adminAccessMember as any);
    vi.mocked(prisma.memberLifecycleActionRequest.findMany).mockResolvedValue([] as any);
    vi.mocked(prisma.promoCodeAssignment.findMany).mockResolvedValue([] as any);
    delete process.env.XERO_ENABLE_LIVE_MEMBER_GROUP_LOOKUPS;
  });

  // ── A1: Pagination ──

  describe("A1 - Pagination", () => {
    it("returns 401 for unauthenticated requests", async () => {
      mockedAuth.mockResolvedValue(null as any);
      const res = await getMembers(new NextRequest("http://localhost/api/admin/members"));
      expect(res.status).toBe(401);
    });

    it("returns paginated results with metadata", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      mockSessionAndMemberListCounts(50);

      const res = await getMembers(new NextRequest("http://localhost/api/admin/members?page=2&pageSize=10"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.page).toBe(2);
      expect(body.pageSize).toBe(10);
      expect(body.total).toBe(50);
      expect(body.totalPages).toBe(5);
    });

    it("defaults to page 1 and pageSize 25", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      mockSessionAndMemberListCounts(0);

      const res = await getMembers(new NextRequest("http://localhost/api/admin/members"));
      const body = await res.json();
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(25);
    });

    it("clamps pageSize to max 100", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      mockSessionAndMemberListCounts(0);

      const res = await getMembers(new NextRequest("http://localhost/api/admin/members?pageSize=500"));
      const body = await res.json();
      expect(body.pageSize).toBe(100);
    });

    it("includes cached Xero contact groups for linked members after refresh", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      mockIsXeroConnected.mockResolvedValue(true);
      mockGetXeroContactGroupMemberships.mockResolvedValue({
        "xc-1": [{ id: "cg-1", name: "Camp Families" }],
      });
      vi.mocked(prisma.member.findMany).mockResolvedValue([
        {
          id: "m1",
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@test.com",
          phoneCountryCode: "64",
          phoneAreaCode: "27",
          phoneNumber: "1234567",
          dateOfBirth: null,
          role: "MEMBER",
          ageTier: "ADULT",
          active: true,
          canLogin: true,
          xeroContactId: "xc-1",
          joinedDate: null,
          createdAt: new Date("2025-01-01"),
          forcePasswordChange: false,
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
          familyGroupMemberships: [],
          subscriptions: [],
        },
      ] as any);
      mockSessionAndMemberListCounts(1);

      const res = await getMembers(new NextRequest("http://localhost/api/admin/members"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.members[0].xeroContactGroups).toEqual([
        { id: "cg-1", name: "Camp Families" },
      ]);
      expect(body.members[0].xeroContactGroupsLoaded).toBe(true);
      expect(mockGetXeroContactGroupMemberships).toHaveBeenCalledWith(["xc-1"]);
    });

    it("keeps the placeholder when the cached Xero groups have not been refreshed yet", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      mockIsXeroConnected.mockResolvedValue(true);
      vi.mocked(prisma.member.findMany).mockResolvedValue([
        {
          id: "m1",
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@test.com",
          phoneCountryCode: "64",
          phoneAreaCode: "27",
          phoneNumber: "1234567",
          dateOfBirth: null,
          role: "MEMBER",
          ageTier: "ADULT",
          active: true,
          canLogin: true,
          xeroContactId: "xc-1",
          joinedDate: null,
          createdAt: new Date("2025-01-01"),
          forcePasswordChange: false,
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
          familyGroupMemberships: [],
          subscriptions: [],
        },
      ] as any);
      mockSessionAndMemberListCounts(1);

      const res = await getMembers(new NextRequest("http://localhost/api/admin/members"));
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.members[0].xeroContactGroups).toEqual([]);
      expect(body.members[0].xeroContactGroupsLoaded).toBe(false);
      expect(mockGetXeroContactGroupMemberships).toHaveBeenCalledWith(["xc-1"]);
    });
  });

  // ── A11: Sorting ──

  describe("A11 - Sortable columns", () => {
    it("sorts by name ascending by default", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      mockSessionAndMemberListCounts(0);

      await getMembers(new NextRequest("http://localhost/api/admin/members"));
      const call = vi.mocked(prisma.member.findMany).mock.calls[0][0]!;
      expect(call.orderBy).toEqual([{ lastName: "asc" }, { firstName: "asc" }]);
    });

    it("sorts by email descending when specified", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      mockSessionAndMemberListCounts(0);

      await getMembers(new NextRequest("http://localhost/api/admin/members?sortBy=email&sortDir=desc"));
      const call = vi.mocked(prisma.member.findMany).mock.calls[0][0]!;
      expect(call.orderBy).toEqual({ email: "desc" });
    });

    it.each([
      ["asc", 2, ["invited", "can-login"]],
      ["desc", 1, ["can-login", "invited"]],
    ])(
      "sorts and paginates the derived Access stages %s",
      async (sortDir, page, expectedIds) => {
        mockedAuth.mockResolvedValue(adminSession);
        const candidates = [
          {
            id: "invited",
            firstName: "Ivy",
            lastName: "Invite",
            canLogin: true,
            passwordChangedAt: null,
            lastLoginAt: null,
            passwordResetTokens: [{ expiresAt: new Date("2999-01-01") }],
          },
          {
            id: "no-login",
            firstName: "Nora",
            lastName: "Offline",
            canLogin: false,
            passwordChangedAt: null,
            lastLoginAt: null,
            passwordResetTokens: [],
          },
          {
            id: "can-login",
            firstName: "Cara",
            lastName: "Ready",
            canLogin: true,
            passwordChangedAt: new Date("2026-01-01"),
            lastLoginAt: null,
            passwordResetTokens: [],
          },
          {
            id: "not-invited",
            firstName: "Neil",
            lastName: "Waiting",
            canLogin: true,
            passwordChangedAt: null,
            lastLoginAt: null,
            passwordResetTokens: [],
          },
        ];
        vi.mocked(prisma.member.findMany)
          .mockResolvedValueOnce(candidates as any)
          .mockResolvedValueOnce([]);

        await getMembers(
          new NextRequest(
            `http://localhost/api/admin/members?sortBy=access&sortDir=${sortDir}&page=${page}&pageSize=2`,
          ),
        );

        const candidateQuery = vi.mocked(prisma.member.findMany).mock.calls[0][0]!;
        expect(candidateQuery.select?.passwordResetTokens).toMatchObject({
          where: { used: false, expiresAt: { gt: expect.any(Date) } },
          take: 1,
        });
        const pageQuery = vi.mocked(prisma.member.findMany).mock.calls[1][0]!;
        expect(pageQuery.where).toEqual({
          AND: [expect.any(Object), { id: { in: expectedIds } }],
        });
        expect(prisma.member.count).not.toHaveBeenCalled();
      },
    );

    it("rejects invalid sortBy values", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      mockSessionAndMemberListCounts(0);

      await getMembers(new NextRequest("http://localhost/api/admin/members?sortBy=passwordHash"));
      const call = vi.mocked(prisma.member.findMany).mock.calls[0][0]!;
      // Should fall back to default name sort
      expect(call.orderBy).toEqual([{ lastName: "asc" }, { firstName: "asc" }]);
    });
  });

  // ── A2: Advanced Filtering ──

  describe("A2 - Advanced Filtering", () => {
    it("filters by role", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      mockSessionAndMemberListCounts(0);

      await getMembers(new NextRequest("http://localhost/api/admin/members?role=ADMIN"));
      const call = vi.mocked(prisma.member.findMany).mock.calls[0][0]!;
      expect(call.where?.AND).toEqual(
        expect.arrayContaining([
          {
            OR: [
              { accessRoles: { some: { role: "ADMIN" } } },
              { role: "ADMIN" },
            ],
          },
        ]),
      );
    });

    it("excludes operational and non-member roles from the unpaid subscription filter", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      mockSessionAndMemberListCounts(0);

      await getMembers(
        new NextRequest("http://localhost/api/admin/members?subscription=NONE")
      );
      const call = vi.mocked(prisma.member.findMany).mock.calls[0][0]!;
      // #2149: role carries no exemption of its own. Operational/non-member
      // accounts are exempt only via the role→default-type fallback, expressed as
      // "no season assignment AND role in the NOT_REQUIRED-default set". This
      // assignment-guarded clause is what keeps a fee-paying admin (REQUIRED
      // assignment) in the owing set.
      const andConditions = call.where?.AND as Array<Record<string, unknown>>;
      const notCondition = andConditions.find((c) => "NOT" in c) as
        | { NOT: { OR: Array<Record<string, unknown>> } }
        | undefined;
      expect(notCondition?.NOT.OR).toEqual(
        expect.arrayContaining([
          {
            AND: [
              { seasonalMembershipAssignments: { none: { seasonYear: 2026 } } },
              { role: { in: ["ADMIN", "LODGE", "NON_MEMBER", "SCHOOL"] } },
            ],
          },
        ])
      );
    });

    it("filters by finance access level", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      mockSessionAndMemberListCounts(0);

      await getMembers(new NextRequest("http://localhost/api/admin/members?financeAccess=MANAGER"));
      const call = vi.mocked(prisma.member.findMany).mock.calls[0][0]!;
      expect(call.where?.AND).toEqual(
        expect.arrayContaining([{ financeAccessLevel: "MANAGER" }])
      );
    });

    it("filters by active status", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      mockSessionAndMemberListCounts(0);

      await getMembers(new NextRequest("http://localhost/api/admin/members?active=false"));
      const call = vi.mocked(prisma.member.findMany).mock.calls[0][0]!;
      expect(call.where?.AND).toEqual(expect.arrayContaining([{ active: false }]));
    });

    it("filters by INFANT age tier", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      mockSessionAndMemberListCounts(0);

      await getMembers(new NextRequest("http://localhost/api/admin/members?ageTier=INFANT"));
      const call = vi.mocked(prisma.member.findMany).mock.calls[0][0]!;
      expect(call.where?.AND).toEqual(expect.arrayContaining([{ ageTier: "INFANT" }]));
    });

    it("filters by membership type id via the current-season assignment (#1445)", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      mockSessionAndMemberListCounts(0);

      await getMembers(
        new NextRequest("http://localhost/api/admin/members?membershipType=mt-full")
      );
      const call = vi.mocked(prisma.member.findMany).mock.calls[0][0]!;
      expect(call.where?.AND).toEqual(
        expect.arrayContaining([
          {
            seasonalMembershipAssignments: {
              some: { seasonYear: 2026, membershipTypeId: "mt-full" },
            },
          },
        ])
      );
    });

    it("filters unassigned members (no current-season assignment) (#1445)", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      mockSessionAndMemberListCounts(0);

      await getMembers(
        new NextRequest("http://localhost/api/admin/members?membershipType=UNASSIGNED")
      );
      const call = vi.mocked(prisma.member.findMany).mock.calls[0][0]!;
      expect(call.where?.AND).toEqual(
        expect.arrayContaining([
          {
            seasonalMembershipAssignments: {
              none: { seasonYear: 2026 },
            },
          },
        ])
      );
    });

    it("combines the membership type filter with another filter via AND (#1445)", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      mockSessionAndMemberListCounts(0);

      await getMembers(
        new NextRequest(
          "http://localhost/api/admin/members?membershipType=mt-life&lifecycleStatus=active"
        )
      );
      const call = vi.mocked(prisma.member.findMany).mock.calls[0][0]!;
      expect(call.where?.AND).toEqual(
        expect.arrayContaining([
          {
            seasonalMembershipAssignments: {
              some: { seasonYear: 2026, membershipTypeId: "mt-life" },
            },
          },
          { active: true },
          { cancelledAt: null },
        ])
      );
    });

    it("filters to eligible email inheritance sources and excludes the current member", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      mockSessionAndMemberListCounts(0);

      await getMembers(
        new NextRequest(
          "http://localhost/api/admin/members?q=alice&inheritEmailEligible=true&excludeId=child-1"
        )
      );

      const call = vi.mocked(prisma.member.findMany).mock.calls[0][0]!;
      expect(call.where?.AND).toEqual(
        expect.arrayContaining([
          { ageTier: "ADULT" },
          { inheritEmailFromId: null },
          { id: { not: "child-1" } },
        ])
      );
      // #2255 (D9): the "source must have no parents of their own" clauses are
      // deliberately gone. Under four generations the nearest ancestor with a
      // real mailbox is routinely a MIDDLE generation, and the write route
      // (validateInheritEmailSource) accepts exactly that — so a picker that
      // still hid them would refuse to offer the only valid choice.
      expect(call.where?.AND).not.toEqual(
        expect.arrayContaining([{ parentMemberId: null }])
      );
      expect(call.where?.AND).not.toEqual(
        expect.arrayContaining([{ secondaryParentId: null }])
      );

      // #2255: and the clauses that REPLACED them are pinned exactly, not with
      // `arrayContaining`. They exist for one reason — the write route now 422s
      // on a placeholder address, so a picker that still offered walk-in and
      // deletion-anonymised contacts would re-open the very search-offers-what-
      // the-write-refuses drift #2254 closed. With `arrayContaining` alone both
      // could be deleted and this test would stay green.
      //
      // #2716: DERIVED from the constant rather than hand-listed. This assertion
      // was written out as two literal domains and broke the moment a third was
      // added (`@inheritance-lost.invalid`, stamped over a dependant's stale copy
      // when their source leaves the club) — even though excluding it is exactly
      // right, since such a member cannot receive their own mail let alone
      // somebody else's. A hand-written list here re-creates the same drift the
      // clauses exist to prevent, one level up: the picker's test would pass
      // while the picker offered a source the write route refuses.
      const placeholderExclusions = (call.where?.AND as unknown[]).filter(
        (clause) => JSON.stringify(clause).includes("endsWith"),
      );
      expect(placeholderExclusions).toEqual(
        PLACEHOLDER_CONTACT_EMAIL_DOMAINS.map((domain) => ({
          NOT: {
            email: { endsWith: `@${domain}`, mode: "insensitive" },
          },
        })),
      );
      // Still exact, not `arrayContaining`: every domain the predicate rejects
      // must be excluded from the picker, and no extra clause may creep in.
      expect(placeholderExclusions).toHaveLength(
        PLACEHOLDER_CONTACT_EMAIL_DOMAINS.length,
      );
    });

    it("filters to active, non-archived parent-link candidates of ANY age and excludes the current member", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      // #2255: this search now walks DOWN from the member first, to price up how
      // much of the four-generation budget their own dependants already use and
      // to exclude their descendants (a descendant offered as a parent is a
      // cycle). Routed by query shape so the assertion below stays on the search.
      const searchCalls: Array<Record<string, any>> = [];
      vi.mocked(prisma.member.findMany).mockImplementation((async (
        args: any,
      ) => {
        if (args?.where?.OR?.some?.((clause: any) => clause.parentMemberId?.in)) {
          return [];
        }
        searchCalls.push(args);
        return [] as never;
      }) as never);
      mockSessionAndMemberListCounts(0);

      await getMembers(
        new NextRequest(
          "http://localhost/api/admin/members?q=alice&parentLinkEligibleFor=child-1"
        )
      );

      // #2425: the picker now asks for its page in two complementary halves —
      // adults, then everyone else — so the eligibility clauses are asserted on
      // BOTH calls. Anything present on one and missing from the other would be
      // a filter masquerading as a ranking.
      expect(searchCalls).toHaveLength(2);
      for (const call of searchCalls) {
        expect(call.where?.AND).toEqual(
          expect.arrayContaining([
            { id: { notIn: ["child-1"] } },
            { active: true },
            // #2282: `archivedAt: null` REPLACES `ageTier: "ADULT"` here. The
            // write route never accepted an archived parent and this search never
            // filtered one, so the dialog could offer a candidate the save then
            // 422'd — the #2254 drift, in the parent direction.
            { archivedAt: null },
            // A member with no dependants of their own leaves room for a
            // candidate parent who is themselves someone's grandchild.
            ancestorDepthWithinWhere(2),
          ])
        );
      }

      // #2282 stated as a refusal too, because `arrayContaining` cannot say
      // "and not this": age must not NARROW the parent-candidate set. Since
      // #2425 an age clause does appear — as the RANKING split — so the refusal
      // is stated the only way that still means something: the two halves are
      // exact complements (`in` and `notIn` over the same tiers) on otherwise
      // IDENTICAL clauses. Deleting the second query, or narrowing either
      // half's age clause to a subset, fails here rather than silently
      // returning the picker to adults-only while the write route accepts more.
      // The tiers themselves are pinned because WHICH side of the split
      // `NOT_APPLICABLE` lands on is the difference between an age-exempt
      // person ranking with the adults and ranking below every child (#2425
      // review) — the tier is age-EXEMPT, and organisations are excluded from
      // this search by role, so it belongs in the top half.
      const ageClauses = searchCalls.map((call) =>
        (call.where?.AND as any[]).filter((clause) => "ageTier" in clause)
      );
      expect(ageClauses).toEqual([
        [{ ageTier: { in: ["ADULT", "NOT_APPLICABLE"] } }],
        [{ ageTier: { notIn: ["ADULT", "NOT_APPLICABLE"] } }],
      ]);
      const withoutAge = searchCalls.map((call) =>
        (call.where?.AND as any[]).filter((clause) => !("ageTier" in clause))
      );
      expect(withoutAge[0]).toEqual(withoutAge[1]);
      // And the count that drives paging and the truncation hint is the whole
      // eligible set, not the adult half of it: no age clause at all.
      const countCalls = vi.mocked(prisma.member.count).mock.calls;
      for (const [countArgs] of countCalls) {
        expect(
          (countArgs?.where?.AND as any[] | undefined)?.some(
            (clause: any) => "ageTier" in clause
          ) ?? false
        ).toBe(false);
      }
    });

    it("combines text search with filters (AND logic)", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      mockSessionAndMemberListCounts(0);

      await getMembers(new NextRequest("http://localhost/api/admin/members?q=alice&role=USER&active=true"));
      const call = vi.mocked(prisma.member.findMany).mock.calls[0][0]!;
      const andConditions = call.where?.AND as any[];
      expect(andConditions.length).toBe(3); // text search + role + active
      expect(andConditions).toEqual(expect.arrayContaining([
        {
          OR: [
            { accessRoles: { some: { role: "USER" } } },
            { role: "USER" },
          ],
        },
        { active: true },
      ]));
      expect(andConditions.some((c: any) => c.OR)).toBe(true);
    });

    it("includes member ID prefix matching in text search", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      mockSessionAndMemberListCounts(0);

      await getMembers(new NextRequest("http://localhost/api/admin/members?q=member-12"));
      const call = vi.mocked(prisma.member.findMany).mock.calls[0][0]!;
      const andConditions = call.where?.AND as any[];
      const textSearchCondition = andConditions.find((condition: any) => condition.OR);

      expect(textSearchCondition).toBeDefined();
      expect(textSearchCondition.OR).toEqual(expect.arrayContaining([
        { id: { startsWith: "member-12" } },
      ]));
    });

    it("filters by subscription status NONE (no record)", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      mockSessionAndMemberListCounts(0);

      await getMembers(new NextRequest("http://localhost/api/admin/members?subscription=NONE"));
      const call = vi.mocked(prisma.member.findMany).mock.calls[0][0]!;
      // #2149: the blanket `role notIn OPERATIONAL` exclusion is gone — the
      // NOT { OR: notRequired } clause now handles operational exemption via the
      // assignment-aware fallback, so a fee-paying admin still surfaces in NONE.
      expect(call.where?.AND).toEqual(expect.arrayContaining([
        { subscriptions: { none: { seasonYear: 2026 } } },
      ]));
      expect(call.where?.AND).not.toContainEqual({
        role: { notIn: ["ADMIN", "LODGE"] },
      });
    });

    it("filters by family group presence", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      mockSessionAndMemberListCounts(0);

      await getMembers(new NextRequest("http://localhost/api/admin/members?familyGroup=any"));
      let call = vi.mocked(prisma.member.findMany).mock.calls[0][0]!;
      expect(call.where?.AND).toEqual(expect.arrayContaining([
        { familyGroupMemberships: { some: {} } },
      ]));

      vi.mocked(prisma.member.findMany).mockClear();
      await getMembers(new NextRequest("http://localhost/api/admin/members?familyGroup=none"));
      call = vi.mocked(prisma.member.findMany).mock.calls[0][0]!;
      expect(call.where?.AND).toEqual(expect.arrayContaining([
        { familyGroupMemberships: { none: {} } },
      ]));
    });

    it("filters by first-time invite status", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      mockSessionAndMemberListCounts(0);

      await getMembers(new NextRequest("http://localhost/api/admin/members?inviteStatus=invite"));
      const call = vi.mocked(prisma.member.findMany).mock.calls[0][0]!;
      expect(call.where?.AND).toEqual(expect.arrayContaining([
        { canLogin: true },
        { passwordChangedAt: null },
        { lastLoginAt: null },
        { passwordResetTokens: { none: { used: false, expiresAt: { gt: expect.any(Date) } } } },
      ]));
    });

    it("filters by resend invite status", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      mockSessionAndMemberListCounts(0);

      await getMembers(new NextRequest("http://localhost/api/admin/members?inviteStatus=resend-invite"));
      const call = vi.mocked(prisma.member.findMany).mock.calls[0][0]!;
      expect(call.where?.AND).toEqual(expect.arrayContaining([
        { canLogin: true },
        { passwordChangedAt: null },
        { lastLoginAt: null },
        { passwordResetTokens: { some: { used: false, expiresAt: { gt: expect.any(Date) } } } },
      ]));
    });

    it("filters by reset password status", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      mockSessionAndMemberListCounts(0);

      await getMembers(new NextRequest("http://localhost/api/admin/members?inviteStatus=reset-password"));
      const call = vi.mocked(prisma.member.findMany).mock.calls[0][0]!;
      expect(call.where?.AND).toEqual(expect.arrayContaining([
        { canLogin: true },
        {
          OR: [
            { passwordChangedAt: { not: null } },
            { lastLoginAt: { not: null } },
          ],
        },
      ]));
    });

    it("filters by no-login status", async () => {
      // #1444 folded the standalone Login column into the Access stage filter;
      // the new no-login value scopes to members whose login is switched off.
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      mockSessionAndMemberListCounts(0);

      await getMembers(new NextRequest("http://localhost/api/admin/members?inviteStatus=no-login"));
      const call = vi.mocked(prisma.member.findMany).mock.calls[0][0]!;
      expect(call.where?.AND).toEqual(expect.arrayContaining([
        { canLogin: false },
      ]));
    });

    it("filters admin users as subscription not required", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      mockSessionAndMemberListCounts(0);

      await getMembers(new NextRequest("http://localhost/api/admin/members?subscription=NOT_REQUIRED"));
      const call = vi.mocked(prisma.member.findMany).mock.calls[0][0]!;
      // #2149: the role clause is now assignment-guarded (fallback semantics).
      expect(call.where?.AND).toEqual(expect.arrayContaining([
        {
          OR: expect.arrayContaining([
            {
              AND: [
                { seasonalMembershipAssignments: { none: { seasonYear: 2026 } } },
                { role: { in: ["ADMIN", "LODGE", "NON_MEMBER", "SCHOOL"] } },
              ],
            },
            { ageTier: { in: expect.arrayContaining(["INFANT", "CHILD"]) } },
          ]),
        },
      ]));
    });

    // #2041/#2149: the mid-season tier-promotion shape — a BASED_ON_AGE_TIER
    // assignment with a NOT_REQUIRED current-season row on a subscription-liable
    // age tier — is badged NOT_REQUIRED by the displayed flag (row dominance).
    // The list SQL must carry the matching fourth OR clause so the filter cannot
    // disagree with the flag.
    const tierPromotionExemptClause = {
      seasonalMembershipAssignments: {
        some: {
          seasonYear: 2026,
          membershipType: { subscriptionBehavior: "BASED_ON_AGE_TIER" },
        },
      },
      subscriptions: {
        some: { seasonYear: 2026, status: "NOT_REQUIRED" },
      },
    };

    it("NOT_REQUIRED filter includes the BASED_ON_AGE_TIER + NOT_REQUIRED-row (tier promotion) clause", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      mockSessionAndMemberListCounts(0);

      await getMembers(new NextRequest("http://localhost/api/admin/members?subscription=NOT_REQUIRED"));
      const call = vi.mocked(prisma.member.findMany).mock.calls[0][0]!;
      expect(call.where?.AND).toEqual(expect.arrayContaining([
        { OR: expect.arrayContaining([tierPromotionExemptClause]) },
      ]));
    });

    it("owing filters (NONE, UNPAID) exclude the tier-promotion clause via NOT, so it cannot appear in both sets", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      for (const filter of ["NONE", "UNPAID"]) {
        vi.mocked(prisma.member.findMany).mockClear();
        vi.mocked(prisma.member.findMany).mockResolvedValue([]);
        mockSessionAndMemberListCounts(0);
        await getMembers(
          new NextRequest(`http://localhost/api/admin/members?subscription=${filter}`),
        );
        const call = vi.mocked(prisma.member.findMany).mock.calls[0][0]!;
        const andConditions = call.where?.AND as Array<Record<string, unknown>>;
        const notCondition = andConditions.find((c) => "NOT" in c) as
          | { NOT: { OR: Array<Record<string, unknown>> } }
          | undefined;
        expect(notCondition?.NOT.OR).toEqual(
          expect.arrayContaining([tierPromotionExemptClause]),
        );
      }
    });

    it("returns admin users with subscription not required", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([
        {
          id: "admin-member",
          firstName: "Admin",
          lastName: "User",
          email: "admin@test.com",
          phoneCountryCode: null,
          phoneAreaCode: null,
          phoneNumber: null,
          dateOfBirth: null,
          role: "ADMIN",
          financeAccessLevel: "NONE",
          ageTier: "ADULT",
          active: true,
          canLogin: true,
          xeroContactId: null,
          joinedDate: null,
          createdAt: new Date("2025-01-01"),
          forcePasswordChange: false,
          passwordChangedAt: null,
          lastLoginAt: null,
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
          familyGroupMemberships: [],
          subscriptions: [{ status: "PAID", seasonYear: 2026, xeroInvoiceId: "inv-1" }],
          passwordResetTokens: [],
        },
      ] as any);
      mockSessionAndMemberListCounts(1);

      const res = await getMembers(new NextRequest("http://localhost/api/admin/members"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.members[0].subscriptionStatus).toBe("NOT_REQUIRED");
      expect(body.members[0].subscriptionXeroInvoiceId).toBe("inv-1");
    });

    describe("BASED_ON_AGE_TIER subscription flag (#2041)", () => {
      function ageTierMember(opts: {
        subscriptionBehavior: string;
        ageTier: string;
        subscriptionStatus: string;
      }) {
        return {
          id: "at-1", firstName: "Age", lastName: "Tier", email: "at@test.com",
          phoneCountryCode: null, phoneAreaCode: null, phoneNumber: null,
          dateOfBirth: null, role: "USER", financeAccessLevel: "NONE",
          ageTier: opts.ageTier, active: true, canLogin: true, xeroContactId: null,
          joinedDate: null, createdAt: new Date("2025-01-01"), forcePasswordChange: false,
          passwordChangedAt: null, lastLoginAt: null,
          streetAddressLine1: null, streetAddressLine2: null, streetCity: null,
          streetRegion: null, streetPostalCode: null, streetCountry: null,
          postalAddressLine1: null, postalAddressLine2: null, postalCity: null,
          postalRegion: null, postalPostalCode: null, postalCountry: null,
          familyGroupMemberships: [],
          subscriptions: [{ status: opts.subscriptionStatus, seasonYear: 2026, xeroInvoiceId: null }],
          seasonalMembershipAssignments: [{
            membershipType: {
              id: "type-1", key: "FULL", name: "Full", isActive: true,
              subscriptionBehavior: opts.subscriptionBehavior,
            },
          }],
          passwordResetTokens: [],
        };
      }

      async function statusFor(member: unknown) {
        mockedAuth.mockResolvedValue(adminSession);
        vi.mocked(prisma.member.findMany).mockResolvedValue([member] as any);
        mockSessionAndMemberListCounts(1);
        const res = await getMembers(new NextRequest("http://localhost/api/admin/members"));
        const body = await res.json();
        return body.members[0].subscriptionStatus;
      }

      it("a NOT_REQUIRED row dominates a subscription-requiring stored tier (mid-season promotion)", async () => {
        // Youth requires a subscription, but the exempt-at-season-start member
        // carries a NOT_REQUIRED row — the list must agree with the booking gate.
        expect(await statusFor(ageTierMember({
          subscriptionBehavior: "BASED_ON_AGE_TIER", ageTier: "YOUTH", subscriptionStatus: "NOT_REQUIRED",
        }))).toBe("NOT_REQUIRED");
      });

      it("defers to the age-tier flag when there is no NOT_REQUIRED row", async () => {
        expect(await statusFor(ageTierMember({
          subscriptionBehavior: "BASED_ON_AGE_TIER", ageTier: "YOUTH", subscriptionStatus: "NOT_INVOICED",
        }))).toBe("NOT_INVOICED");
      });

      it("REQUIRED types are byte-unchanged (dominance branch never fires)", async () => {
        expect(await statusFor(ageTierMember({
          subscriptionBehavior: "REQUIRED", ageTier: "YOUTH", subscriptionStatus: "NOT_INVOICED",
        }))).toBe("NOT_INVOICED");
      });
    });

  });

  // ── Dependant-link candidate search (#2254) ──

  describe("dependentLinkEligibleFor - dependant-link candidates", () => {
    /**
     * #2255: the service now issues family-link GRAPH queries either side of the
     * candidate search — one walk up from the parent (for the depth budget and
     * the ancestor exclusion) and one walk down per explained candidate. Routing
     * the mock by query SHAPE rather than by call order keeps these tests about
     * the search, and stops a walk being added or removed from silently
     * re-pointing every `mock.calls[n]` assertion at the wrong query.
     */
    function mockMemberSearchQueries({
      candidates = [],
      textMatches = [],
      descendantsOf = {},
    }: {
      candidates?: unknown[];
      textMatches?: unknown[];
      descendantsOf?: Record<string, string[]>;
    }) {
      const searchCalls: Array<Record<string, any>> = [];
      vi.mocked(prisma.member.findMany).mockImplementation((async (
        args: any,
      ) => {
        const where = args?.where ?? {};
        // Walk UP: "these ids". The parent has no ancestors in these fixtures.
        if (where.id?.in) return [];
        // Walk DOWN: "children of these ids".
        if (where.OR?.some?.((clause: any) => clause.parentMemberId?.in)) {
          const parentIds: string[] = where.OR.flatMap((clause: any) => [
            ...(clause.parentMemberId?.in ?? []),
            ...(clause.secondaryParentId?.in ?? []),
          ]);
          return parentIds.flatMap((id) =>
            (descendantsOf[id] ?? []).map((childId) => ({ id: childId })),
          );
        }
        searchCalls.push(args);
        // First non-graph query is the candidate search; the second is the
        // diagnostic re-run with the eligibility filter lifted.
        return (searchCalls.length === 1 ? candidates : textMatches) as never;
      }) as never);
      return { searchCalls };
    }

    it("uses the shared, NULL-safe eligibility predicate", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      const { searchCalls } = mockMemberSearchQueries({});
      mockSessionAndMemberListCounts(0);

      await getMembers(
        new NextRequest(
          "http://localhost/api/admin/members?q=smith&dependentLinkEligibleFor=parent-1",
        ),
      );

      const call = searchCalls[0];
      // The service must push the shared predicate verbatim. `{ not: id }` on
      // the nullable parent columns compiled to a bare `<> $1`, which drops
      // every NULL row — that is the #2254 bug. The generated SQL itself is
      // pinned in dependent-link-eligibility.test.ts.
      expect(call.where?.AND).toEqual(
        expect.arrayContaining(
          dependentLinkCandidateWhere("parent-1", {
            parentAncestorIds: [],
            parentAncestorGenerations: 0,
          }),
        ),
      );
      expect(call.where?.AND).not.toEqual(
        expect.arrayContaining([{ parentMemberId: { not: "parent-1" } }]),
      );
      expect(call.where?.AND).not.toEqual(
        expect.arrayContaining([{ secondaryParentId: { not: "parent-1" } }]),
      );
    });

    it("does not filter on active — the write route accepts inactive targets", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      const { searchCalls } = mockMemberSearchQueries({});
      mockSessionAndMemberListCounts(0);

      await getMembers(
        new NextRequest(
          "http://localhost/api/admin/members?q=smith&dependentLinkEligibleFor=parent-1",
        ),
      );

      expect(searchCalls[0].where?.AND).not.toEqual(
        expect.arrayContaining([{ active: true }]),
      );
    });

    it("explains each excluded match when nothing is eligible", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      const { searchCalls } = mockMemberSearchQueries({
        candidates: [],
        textMatches: [
          {
            id: "m-two-parents",
            firstName: "Jane",
            lastName: "Smith",
            email: "jane@example.com",
            archivedAt: null,
            parentMemberId: "mum-1",
            secondaryParentId: "dad-1",
          },
          {
            id: "m-too-deep",
            firstName: "Bob",
            lastName: "Smith",
            email: "bob@example.com",
            archivedAt: null,
            parentMemberId: null,
            secondaryParentId: null,
          },
          {
            id: "m-archived",
            firstName: "Old",
            lastName: "Smith",
            email: "old@example.com",
            archivedAt: new Date("2026-01-01"),
            parentMemberId: null,
            secondaryParentId: null,
          },
        ],
        // #2255: Bob heads three generations of his own, so linking him under
        // a root parent would make five. That is now the reason the dialog
        // shows, in place of the retired "has dependants of their own".
        descendantsOf: {
          "m-too-deep": ["kid-1"],
          "kid-1": ["grandkid-1"],
          "grandkid-1": ["greatgrandkid-1"],
        },
      });
      mockSessionAndMemberListCounts(0);

      const res = await getMembers(
        new NextRequest(
          "http://localhost/api/admin/members?q=smith&dependentLinkEligibleFor=parent-1",
        ),
      );
      const body = await res.json();

      expect(body.dependentLinkIneligible).toEqual([
        {
          id: "m-two-parents",
          firstName: "Jane",
          lastName: "Smith",
          email: "jane@example.com",
          reason: "TWO_PARENTS",
          explanation: "already has two parents recorded",
        },
        {
          id: "m-too-deep",
          firstName: "Bob",
          lastName: "Smith",
          email: "bob@example.com",
          reason: "EXCEEDS_GENERATION_LIMIT",
          explanation: "would make the family chain more than 4 generations deep",
        },
        {
          id: "m-archived",
          firstName: "Old",
          lastName: "Smith",
          email: "old@example.com",
          reason: "ARCHIVED",
          explanation: "is archived",
        },
      ]);
      // Members DID match the text search, so the dialog must not claim
      // otherwise.
      expect(body).not.toHaveProperty("dependentLinkSearchMatchedNobody");
      // The diagnostic query re-uses the text search but drops the eligibility
      // filter, so it can see the members the candidate query excluded.
      expect(searchCalls[1].where).not.toHaveProperty("AND");
    });

    it("says nobody matched only when the text search really matched nobody", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      // The diagnostic finds nothing either: the name simply is not in the
      // database.
      mockMemberSearchQueries({ candidates: [], textMatches: [] });
      mockSessionAndMemberListCounts(0);

      const res = await getMembers(
        new NextRequest(
          "http://localhost/api/admin/members?q=nobody&dependentLinkEligibleFor=parent-1",
        ),
      );
      const body = await res.json();

      expect(body.dependentLinkSearchMatchedNobody).toBe(true);
      expect(body).not.toHaveProperty("dependentLinkIneligible");
    });

    it("omits the ineligible list rather than sending an empty one", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      mockMemberSearchQueries({
        candidates: [],
        // A text match with no blockers at all. Unreachable today — the two
        // queries differ only by the eligibility filter — but if that ever
        // stopped holding, an empty array would read to the dialog as "nobody
        // matched your search", which is exactly wrong.
        textMatches: [
          {
            id: "m-eligible",
            firstName: "Ada",
            lastName: "Smith",
            email: "ada@example.com",
            archivedAt: null,
            parentMemberId: null,
            secondaryParentId: null,
          },
        ],
      });
      mockSessionAndMemberListCounts(0);

      const res = await getMembers(
        new NextRequest(
          "http://localhost/api/admin/members?q=smith&dependentLinkEligibleFor=parent-1",
        ),
      );
      const body = await res.json();

      expect(body).not.toHaveProperty("dependentLinkIneligible");
      expect(body).not.toHaveProperty("dependentLinkSearchMatchedNobody");
    });

    it("stays silent when the search found eligible candidates", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      const { searchCalls } = mockMemberSearchQueries({});
      mockSessionAndMemberListCounts(3);

      const res = await getMembers(
        new NextRequest(
          "http://localhost/api/admin/members?q=smith&dependentLinkEligibleFor=parent-1",
        ),
      );
      const body = await res.json();

      expect(body).not.toHaveProperty("dependentLinkIneligible");
      // Exactly one SEARCH query: the diagnostic re-run never happens. (The
      // parent's family-link walk is a separate query shape and is not counted
      // here — it runs whether or not anything is eligible.)
      expect(searchCalls).toHaveLength(1);
    });

    it("is absent from an ordinary members-list response", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      mockSessionAndMemberListCounts(0);

      const res = await getMembers(
        new NextRequest("http://localhost/api/admin/members?q=smith"),
      );
      const body = await res.json();

      expect(body).not.toHaveProperty("dependentLinkIneligible");
      expect(vi.mocked(prisma.member.findMany)).toHaveBeenCalledTimes(1);
    });
  });

  // ── A3: CSV Export ──

  describe("A3 - CSV Export", () => {
    it("returns 403 for non-admin", async () => {
      mockedAuth.mockResolvedValue(memberSession);
      vi.mocked(prisma.member.findUnique).mockResolvedValueOnce(userAccessMember as any);
      const res = await exportMembers(new NextRequest("http://localhost/api/admin/members/export"));
      expect(res.status).toBe(403);
    });

    it("returns CSV with correct headers and filename", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([
        {
          firstName: "Alice", lastName: "Smith", email: "alice@test.com",
          phoneCountryCode: null, phoneAreaCode: null, phoneNumber: "021-123", dateOfBirth: new Date("1990-01-15"),
          role: "MEMBER", ageTier: "ADULT", active: true,
          xeroContactId: "xc1", createdAt: new Date("2025-01-01"),
          subscriptions: [{ status: "PAID" }],
        },
      ] as any);

      const res = await exportMembers(new NextRequest("http://localhost/api/admin/members/export"));
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
      const disposition = res.headers.get("Content-Disposition")!;
      expect(disposition).toMatch(/tac-members-\d{4}-\d{2}-\d{2}\.csv/);

      const csv = await res.text();
      const lines = csv.split("\r\n");
      expect(lines[0]).toBe("Title,First Name,Last Name,Gender,Occupation,Email,Phone Country Code,Phone Area Code,Phone Number,Street Address Line 1,Street Address Line 2,City,Region,Country,Postal Code,Date of Birth,Life Member Date,Role,Age Tier,Active,Cancelled At,Archived At,Xero Contact ID,Subscription Status,Comments,Created At");
      expect(lines[1]).toContain("Alice");
      expect(lines[1]).toContain("PAID");
    });

    it("exports the occupation column value", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([
        {
          firstName: "Alice", lastName: "Smith", email: "alice@test.com",
          occupation: "Mountain Guide",
          phoneCountryCode: null, phoneAreaCode: null, phoneNumber: null, dateOfBirth: null,
          role: "MEMBER", ageTier: "ADULT", active: true, xeroContactId: null,
          createdAt: new Date("2025-01-01"), subscriptions: [],
        },
      ] as any);

      const res = await exportMembers(new NextRequest("http://localhost/api/admin/members/export"));
      const csv = await res.text();
      expect(csv).toContain("Mountain Guide");
    });

    it("neutralises spreadsheet formula injection in CSV values", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([
        {
          firstName: "=cmd|'/c calc'!A1", lastName: "Smith", email: "x@test.com",
          comments: "@SUM(1+1)", occupation: "+danger", phoneCountryCode: null,
          phoneAreaCode: null, phoneNumber: null, dateOfBirth: null, role: "MEMBER",
          ageTier: "ADULT", active: true, xeroContactId: null,
          createdAt: new Date("2025-01-01"), subscriptions: [],
        },
      ] as any);

      const res = await exportMembers(new NextRequest("http://localhost/api/admin/members/export"));
      const csv = await res.text();
      // Leading =,+,@ are prefixed with a single quote (then RFC-4180 quoted).
      expect(csv).toContain("'=cmd");
      expect(csv).toContain("'@SUM(1+1)");
      expect(csv).toContain("'+danger");
      // No raw formula-leading cell survives at a field boundary.
      expect(csv).not.toMatch(/(^|,)=cmd/);
    });

    it("writes an audit log when members are exported", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([] as any);

      await exportMembers(new NextRequest("http://localhost/api/admin/members/export?role=ADMIN"));
      expect(createAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "member.exported",
          memberId: "admin1",
        }),
      );
    });

    it("escapes special characters in CSV values", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([
        {
          firstName: 'O"Brien', lastName: "Smith, Jr.", email: "test@test.com",
          phoneCountryCode: null, phoneAreaCode: null, phoneNumber: null, dateOfBirth: null, role: "MEMBER", ageTier: "ADULT",
          active: true, xeroContactId: null, createdAt: new Date("2025-01-01"),
          subscriptions: [],
        },
      ] as any);

      const res = await exportMembers(new NextRequest("http://localhost/api/admin/members/export"));
      const csv = await res.text();
      // Commas and quotes should be properly escaped
      expect(csv).toContain('"O""Brien"');
      expect(csv).toContain('"Smith, Jr."');
    });

    it("applies filters to export", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);

      await exportMembers(new NextRequest("http://localhost/api/admin/members/export?role=ADMIN&active=true"));
      const call = vi.mocked(prisma.member.findMany).mock.calls[0][0]!;
      expect(call.where?.AND).toEqual(expect.arrayContaining([
        { role: "ADMIN" },
        { active: true },
      ]));
    });

    it("applies family group, invite status, and subscription filters to export", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);

      await exportMembers(new NextRequest("http://localhost/api/admin/members/export?familyGroup=any&inviteStatus=resend-invite&subscription=NOT_REQUIRED"));
      const call = vi.mocked(prisma.member.findMany).mock.calls[0][0]!;
      expect(call.where?.AND).toEqual(expect.arrayContaining([
        { familyGroupMemberships: { some: {} } },
        { canLogin: true },
        { passwordChangedAt: null },
        { lastLoginAt: null },
        { passwordResetTokens: { some: { used: false, expiresAt: { gt: expect.any(Date) } } } },
        {
          // #2149: role clause is assignment-guarded (fallback semantics),
          // matching the members-list filter.
          OR: expect.arrayContaining([
            {
              AND: [
                { seasonalMembershipAssignments: { none: { seasonYear: 2026 } } },
                { role: { in: ["ADMIN", "LODGE", "NON_MEMBER", "SCHOOL"] } },
              ],
            },
            { ageTier: { in: expect.arrayContaining(["INFANT", "CHILD"]) } },
          ]),
        },
      ]));
    });

    it("export NOT_REQUIRED filter mirrors the list — includes the tier-promotion clause", async () => {
      // #2041/#2149: the export SQL must carry the same BASED_ON_AGE_TIER +
      // NOT_REQUIRED-row exempt clause as the members list so the CSV roster
      // cannot disagree with the on-screen NOT_REQUIRED badge.
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);

      await exportMembers(new NextRequest("http://localhost/api/admin/members/export?subscription=NOT_REQUIRED"));
      const call = vi.mocked(prisma.member.findMany).mock.calls[0][0]!;
      expect(call.where?.AND).toEqual(expect.arrayContaining([
        {
          OR: expect.arrayContaining([
            {
              seasonalMembershipAssignments: {
                some: {
                  seasonYear: 2026,
                  membershipType: { subscriptionBehavior: "BASED_ON_AGE_TIER" },
                },
              },
              subscriptions: {
                some: { seasonYear: 2026, status: "NOT_REQUIRED" },
              },
            },
          ]),
        },
      ]));
    });

    it("exports admin subscription status as not required", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([
        {
          firstName: "Admin", lastName: "User", email: "admin@test.com",
          phoneCountryCode: null, phoneAreaCode: null, phoneNumber: null, dateOfBirth: null,
          role: "ADMIN", ageTier: "ADULT", active: true,
          xeroContactId: null, createdAt: new Date("2025-01-01"),
          subscriptions: [{ status: "PAID" }],
        },
      ] as any);

      const res = await exportMembers(new NextRequest("http://localhost/api/admin/members/export"));
      const csv = await res.text();
      expect(csv).toContain("NOT_REQUIRED");
      expect(csv).not.toContain("PAID");
    });

    it("applies INFANT age tier filter to export", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);

      await exportMembers(new NextRequest("http://localhost/api/admin/members/export?ageTier=INFANT"));
      const call = vi.mocked(prisma.member.findMany).mock.calls[0][0]!;
      expect(call.where?.AND).toEqual(expect.arrayContaining([{ ageTier: "INFANT" }]));
    });
  });

  // ── A4: CSV Import ──

  describe("A4 - CSV Import", () => {
    it("returns 403 for non-admin", async () => {
      mockedAuth.mockResolvedValue(memberSession);
      vi.mocked(prisma.member.findUnique).mockResolvedValueOnce(userAccessMember as any);
      const req = new NextRequest("http://localhost/api/admin/members/import", {
        method: "POST",
        body: JSON.stringify({ rows: [], sendInvites: false }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await importMembers(req);
      expect(res.status).toBe(403);
    });

    it("validates required fields", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      const req = new NextRequest("http://localhost/api/admin/members/import", {
        method: "POST",
        body: JSON.stringify({ rows: [{ firstName: "", lastName: "Test", email: "test@test.com" }], sendInvites: false }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await importMembers(req);
      expect(res.status).toBe(422);
    });

    it("imports different-name shared-email rows and gives only the first row login", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      const createMember = vi.fn(async ({ data }: any) => ({
        id: `new-${data.firstName}`,
        email: data.email,
        firstName: data.firstName,
        lastName: data.lastName,
        canLogin: data.canLogin,
      }));
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
        const tx = {
          member: { create: createMember },
          memberAccessRole: {
            createMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
        };
        return fn(tx);
      });

      const req = new NextRequest("http://localhost/api/admin/members/import", {
        method: "POST",
        body: JSON.stringify({
          rows: [
            { firstName: "Alice", lastName: "A", email: "dup@test.com", dateOfBirth: "1990-01-01" },
            { firstName: "Bob", lastName: "B", email: "dup@test.com", dateOfBirth: "1990-01-01" },
            { firstName: "Charlie", lastName: "C", email: "dup@test.com" },
          ],
          sendInvites: false,
        }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await importMembers(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.errors).toEqual([]);
      expect(body.created).toBe(3);
      expect(body.createdLoginEnabled).toBe(1);
      expect(body.createdNonLogin).toBe(2);
      expect(createMember.mock.calls.map((call) => call[0].data.canLogin)).toEqual([
        true,
        false,
        false,
      ]);
      expect(body.rowNotes).toEqual([
        {
          row: 2,
          email: "dup@test.com",
          note: "Imported as Can't Login because an earlier row in this import uses this email for login",
        },
        {
          row: 3,
          email: "dup@test.com",
          note: "Imported as Can't Login because an earlier row in this import uses this email for login",
        },
      ]);
    });

    it("skips same-email same-name duplicates within the file even when DOB differs or is blank", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      const createMember = vi.fn(async ({ data }: any) => ({
        id: "new-alice",
        email: data.email,
        firstName: data.firstName,
        lastName: data.lastName,
        canLogin: data.canLogin,
      }));
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
        const tx = {
          member: { create: createMember },
          memberAccessRole: {
            createMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
        };
        return fn(tx);
      });

      const req = new NextRequest("http://localhost/api/admin/members/import", {
        method: "POST",
        body: JSON.stringify({
          rows: [
            { firstName: "Alice", lastName: "A", email: "dup@test.com" },
            {
              firstName: "Alice",
              lastName: "A",
              email: "dup@test.com",
              dateOfBirth: "2005-05-05",
            },
            {
              firstName: " Alice ",
              lastName: "A",
              email: "dup@test.com",
              dateOfBirth: "",
            },
          ],
          sendInvites: false,
        }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await importMembers(req);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.created).toBe(1);
      expect(body.skipped).toBe(2);
      expect(body.skippedRows).toEqual([
        {
          row: 2,
          email: "dup@test.com",
          reason: "Duplicate member identity already appears earlier in this import",
        },
        {
          row: 3,
          email: "dup@test.com",
          reason: "Duplicate member identity already appears earlier in this import",
        },
      ]);
      expect(createMember).toHaveBeenCalledTimes(1);
    });

    it("creates members in a transaction (all-or-nothing)", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]); // no existing

      const mockCreated = [
        {
          id: "new1",
          email: "a@test.com",
          firstName: "Alice",
          lastName: "A",
          canLogin: true,
        },
        {
          id: "new2",
          email: "b@test.com",
          firstName: "Bob",
          lastName: "B",
          canLogin: true,
        },
      ];
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
        const tx = {
          member: { create: vi.fn() },
          memberAccessRole: {
            createMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
        };
        tx.member.create.mockResolvedValueOnce(mockCreated[0]);
        tx.member.create.mockResolvedValueOnce(mockCreated[1]);
        return fn(tx);
      });

      const req = new NextRequest("http://localhost/api/admin/members/import", {
        method: "POST",
        body: JSON.stringify({
          rows: [
            { firstName: "Alice", lastName: "A", email: "a@test.com" },
            { firstName: "Bob", lastName: "B", email: "b@test.com" },
          ],
          sendInvites: false,
        }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await importMembers(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.created).toBe(2);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(createAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "member.imported",
          memberId: "admin1",
          targetId: "new1",
        }),
        expect.objectContaining({
          member: expect.objectContaining({ create: expect.any(Function) }),
        }),
      );
    });

    it("rolls back the import path when transactional audit logging fails", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);

      const createMember = vi.fn(async ({ data }: any) => ({
        id: "new-audit-failure",
        email: data.email,
        firstName: data.firstName,
        lastName: data.lastName,
        canLogin: data.canLogin,
      }));
      const tx = {
        member: { create: createMember },
        memberAccessRole: {
          createMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) =>
        fn(tx),
      );
      vi.mocked(createAuditLog).mockRejectedValueOnce(
        new Error("audit failed"),
      );

      const req = new NextRequest("http://localhost/api/admin/members/import", {
        method: "POST",
        body: JSON.stringify({
          rows: [
            {
              firstName: "Audit",
              lastName: "Failure",
              email: "audit@test.com",
            },
          ],
          sendInvites: true,
        }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await importMembers(req);
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.error).toContain("no members were created");
      expect(createMember).toHaveBeenCalledTimes(1);
      expect(createAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "member.imported",
          targetId: "new-audit-failure",
        }),
        tx,
      );
      expect(prisma.passwordResetToken.create).not.toHaveBeenCalled();
      expect(mockedSendMemberSetupInviteEmail).not.toHaveBeenCalled();
    });

    it("creates imported members as login-enabled primary accounts", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);

      const createMember = vi.fn(async ({ data }: any) => ({
        id: "new-login",
        email: data.email,
        firstName: data.firstName,
        lastName: data.lastName,
      }));
      const createAccessRoles = vi.fn().mockResolvedValue({ count: 1 });
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
        const tx = {
          member: { create: createMember },
          memberAccessRole: {
            createMany: createAccessRoles,
          },
        };
        return fn(tx);
      });

      const req = new NextRequest("http://localhost/api/admin/members/import", {
        method: "POST",
        body: JSON.stringify({
          rows: [{ firstName: "Login", lastName: "Member", email: "login@test.com" }],
          sendInvites: false,
        }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await importMembers(req);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.created).toBe(1);
      expect(createMember).toHaveBeenCalledTimes(1);
      expect(createMember.mock.calls[0][0].data).toMatchObject({
        email: "login@test.com",
        active: true,
        canLogin: true,
        emailVerified: true,
      });
      expect(createAccessRoles).toHaveBeenCalledWith({
        data: [
          {
            memberId: "new-login",
            role: "USER",
            roleDefinitionId: null,
            assignedByMemberId: "admin1",
          },
        ],
        skipDuplicates: true,
      });
    });

    it("imports more than nine members in one request", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);

      const createMember = vi.fn(async ({ data }: any) => ({
        id: `new-${data.email}`,
        email: data.email,
        firstName: data.firstName,
        lastName: data.lastName,
      }));
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
        const tx = {
          member: { create: createMember },
          memberAccessRole: {
            createMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
        };
        return fn(tx);
      });

      const rows = Array.from({ length: 12 }, (_, index) => {
        const number = index + 1;
        return {
          firstName: `First${number}`,
          lastName: `Last${number}`,
          email: `member${number}@test.com`,
        };
      });

      const req = new NextRequest("http://localhost/api/admin/members/import", {
        method: "POST",
        body: JSON.stringify({ rows, sendInvites: false }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await importMembers(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.created).toBe(12);
      expect(createMember).toHaveBeenCalledTimes(12);
    });

    it("normalizes mapped DOB and joined date formats server-side", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);

      const createMember = vi.fn(async ({ data }: any) => ({
        id: "new-date",
        email: data.email,
        firstName: data.firstName,
        lastName: data.lastName,
      }));
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
        const tx = {
          member: { create: createMember },
          memberAccessRole: {
            createMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
        };
        return fn(tx);
      });

      const req = new NextRequest("http://localhost/api/admin/members/import", {
        method: "POST",
        body: JSON.stringify({
          rows: [
            {
              fullName: "Alice Anderson",
              email: "alice.date@test.com",
              dateOfBirth: "15/01/1990",
              joinedDate: "Jan 5 2024",
              sourceLineNumber: 12,
              sourceColumnLabels: {
                dateOfBirth: "Birth date",
                joinedDate: "Membership Start",
              },
            },
          ],
          dateFormats: {
            dateOfBirth: "dd/MM/yyyy",
            joinedDate: "MMM d yyyy",
          },
          sendInvites: false,
        }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await importMembers(req);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.created).toBe(1);
      expect(createMember).toHaveBeenCalledTimes(1);
      const createArgs = createMember.mock.calls[0][0];
      expect(createArgs.data.firstName).toBe("Alice");
      expect(createArgs.data.lastName).toBe("Anderson");
      expect(createArgs.data.dateOfBirth.toISOString().slice(0, 10)).toBe("1990-01-15");
      expect(createArgs.data.joinedDate.toISOString().slice(0, 10)).toBe("2024-01-05");
    });

    it("returns row and column context for invalid mapped dates before import", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);

      const req = new NextRequest("http://localhost/api/admin/members/import", {
        method: "POST",
        body: JSON.stringify({
          rows: [
            {
              firstName: "Alice",
              lastName: "Anderson",
              email: "bad-date@test.com",
              dateOfBirth: "31/02/1990",
              sourceLineNumber: 8,
              sourceColumnLabels: { dateOfBirth: "DOB" },
            },
          ],
          dateFormats: { dateOfBirth: "dd/MM/yyyy" },
          sendInvites: false,
        }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await importMembers(req);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.created).toBe(0);
      expect(body.errors).toEqual([
        {
          row: 8,
          errors: [expect.stringContaining("Date of Birth (column DOB)")],
        },
      ]);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("skips members that already exist in DB", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([
        {
          email: "existing@test.com",
          firstName: "Existing",
          lastName: "User",
          dateOfBirth: null,
          canLogin: true,
        },
      ] as any);
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
        const tx = {
          $executeRaw: vi.fn().mockResolvedValue(1),
          member: {
            create: vi.fn().mockResolvedValue({
              id: "new1",
              email: "new@test.com",
              firstName: "New",
              lastName: "User",
              canLogin: true,
            }),
          },
          memberAccessRole: {
            createMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
        };
        return fn(tx);
      });

      const req = new NextRequest("http://localhost/api/admin/members/import", {
        method: "POST",
        body: JSON.stringify({
          rows: [
            { firstName: "Existing", lastName: "User", email: "existing@test.com" },
            { firstName: "New", lastName: "User", email: "new@test.com" },
          ],
          sendInvites: false,
        }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await importMembers(req);
      const body = await res.json();
      expect(body.skipped).toBe(1);
      expect(body.skippedRows).toEqual([
        {
          row: 1,
          email: "existing@test.com",
          reason: "Matching member already exists for this email and name",
        },
      ]);
      expect(body.created).toBe(1);
    });

    it("returns an explicit no-op result when all rows already exist", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([
        {
          email: "existing-a@test.com",
          firstName: "Existing",
          lastName: "A",
          dateOfBirth: null,
          canLogin: true,
        },
        {
          email: "existing-b@test.com",
          firstName: "Existing",
          lastName: "B",
          dateOfBirth: new Date("1990-01-01"),
          canLogin: false,
        },
      ] as any);

      const req = new NextRequest("http://localhost/api/admin/members/import", {
        method: "POST",
        body: JSON.stringify({
          rows: [
            { firstName: "Existing", lastName: "A", email: "existing-a@test.com" },
            { firstName: "Existing", lastName: "B", email: "existing-b@test.com" },
          ],
          sendInvites: false,
        }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await importMembers(req);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.created).toBe(0);
      expect(body.skipped).toBe(2);
      expect(body.skippedRows).toEqual([
        {
          row: 1,
          email: "existing-a@test.com",
          reason: "Matching member already exists for this email and name",
        },
        {
          row: 2,
          email: "existing-b@test.com",
          reason: "Matching member already exists for this email and name",
        },
      ]);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("imports different-name rows as non-login when an existing login owns the email and suppresses invites", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([
        {
          email: "family@test.com",
          firstName: "Parent",
          lastName: "Smith",
          dateOfBirth: new Date("1970-01-01"),
          canLogin: true,
        },
      ] as any);
      const createMember = vi.fn(async ({ data }: any) => ({
        id: "new-child",
        email: data.email,
        firstName: data.firstName,
        lastName: data.lastName,
        canLogin: data.canLogin,
      }));
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
        const tx = {
          member: { create: createMember },
          memberAccessRole: {
            createMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
        };
        return fn(tx);
      });

      const req = new NextRequest("http://localhost/api/admin/members/import", {
        method: "POST",
        body: JSON.stringify({
          rows: [
            {
              firstName: "Child",
              lastName: "Smith",
              email: "family@test.com",
              dateOfBirth: "2010-05-05",
            },
          ],
          sendInvites: true,
        }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await importMembers(req);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.created).toBe(1);
      expect(body.createdLoginEnabled).toBe(0);
      expect(body.createdNonLogin).toBe(1);
      expect(createMember.mock.calls[0][0].data.canLogin).toBe(false);
      expect(body.rowNotes).toEqual([
        {
          row: 1,
          email: "family@test.com",
          note: "Imported as Can't Login because this email already has a login-enabled member",
        },
      ]);
      expect(prisma.passwordResetToken.create).not.toHaveBeenCalled();
      expect(mockedSendMemberSetupInviteEmail).not.toHaveBeenCalled();
    });

    it("returns 500 if transaction fails (no partial import)", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      vi.mocked(prisma.$transaction).mockRejectedValue(new Error("DB error"));

      const req = new NextRequest("http://localhost/api/admin/members/import", {
        method: "POST",
        body: JSON.stringify({
          rows: [{ firstName: "Alice", lastName: "A", email: "a@test.com" }],
          sendInvites: false,
        }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await importMembers(req);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toContain("no members were created");
    });

    it("returns 409 if the import hits a concurrent unique-email conflict", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      vi.mocked(prisma.$transaction).mockRejectedValue({ code: "P2002" });

      const req = new NextRequest("http://localhost/api/admin/members/import", {
        method: "POST",
        body: JSON.stringify({
          rows: [{ firstName: "Alice", lastName: "A", email: "a@test.com" }],
          sendInvites: false,
        }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await importMembers(req);
      expect(res.status).toBe(409);
    });

    it("sends setup invites for imported login members when requested", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
        const tx = {
          member: {
            create: vi.fn().mockResolvedValue({
              id: "new1",
              email: "new@test.com",
              firstName: "New",
              lastName: "User",
              canLogin: true,
            }),
          },
          memberAccessRole: {
            createMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
        };
        return fn(tx);
      });

      const req = new NextRequest("http://localhost/api/admin/members/import", {
        method: "POST",
        body: JSON.stringify({
          rows: [{ firstName: "New", lastName: "User", email: "new@test.com" }],
          sendInvites: true,
        }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await importMembers(req);

      expect(res.status).toBe(200);
      expect(prisma.passwordResetToken.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            memberId: "new1",
            tokenHash: expect.any(String),
            expiresAt: expect.any(Date),
          }),
        })
      );
      expect(mockedSendMemberSetupInviteEmail).toHaveBeenCalledWith(
        "new@test.com",
        "New",
        expect.any(String)
      );
    });
  });

  // ── A5/A6: Bulk Operations ──

  describe("A5/A6 - Bulk Operations", () => {
    it("prevents deactivating own admin account", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      const req = new NextRequest("http://localhost/api/admin/members/bulk-update", {
        method: "POST",
        body: JSON.stringify({ ids: ["admin1", "m2"], action: "deactivate" }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await bulkUpdate(req);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("cannot deactivate your own");
    });

    it("prevents demoting own admin role", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      const req = new NextRequest("http://localhost/api/admin/members/bulk-update", {
        method: "POST",
        body: JSON.stringify({ ids: ["admin1"], action: "set-role", role: "USER" }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await bulkUpdate(req);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("cannot demote your own");
    });

    it("performs bulk deactivation in a transaction with audit logs", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([
        { id: "m2", firstName: "Bob", lastName: "Smith", email: "bob@test.com" },
      ] as any);
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
        const tx = {
          $executeRaw: vi.fn().mockResolvedValue(1),
          member: {
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
            // #1604 last-admin end-state guard counts active Full Admins
            // inside the tx; two survive the set, so it does not block.
            count: vi.fn().mockResolvedValue(2),
          },
          familyGroupMember: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
          // #1756: a deactivate sweeps future shared-double placements inside
          // the transaction; no rows here, so the sweep is a no-op.
          bedAllocation: {
            findMany: vi.fn().mockResolvedValue([]),
            deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
          },
        };
        return fn(tx);
      });

      const req = new NextRequest("http://localhost/api/admin/members/bulk-update", {
        method: "POST",
        body: JSON.stringify({ ids: ["m2"], action: "deactivate" }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await bulkUpdate(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updated).toBe(1);
      expect(prisma.$transaction).toHaveBeenCalled();
      expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
        action: "member.bulk-deactivate",
        targetId: "m2",
      }));
    });

    it("performs bulk role change with audit logs", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([
        { id: "m2", firstName: "Bob", lastName: "Smith", email: "bob@test.com" },
      ] as any);
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
        const tx = {
          member: {
            update: vi.fn().mockResolvedValue({}),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
          memberAccessRole: {
            createMany: vi.fn().mockResolvedValue({ count: 1 }),
            deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
          },
        };
        return fn(tx);
      });

      const req = new NextRequest("http://localhost/api/admin/members/bulk-update", {
        method: "POST",
        body: JSON.stringify({ ids: ["m2"], action: "set-role", role: "ADMIN" }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await bulkUpdate(req);
      expect(res.status).toBe(200);
      expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
        action: "member.bulk-set-role",
      }));
    });

    it("performs bulk access-role changes through MemberAccessRole rows", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([
        {
          id: "m2",
          firstName: "Bob",
          lastName: "Smith",
          email: "bob@test.com",
          role: "USER",
          financeAccessLevel: "NONE",
          canLogin: true,
        },
      ] as any);
      const tx = {
        member: {
          update: vi.fn().mockResolvedValue({}),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        memberAccessRole: {
          createMany: vi.fn().mockResolvedValue({ count: 2 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) =>
        fn(tx),
      );

      const req = new NextRequest("http://localhost/api/admin/members/bulk-update", {
        method: "POST",
        body: JSON.stringify({
          ids: ["m2"],
          action: "set-role",
          accessRoles: ["USER", "FINANCE_USER", "FINANCE_ADMIN"],
        }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await bulkUpdate(req);

      expect(res.status).toBe(200);
      expect(tx.member.update).toHaveBeenCalledWith({
        where: { id: "m2" },
        data: {
          role: "USER",
          financeAccessLevel: "MANAGER",
        },
      });
      expect(tx.memberAccessRole.deleteMany).toHaveBeenCalledWith({
        where: { memberId: "m2" },
      });
      expect(tx.memberAccessRole.createMany).toHaveBeenCalledWith({
        data: [
          {
            memberId: "m2",
            role: "USER",
            roleDefinitionId: null,
            assignedByMemberId: "admin1",
          },
          {
            memberId: "m2",
            role: "FINANCE_ADMIN",
            roleDefinitionId: null,
            assignedByMemberId: "admin1",
          },
        ],
        skipDuplicates: true,
      });
      expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
        action: "member.bulk-set-role",
        details: expect.stringContaining("USER, FINANCE_USER, FINANCE_ADMIN"),
      }));
    });

    it("clears bulk access-role rows for non-login records", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([
        {
          id: "child-1",
          firstName: "Child",
          lastName: "Member",
          email: "child@test.com",
          role: "USER",
          financeAccessLevel: "NONE",
          canLogin: false,
        },
      ] as any);
      const tx = {
        member: {
          update: vi.fn().mockResolvedValue({}),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        memberAccessRole: {
          createMany: vi.fn().mockResolvedValue({ count: 0 }),
          deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) =>
        fn(tx),
      );

      const req = new NextRequest("http://localhost/api/admin/members/bulk-update", {
        method: "POST",
        body: JSON.stringify({
          ids: ["child-1"],
          action: "set-role",
          accessRoles: ["USER", "FINANCE_ADMIN"],
        }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await bulkUpdate(req);

      expect(res.status).toBe(200);
      expect(tx.member.update).toHaveBeenCalledWith({
        where: { id: "child-1" },
        data: {
          role: "USER",
          financeAccessLevel: "NONE",
        },
      });
      expect(tx.memberAccessRole.deleteMany).toHaveBeenCalledWith({
        where: { memberId: "child-1" },
      });
      expect(tx.memberAccessRole.createMany).not.toHaveBeenCalled();
    });

    it("requires role parameter for set-role action", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      const req = new NextRequest("http://localhost/api/admin/members/bulk-update", {
        method: "POST",
        body: JSON.stringify({ ids: ["m2"], action: "set-role" }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await bulkUpdate(req);
      expect(res.status).toBe(422);
    });
  });

  // ── A8: Member Detail View ──

  describe("A8 - Member Detail", () => {
    it("returns 404 for non-existent member", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findUnique)
        .mockResolvedValueOnce(adminAccessMember as any)
        .mockResolvedValueOnce(null);
      vi.mocked(prisma.booking.findMany).mockResolvedValue([]);
      vi.mocked(prisma.auditLog.findMany).mockResolvedValue([]);
      vi.mocked(prisma.booking.aggregate).mockResolvedValue({
        _sum: { finalPriceCents: null },
        _count: 0,
        _max: { checkOut: null },
      } as any);

      const req = new NextRequest("http://localhost/api/admin/members/nonexistent");
      const res = await getMemberDetail(req, { params: Promise.resolve({ id: "nonexistent" }) });
      expect(res.status).toBe(404);
    });

    it("returns member with booking history, stats, and cached Xero groups", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      mockIsXeroConnected.mockResolvedValue(true);
      mockGetXeroContactGroupMemberships.mockResolvedValue({
        xc1: [{ id: "cg-1", name: "Camp Families" }],
      });
      vi.mocked(prisma.member.findUnique)
        .mockResolvedValueOnce(adminAccessMember as any)
        .mockResolvedValue({
          id: "m1", firstName: "Alice", lastName: "Smith", email: "alice@test.com",
          phone: "021-123", dateOfBirth: new Date("1990-01-15"),
          role: "MEMBER", financeAccessLevel: "NONE", accessRoles: [{ role: "USER" }],
          ageTier: "ADULT", active: true, forcePasswordChange: false,
          xeroContactId: "xc1", createdAt: new Date("2025-01-01"), canLogin: true,
          subscriptions: [{ id: "s1", seasonYear: 2026, status: "PAID", xeroInvoiceId: null, paidAt: null }],
          familyGroupMemberships: [],
        } as any);
      vi.mocked(prisma.booking.findMany).mockResolvedValue([
        { id: "b1", checkIn: new Date("2026-04-10"), checkOut: new Date("2026-04-12"), status: "CONFIRMED", finalPriceCents: 9100, _count: { guests: 2 } },
      ] as any);
      vi.mocked(prisma.auditLog.findMany).mockResolvedValue([
        { id: "al1", action: "booking.created", details: "test", createdAt: new Date() },
      ] as any);
      vi.mocked(prisma.booking.aggregate).mockResolvedValue({
        _sum: { finalPriceCents: 9100 },
        _count: 1,
        _max: { checkOut: new Date("2026-04-12") },
      } as any);

      const req = new NextRequest("http://localhost/api/admin/members/m1");
      const res = await getMemberDetail(req, { params: Promise.resolve({ id: "m1" }) });
      expect(res.status).toBe(200);
      const body = await res.json();

      // Member info
      expect(body.firstName).toBe("Alice");
      // Booking history
      expect(body.bookings).toHaveLength(1);
      expect(body.bookings[0].status).toBe("CONFIRMED");
      // Stats
      expect(body.stats.totalBookings).toBe(1);
      expect(body.stats.totalSpendCents).toBe(9100);
      expect(body.stats.lastStay).toBeTruthy();
      // Audit logs
      expect(body.auditLogs).toHaveLength(1);
      // Subscriptions
      expect(body.subscriptions).toHaveLength(1);
      expect(body.xeroContactGroups).toEqual([{ id: "cg-1", name: "Camp Families" }]);
      expect(body.xeroContactGroupsLoaded).toBe(true);
    });

    it("returns assigned promo-code support context on member detail", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findUnique)
        .mockResolvedValueOnce(adminAccessMember as any)
        .mockResolvedValue({
          id: "m1", firstName: "Alice", lastName: "Smith", email: "alice@test.com",
          role: "MEMBER", financeAccessLevel: "NONE", accessRoles: [{ role: "USER" }],
          ageTier: "ADULT", active: true, forcePasswordChange: false,
          xeroContactId: null, createdAt: new Date("2025-01-01"), canLogin: true,
          subscriptions: [],
          familyGroupMemberships: [],
          dependents: [],
        } as any);
      vi.mocked(prisma.booking.findMany).mockResolvedValue([] as any);
      vi.mocked(prisma.auditLog.findMany).mockResolvedValue([] as any);
      vi.mocked(prisma.booking.aggregate).mockResolvedValue({
        _sum: { finalPriceCents: null },
        _count: 0,
        _max: { checkOut: null },
      } as any);
      vi.mocked(prisma.promoCodeAssignment.findMany).mockResolvedValue([
        {
          createdAt: new Date("2026-05-01"),
          promoCode: {
            id: "promo-1",
            code: "READY10",
            description: "Assigned and ready",
            type: "PERCENTAGE",
            percentOff: 10,
            valueCents: null,
            freeNightsPerIndividual: null,
            active: true,
            archivedAt: null,
            validFrom: null,
            validUntil: null,
            bookingStartFrom: null,
            bookingStartUntil: null,
            maxRedemptionsTotal: null,
            currentRedemptions: 0,
            maxUsesPerMember: null,
            allocations: [],
          },
        },
      ] as any);

      const req = new NextRequest("http://localhost/api/admin/members/m1");
      const res = await getMemberDetail(req, { params: Promise.resolve({ id: "m1" }) });
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.promoCodes).toEqual([
        expect.objectContaining({
          code: "READY10",
          visibleToMember: true,
          statusReason: "Available to member",
          percentOff: 10,
        }),
      ]);
    });

    it("returns member detail with the placeholder when cached Xero groups are not ready", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      mockIsXeroConnected.mockResolvedValue(true);
      vi.mocked(prisma.member.findUnique)
        .mockResolvedValueOnce(adminAccessMember as any)
        .mockResolvedValue({
          id: "m1", firstName: "Alice", lastName: "Smith", email: "alice@test.com",
          phone: "021-123", dateOfBirth: new Date("1990-01-15"),
          role: "MEMBER", financeAccessLevel: "NONE", accessRoles: [{ role: "USER" }],
          ageTier: "ADULT", active: true, forcePasswordChange: false,
          xeroContactId: "xc1", createdAt: new Date("2025-01-01"), canLogin: true,
          subscriptions: [{ id: "s1", seasonYear: 2026, status: "PAID", xeroInvoiceId: null, paidAt: null }],
          familyGroupMemberships: [],
        } as any);
      vi.mocked(prisma.booking.findMany).mockResolvedValue([] as any);
      vi.mocked(prisma.auditLog.findMany).mockResolvedValue([] as any);
      vi.mocked(prisma.booking.aggregate).mockResolvedValue({
        _sum: { finalPriceCents: null },
        _count: 0,
        _max: { checkOut: null },
      } as any);

      const req = new NextRequest("http://localhost/api/admin/members/m1");
      const res = await getMemberDetail(req, { params: Promise.resolve({ id: "m1" }) });
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.xeroContactGroups).toEqual([]);
      expect(body.xeroContactGroupsLoaded).toBe(false);
      expect(mockGetXeroContactGroupMemberships).toHaveBeenCalledWith(["xc1"]);
    });
  });

  // ── Member Create (POST) ──

  describe("Member Create", () => {
    it("returns 401 for non-admin", async () => {
      mockedAuth.mockResolvedValue(memberSession);
      vi.mocked(prisma.member.findUnique).mockResolvedValueOnce(userAccessMember as any);
      const req = new NextRequest("http://localhost/api/admin/members", {
        method: "POST",
        body: JSON.stringify({ firstName: "Test", lastName: "User", email: "test@test.com" }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await createMember(req);
      expect(res.status).toBe(401);
    });

    it("rejects duplicate email", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findFirst).mockResolvedValue({ id: "existing" } as any);

      const req = new NextRequest("http://localhost/api/admin/members", {
        method: "POST",
        body: JSON.stringify({ firstName: "Test", lastName: "User", email: "existing@test.com" }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await createMember(req);
      expect(res.status).toBe(409);
    });

    it("returns 409 if member creation hits a unique constraint after the pre-check", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.$transaction).mockRejectedValue({ code: "P2002" });

      const req = new NextRequest("http://localhost/api/admin/members", {
        method: "POST",
        body: JSON.stringify({ firstName: "Test", lastName: "User", email: "existing@test.com" }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await createMember(req);
      expect(res.status).toBe(409);
      // A P2002 that names nothing is still the email clash: on this path no
      // other unique constraint is reachable, and staying vague would leave an
      // unexplained failure.
      await expect(res.json()).resolves.toMatchObject({
        error: "A member with this email already exists",
      });
    });

    // #2412: the create path used to call ANY P2002 an email clash. These use
    // the errors adapter-pg really raises — captured live against PostgreSQL 16,
    // see `helpers/p2002-fixtures.ts`.
    const createMemberRequest = () =>
      new NextRequest("http://localhost/api/admin/members", {
        method: "POST",
        body: JSON.stringify({
          firstName: "Test",
          lastName: "User",
          email: "existing@test.com",
        }),
        headers: { "Content-Type": "application/json" },
      });

    it("blames the email when the login-email partial index really fired", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
      // The pre-check passed, then a concurrent write claimed the address.
      vi.mocked(prisma.$transaction).mockRejectedValue(
        loginEmailCollisionError(),
      );

      const res = await createMember(createMemberRequest());
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({
        error: "A member with this email already exists",
      });
    });

    it("does not blame the email when a different unique constraint fired", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.$transaction).mockRejectedValue(
        googleSubCollisionError(),
      );

      const res = await createMember(createMemberRequest());
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({
        error:
          "Could not create this member: one of their details is already used by another record",
      });
    });

    it("does not blame the email for an unnamed collision on a non-login create", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      // No pre-check runs for a non-login member — they may share an address —
      // and the partial index `WHERE "canLogin" = true` cannot fire on this
      // insert, so an unidentifiable P2002 must not be called an email clash.
      vi.mocked(prisma.$transaction).mockRejectedValue({ code: "P2002" });

      const req = new NextRequest("http://localhost/api/admin/members", {
        method: "POST",
        body: JSON.stringify({
          firstName: "Test",
          lastName: "User",
          email: "shared@test.com",
          canLogin: false,
        }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await createMember(req);
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({
        error:
          "Could not create this member: one of their details is already used by another record",
      });
    });

    it("allows shared email when creating a non-login member", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findFirst).mockResolvedValue({ id: "existing-login" } as any);
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
        const tx = {
          member: {
            count: vi.fn(),
            create: vi.fn().mockResolvedValue({
              id: "m2",
              firstName: "Shared",
              lastName: "Email",
              email: "shared@test.com",
              phoneCountryCode: null,
              phoneAreaCode: null,
              phoneNumber: null,
              dateOfBirth: null,
              role: "MEMBER",
              ageTier: "ADULT",
              active: true,
              canLogin: false,
              xeroContactId: null,
              joinedDate: null,
              createdAt: new Date("2026-04-11"),
            }),
          },
          memberAccessRole: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
          familyGroupMember: { createMany: vi.fn() },
        };
        return fn(tx);
      });

      const req = new NextRequest("http://localhost/api/admin/members", {
        method: "POST",
        body: JSON.stringify({
          firstName: "Shared",
          lastName: "Email",
          email: "shared@test.com",
          canLogin: false,
        }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await createMember(req);

      expect(res.status).toBe(201);
      expect(prisma.member.findFirst).not.toHaveBeenCalled();
    });

    it("creates a local member without auto-creating a Xero contact", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
        const tx = {
          member: {
            create: vi.fn().mockResolvedValue({
              id: "m1",
              firstName: "Test",
              lastName: "User",
              email: "test@test.com",
              phoneCountryCode: null,
              phoneAreaCode: null,
              phoneNumber: null,
              dateOfBirth: null,
              role: "MEMBER",
              ageTier: "ADULT",
              active: true,
              canLogin: true,
              xeroContactId: null,
              joinedDate: null,
              createdAt: new Date("2026-04-11"),
            }),
          },
          memberAccessRole: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
          familyGroupMember: { createMany: vi.fn() },
        };
        return fn(tx);
      });

      const req = new NextRequest("http://localhost/api/admin/members", {
        method: "POST",
        body: JSON.stringify({ firstName: "Test", lastName: "User", email: "test@test.com" }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await createMember(req);
      expect(res.status).toBe(201);
      expect(mockIsXeroConnected).not.toHaveBeenCalled();
      expect(mockEnqueueXeroEntranceFeeInvoiceOperation).not.toHaveBeenCalled();
      const body = await res.json();
      expect(body.xeroContactId).toBeNull();
    });

    it("stores joined date and both addresses when creating a member", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findFirst).mockResolvedValue(null);

      let createArgs: any;
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
        const tx = {
          member: {
            create: vi.fn().mockImplementation(async (args: any) => {
              createArgs = args;
              return {
                id: "m1",
                firstName: "Test",
                lastName: "User",
                email: "test@test.com",
                phoneCountryCode: "64",
                phoneAreaCode: "27",
                phoneNumber: "123 4567",
                dateOfBirth: new Date("1990-01-15"),
                role: "MEMBER",
                ageTier: "ADULT",
                active: true,
                canLogin: true,
                xeroContactId: null,
                joinedDate: new Date("2026-03-01"),
                createdAt: new Date("2026-04-11"),
              };
            }),
          },
          memberAccessRole: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
          familyGroupMember: { createMany: vi.fn() },
        };
        return fn(tx);
      });

      const req = new NextRequest("http://localhost/api/admin/members", {
        method: "POST",
        body: JSON.stringify({
          firstName: "Test",
          lastName: "User",
          email: "test@test.com",
          phoneCountryCode: "64",
          phoneAreaCode: "27",
          phoneNumber: "123 4567",
          dateOfBirth: "1990-01-15",
          joinedDate: "2026-03-01",
          streetAddressLine1: "12 Main St",
          streetCity: "Example",
          streetRegion: "Waikato",
          streetPostalCode: "3420",
          streetCountry: "NZ",
          postalAddressLine1: "PO Box 10",
          postalCity: "Example",
          postalRegion: "Waikato",
          postalPostalCode: "3420",
          postalCountry: "NZ",
        }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await createMember(req);
      expect(res.status).toBe(201);
      expect(createArgs.data.joinedDate).toBeInstanceOf(Date);
      expect(createArgs.data.joinedDate.toISOString().startsWith("2026-03-01")).toBe(true);
      expect(createArgs.data.streetAddressLine1).toBe("12 Main St");
      expect(createArgs.data.streetCity).toBe("Example");
      expect(createArgs.data.streetRegion).toBe("Waikato");
      expect(createArgs.data.streetPostalCode).toBe("3420");
      expect(createArgs.data.streetCountry).toBe("NZ");
      expect(createArgs.data.postalAddressLine1).toBe("PO Box 10");
      expect(createArgs.data.postalCity).toBe("Example");
      expect(createArgs.data.postalRegion).toBe("Waikato");
      expect(createArgs.data.postalPostalCode).toBe("3420");
      expect(createArgs.data.postalCountry).toBe("NZ");
    });

    it("stores finance access when creating a member", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findFirst).mockResolvedValue(null);

      let createArgs: any;
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
        const tx = {
          member: {
            create: vi.fn().mockImplementation(async (args: any) => {
              createArgs = args;
              return {
                id: "m1",
                firstName: "Finance",
                lastName: "Viewer",
                email: "finance@test.com",
                phoneCountryCode: null,
                phoneAreaCode: null,
                phoneNumber: null,
                dateOfBirth: null,
                role: "MEMBER",
                financeAccessLevel: "VIEWER",
                ageTier: "ADULT",
                active: true,
                canLogin: true,
                xeroContactId: null,
                joinedDate: null,
                createdAt: new Date("2026-04-11"),
              };
            }),
          },
          memberAccessRole: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
          familyGroupMember: { createMany: vi.fn() },
        };
        return fn(tx);
      });

      const req = new NextRequest("http://localhost/api/admin/members", {
        method: "POST",
        body: JSON.stringify({
          firstName: "Finance",
          lastName: "Viewer",
          email: "finance@test.com",
          financeAccessLevel: "VIEWER",
        }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await createMember(req);

      expect(res.status).toBe(201);
      expect(createArgs.data.financeAccessLevel).toBe("VIEWER");
    });

    it("synchronizes mixed lodge finance access roles when creating a member", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findFirst).mockResolvedValue(null);

      let createArgs: any;
      let accessRoleCreateArgs: any;
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
        const tx = {
          member: {
            create: vi.fn().mockImplementation(async (args: any) => {
              createArgs = args;
              return {
                id: "m1",
                firstName: "Lodge",
                lastName: "Finance",
                email: "lodge-finance@test.com",
                phoneCountryCode: null,
                phoneAreaCode: null,
                phoneNumber: null,
                dateOfBirth: null,
                role: "LODGE",
                financeAccessLevel: "VIEWER",
                ageTier: "ADULT",
                active: true,
                canLogin: true,
                xeroContactId: null,
                joinedDate: null,
                createdAt: new Date("2026-04-11"),
                accessRoles: [],
              };
            }),
          },
          memberAccessRole: {
            createMany: vi.fn().mockImplementation(async (args: any) => {
              accessRoleCreateArgs = args;
              return { count: args.data.length };
            }),
          },
          memberSubscription: {
            upsert: vi.fn().mockResolvedValue({}),
          },
          familyGroupMember: { createMany: vi.fn() },
        };
        return fn(tx);
      });

      const req = new NextRequest("http://localhost/api/admin/members", {
        method: "POST",
        body: JSON.stringify({
          firstName: "Lodge",
          lastName: "Finance",
          email: "lodge-finance@test.com",
          accessRoles: ["LODGE", "FINANCE_USER"],
        }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await createMember(req);

      expect(res.status).toBe(201);
      expect(createArgs.data.role).toBe("LODGE");
      expect(createArgs.data.financeAccessLevel).toBe("VIEWER");
      expect(accessRoleCreateArgs).toEqual({
        data: [
          { memberId: "m1", role: "LODGE", roleDefinitionId: null },
          { memberId: "m1", role: "FINANCE_USER", roleDefinitionId: null },
        ],
        skipDuplicates: true,
      });
    });

    it("sends a setup invite when creating a login-enabled member", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
        const tx = {
          member: {
            create: vi.fn().mockResolvedValue({
              id: "m1",
              firstName: "Invite",
              lastName: "User",
              email: "invite@test.com",
              phoneCountryCode: null,
              phoneAreaCode: null,
              phoneNumber: null,
              dateOfBirth: null,
              role: "MEMBER",
              ageTier: "ADULT",
              active: true,
              canLogin: true,
              xeroContactId: null,
              joinedDate: null,
              createdAt: new Date("2026-04-11"),
            }),
          },
          memberAccessRole: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
          familyGroupMember: { createMany: vi.fn() },
        };
        return fn(tx);
      });

      const req = new NextRequest("http://localhost/api/admin/members", {
        method: "POST",
        body: JSON.stringify({
          firstName: "Invite",
          lastName: "User",
          email: "invite@test.com",
          sendInvite: true,
        }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await createMember(req);

      expect(res.status).toBe(201);
      expect(prisma.passwordResetToken.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            memberId: "m1",
            tokenHash: expect.any(String),
            expiresAt: expect.any(Date),
          }),
        })
      );
      expect(mockedSendMemberSetupInviteEmail).toHaveBeenCalledWith(
        "invite@test.com",
        "Invite",
        expect.any(String)
      );
    });

    it("rejects setup invites for members who cannot log in", async () => {
      mockedAuth.mockResolvedValue(adminSession);

      const req = new NextRequest("http://localhost/api/admin/members", {
        method: "POST",
        body: JSON.stringify({
          firstName: "Dependent",
          lastName: "User",
          email: "dependent@test.com",
          canLogin: false,
          sendInvite: true,
        }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await createMember(req);

      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toContain("can log in");
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
