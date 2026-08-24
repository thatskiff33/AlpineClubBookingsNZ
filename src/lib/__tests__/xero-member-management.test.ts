import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock dependencies
vi.mock("@/lib/prisma", () => ({
  prisma: {
    accessRoleDefinition: {
      // Empty definitions: resolution falls back to legacy bundles.
      findMany: vi.fn().mockResolvedValue([]),
    },
    member: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
    // #2623 T7: the manual-link transaction closes any provider-created
    // recovery whose own contact is the one it just linked.
    xeroSyncOperation: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    $executeRaw: vi.fn(),
    familyGroup: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
const mockRequireActiveSessionUser = vi.fn<(...args: unknown[]) => Promise<Response | null>>(async () => null);
vi.mock("@/lib/session-guards", async () => ({
  requireActiveSessionUser: (...args: Parameters<typeof mockRequireActiveSessionUser>) => mockRequireActiveSessionUser(...args),
  requireAdmin: (await import("./helpers/require-admin-mock"))
    .evaluateRequireAdminMock,
}));
vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));

const {
  mockIsXeroConnected,
  mockGetXeroContactGroupMemberships,
  mockGetXeroContactIdsForGroup,
  mockGetAuthenticatedXeroClient,
  mockCallXeroApi,
  mockFlushMemberSubscriptionHistory,
  mockRefreshXeroContactCachesFromContact,
  mockSyncMemberSubscriptionHistoryForLinkedContact,
  mockUpsertXeroObjectLink,
  mockDeactivateXeroObjectLinks,
} = vi.hoisted(() => ({
  mockIsXeroConnected: vi.fn().mockResolvedValue(false),
  mockGetXeroContactGroupMemberships: vi.fn().mockResolvedValue({}),
  mockGetXeroContactIdsForGroup: vi.fn().mockResolvedValue([]),
  mockGetAuthenticatedXeroClient: vi.fn(),
  mockCallXeroApi: vi.fn(),
  mockFlushMemberSubscriptionHistory: vi.fn().mockResolvedValue({
    seasonYears: [],
    deletedCount: 0,
    deactivatedLinkCount: 0,
  }),
  mockRefreshXeroContactCachesFromContact: vi.fn().mockResolvedValue({
    cachedContact: { contactId: "cached-contact" },
    groupMemberships: {
      contactId: "cached-contact",
      observed: false,
      contactGroupsSeen: 0,
      membershipsAdded: 0,
      membershipsRemoved: 0,
      groupsTouched: 0,
    },
  }),
  mockSyncMemberSubscriptionHistoryForLinkedContact: vi.fn().mockResolvedValue({
    seasonYears: [2026],
    syncedCount: 1,
    results: [{ seasonYear: 2026, status: "NOT_INVOICED" }],
    errors: [],
  }),
  mockUpsertXeroObjectLink: vi.fn().mockResolvedValue({}),
  mockDeactivateXeroObjectLinks: vi.fn().mockResolvedValue({ count: 1 }),
}));
vi.mock("@/lib/xero", () => ({
  isXeroConnected: mockIsXeroConnected,
  getXeroContactGroupMemberships: mockGetXeroContactGroupMemberships,
  getXeroContactIdsForGroup: mockGetXeroContactIdsForGroup,
  getAuthenticatedXeroClient: mockGetAuthenticatedXeroClient,
  callXeroApi: mockCallXeroApi,
  flushMemberSubscriptionHistory: mockFlushMemberSubscriptionHistory,
  refreshXeroContactCachesFromContact: mockRefreshXeroContactCachesFromContact,
  syncMemberSubscriptionHistoryForLinkedContact:
    mockSyncMemberSubscriptionHistoryForLinkedContact,
  findOrCreateXeroContact: vi.fn(),
}));
vi.mock("@/lib/xero-sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-sync")>();
  return {
    ...actual,
    upsertXeroObjectLink: mockUpsertXeroObjectLink,
    deactivateXeroObjectLinks: mockDeactivateXeroObjectLinks,
  };
});

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

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { GET as getMembers } from "@/app/api/admin/members/route";
import { POST as xeroUnlink } from "@/app/api/admin/members/[id]/xero-unlink/route";
import { POST as xeroLink } from "@/app/api/admin/members/[id]/xero-link/route";
import { GET as searchXeroContacts } from "@/app/api/admin/xero/search-contacts/route";
import {
  HOSTING_COVERAGE_RETRY_CODE,
  HOSTING_COVERAGE_RETRY_MESSAGE,
  HostingCoverageParticipantRetryError,
} from "@/lib/adult-member-hosting-queue-participants";

const mockedAuth = vi.mocked(auth);
const adminSession = { user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } } as any;

function mockSessionAndMemberListCounts(total: number) {
  vi.mocked(prisma.member.count)
    .mockResolvedValueOnce(1)
    .mockResolvedValueOnce(total);
}

describe("Xero Member Management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.$executeRaw).mockResolvedValue(1);
    vi.mocked(prisma.xeroSyncOperation.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.xeroSyncOperation.findMany).mockResolvedValue([]);
    vi.mocked(prisma.xeroSyncOperation.updateMany).mockResolvedValue({
      count: 0,
    } as never);
    vi.mocked(prisma.$transaction).mockImplementation(async (callback) =>
      callback(prisma as never),
    );
    mockIsXeroConnected.mockResolvedValue(false);
    mockGetXeroContactGroupMemberships.mockResolvedValue({});
    mockGetXeroContactIdsForGroup.mockResolvedValue([]);
    mockCallXeroApi.mockReset();
    mockFlushMemberSubscriptionHistory.mockReset();
    mockFlushMemberSubscriptionHistory.mockResolvedValue({
      seasonYears: [],
      deletedCount: 0,
      deactivatedLinkCount: 0,
    });
    mockSyncMemberSubscriptionHistoryForLinkedContact.mockReset();
    mockSyncMemberSubscriptionHistoryForLinkedContact.mockResolvedValue({
      seasonYears: [2026],
      syncedCount: 1,
      results: [{ seasonYear: 2026, status: "NOT_INVOICED" }],
      errors: [],
    });
    mockUpsertXeroObjectLink.mockReset();
    mockUpsertXeroObjectLink.mockResolvedValue({});
    mockDeactivateXeroObjectLinks.mockReset();
    mockDeactivateXeroObjectLinks.mockResolvedValue({ count: 1 });
    vi.mocked(prisma.member.count).mockResolvedValue(1);
    delete process.env.XERO_ENABLE_LIVE_MEMBER_GROUP_LOOKUPS;
  });

  // ── Xero Unlink ──

  describe("POST /api/admin/members/[id]/xero-unlink", () => {
    it("returns 403 for non-admin", async () => {
      mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER", accessRoles: [{ role: "USER" }] } } as any);
      const req = new NextRequest("http://localhost/api/admin/members/m1/xero-unlink", { method: "POST" });
      const res = await xeroUnlink(req, { params: Promise.resolve({ id: "m1" }) });
      expect(res.status).toBe(403);
    });

    it("returns 404 for unknown member", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findUnique).mockResolvedValue(null);
      const req = new NextRequest("http://localhost/api/admin/members/bad/xero-unlink", { method: "POST" });
      const res = await xeroUnlink(req, { params: Promise.resolve({ id: "bad" }) });
      expect(res.status).toBe(404);
    });

    it("returns 400 if member not linked to Xero", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findUnique).mockResolvedValue({
        id: "m1", firstName: "John", lastName: "Doe", xeroContactId: null,
      } as any);
      const req = new NextRequest("http://localhost/api/admin/members/m1/xero-unlink", { method: "POST" });
      const res = await xeroUnlink(req, { params: Promise.resolve({ id: "m1" }) });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("not linked");
    });

    it("unlinks member from Xero and logs audit", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findUnique).mockResolvedValue({
        id: "m1", firstName: "John", lastName: "Doe", xeroContactId: "xero-123",
      } as any);
      vi.mocked(prisma.member.update).mockResolvedValue({ id: "m1" } as any);
      const req = new NextRequest("http://localhost/api/admin/members/m1/xero-unlink", { method: "POST" });
      const res = await xeroUnlink(req, { params: Promise.resolve({ id: "m1" }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(prisma.member.update).toHaveBeenCalledWith({
        where: { id: "m1" },
        data: { xeroContactId: null },
      });
      expect(mockFlushMemberSubscriptionHistory).toHaveBeenCalledWith("m1");
      expect(logAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "XERO_UNLINK",
          targetId: "m1",
        })
      );
    });

    it("returns proven unlink recovery when subscription cleanup fails", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findUnique).mockResolvedValue({
        id: "m1", firstName: "John", lastName: "Doe", xeroContactId: "xero-123",
      } as any);
      vi.mocked(prisma.member.update).mockResolvedValue({ id: "m1" } as any);
      mockFlushMemberSubscriptionHistory.mockRejectedValueOnce(
        new Error("private cleanup detail"),
      );

      const res = await xeroUnlink(
        new NextRequest("http://localhost/api/admin/members/m1/xero-unlink", {
          method: "POST",
        }),
        { params: Promise.resolve({ id: "m1" }) },
      );
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body).toEqual(
        expect.objectContaining({
          code: "XERO_PARTIAL_SUCCESS",
          recoveryKind: "CONTACT_UNLINKED",
          xeroContactUnlinked: true,
          subscriptionCleanupPending: true,
          xeroPostProcessingPending: true,
          // #2623 T3: this failure lands before the CONTACT ledger
          // deactivation and before the audit write, so both are disclosed.
          contactLinkRowsMayRemainActive: true,
          auditEntryMayBeMissing: true,
        }),
      );
      expect(body.error).toContain("may also still be ACTIVE");
      expect(body.error).toContain("audit entry for this action may be missing");
      expect(body).not.toHaveProperty("subscriptionRefreshPending");
      expect(JSON.stringify(body)).not.toContain("private cleanup detail");
    });

    it("does not claim cleanup pending when only post-cleanup audit fails", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findUnique).mockResolvedValue({
        id: "m1", firstName: "John", lastName: "Doe", xeroContactId: "xero-123",
      } as any);
      vi.mocked(prisma.member.update).mockResolvedValue({ id: "m1" } as any);
      vi.mocked(logAudit).mockRejectedValueOnce(new Error("private audit detail"));

      const res = await xeroUnlink(
        new NextRequest("http://localhost/api/admin/members/m1/xero-unlink", {
          method: "POST",
        }),
        { params: Promise.resolve({ id: "m1" }) },
      );
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body.recoveryKind).toBe("CONTACT_UNLINKED");
      expect(body).not.toHaveProperty("subscriptionCleanupPending");
      // #2623 T3: the ledger deactivation DID run here, so the disclosure is
      // scoped to the audit entry only — the flags stay per-step, not blanket.
      expect(body).not.toHaveProperty("contactLinkRowsMayRemainActive");
      expect(body.auditEntryMayBeMissing).toBe(true);
      expect(body.error).not.toContain("may also still be ACTIVE");
      expect(body.error).toContain("audit entry for this action may be missing");
      expect(JSON.stringify(body)).not.toContain("private audit detail");
    });

    it("returns partial-success recovery when operation-link cleanup fails after unlink", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findUnique).mockResolvedValue({
        id: "m1", firstName: "John", lastName: "Doe", xeroContactId: "xero-123",
      } as any);
      vi.mocked(prisma.member.update).mockResolvedValue({ id: "m1" } as any);
      mockDeactivateXeroObjectLinks.mockRejectedValueOnce(
        new Error("private operation-link detail"),
      );

      const res = await xeroUnlink(
        new NextRequest("http://localhost/api/admin/members/m1/xero-unlink", {
          method: "POST",
        }),
        { params: Promise.resolve({ id: "m1" }) },
      );
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body).toEqual(
        expect.objectContaining({
          code: "XERO_PARTIAL_SUCCESS",
          recoveryKind: "CONTACT_UNLINKED",
          xeroContactUnlinked: true,
          xeroLinkMayHaveChanged: true,
          xeroPostProcessingPending: true,
          // #2623 T3: this is EXACTLY the end state the report described —
          // pointer nulled, CONTACT ledger rows still active, no audit row. The
          // route always caught it, but the copy never said either of those two
          // things, so the operator had nothing to go and check.
          contactLinkRowsMayRemainActive: true,
          auditEntryMayBeMissing: true,
        }),
      );
      expect(body.error).toContain(
        "check the member's Xero links and deactivate any that remain",
      );
      expect(body.error).toContain("audit entry for this action may be missing");
      expect(body).not.toHaveProperty("subscriptionCleanupPending");
      expect(JSON.stringify(body)).not.toContain("private operation-link detail");
      expect(logAudit).not.toHaveBeenCalled();
    });
  });

  // ── Xero Contact Group Filter ──

  describe("GET /api/admin/members - xeroContactGroup filter", () => {
    const baseMember = {
      id: "m1", firstName: "John", lastName: "Doe", email: "john@test.com",
      phoneCountryCode: null, phoneAreaCode: null, phoneNumber: null,
      dateOfBirth: null, role: "MEMBER", ageTier: "ADULT", active: true,
      canLogin: true, xeroContactId: "xero-1", joinedDate: null, createdAt: new Date(),
      forcePasswordChange: false,
      streetAddressLine1: null, streetAddressLine2: null, streetCity: null,
      streetRegion: null, streetPostalCode: null, streetCountry: null,
      postalAddressLine1: null, postalAddressLine2: null, postalCity: null,
      postalRegion: null, postalPostalCode: null, postalCountry: null,
      familyGroupMemberships: [],
      subscriptions: [{ status: "PAID", seasonYear: 2026, xeroInvoiceId: null }],
    };

    it("filters by Xero contact group when connected", async () => {
      process.env.XERO_ENABLE_LIVE_MEMBER_GROUP_LOOKUPS = "true";
      mockedAuth.mockResolvedValue(adminSession);
      mockIsXeroConnected.mockResolvedValue(true);
      mockGetXeroContactIdsForGroup.mockResolvedValue(["xero-1", "xero-2"]);
      vi.mocked(prisma.member.findMany).mockResolvedValue([baseMember] as any);
      mockSessionAndMemberListCounts(1);

      const req = new NextRequest("http://localhost/api/admin/members?xeroContactGroup=group-1");
      const res = await getMembers(req);
      expect(res.status).toBe(200);

      // Verify the group filter was called
      expect(mockGetXeroContactIdsForGroup).toHaveBeenCalledWith("group-1");

      // Verify the Prisma query included the xeroContactId filter
      const call = vi.mocked(prisma.member.findMany).mock.calls[0][0] as any;
      const andConditions = call.where.AND;
      const xeroFilter = andConditions.find(
        (c: any) => c.xeroContactId?.in
      );
      expect(xeroFilter).toBeDefined();
      expect(xeroFilter.xeroContactId.in).toEqual(["xero-1", "xero-2"]);
    });

    it("returns empty when group has no contacts", async () => {
      process.env.XERO_ENABLE_LIVE_MEMBER_GROUP_LOOKUPS = "true";
      mockedAuth.mockResolvedValue(adminSession);
      mockIsXeroConnected.mockResolvedValue(true);
      mockGetXeroContactIdsForGroup.mockResolvedValue([]);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      mockSessionAndMemberListCounts(0);

      const req = new NextRequest("http://localhost/api/admin/members?xeroContactGroup=empty-group");
      const res = await getMembers(req);
      expect(res.status).toBe(200);

      const call = vi.mocked(prisma.member.findMany).mock.calls[0][0] as any;
      const andConditions = call.where.AND;
      const xeroFilter = andConditions.find(
        (c: any) => c.xeroContactId?.in
      );
      expect(xeroFilter).toBeDefined();
      expect(xeroFilter.xeroContactId.in).toEqual([]);
    });

    it("skips filter when xeroContactGroup is 'all'", async () => {
      process.env.XERO_ENABLE_LIVE_MEMBER_GROUP_LOOKUPS = "true";
      mockedAuth.mockResolvedValue(adminSession);
      mockIsXeroConnected.mockResolvedValue(true);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      mockSessionAndMemberListCounts(0);

      const req = new NextRequest("http://localhost/api/admin/members?xeroContactGroup=all");
      const res = await getMembers(req);
      expect(res.status).toBe(200);
      expect(mockGetXeroContactIdsForGroup).not.toHaveBeenCalled();
    });

    it("falls through gracefully when Xero call fails", async () => {
      process.env.XERO_ENABLE_LIVE_MEMBER_GROUP_LOOKUPS = "true";
      mockedAuth.mockResolvedValue(adminSession);
      mockIsXeroConnected.mockResolvedValue(true);
      mockGetXeroContactIdsForGroup.mockRejectedValue(new Error("API error"));
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      mockSessionAndMemberListCounts(0);

      const req = new NextRequest("http://localhost/api/admin/members?xeroContactGroup=group-1");
      const res = await getMembers(req);
      // Should still succeed — filter just not applied
      expect(res.status).toBe(200);
    });

    it("skips the Xero group filter when live lookups are disabled", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      mockIsXeroConnected.mockResolvedValue(true);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      mockSessionAndMemberListCounts(0);

      const req = new NextRequest("http://localhost/api/admin/members?xeroContactGroup=group-1");
      const res = await getMembers(req);

      expect(res.status).toBe(200);
      expect(mockGetXeroContactIdsForGroup).not.toHaveBeenCalled();
    });

    it("accepts the legacy search query parameter for promo assignment lookups", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      mockSessionAndMemberListCounts(0);

      const req = new NextRequest(
        "http://localhost/api/admin/members?search=alice&pageSize=10&active=true"
      );
      const res = await getMembers(req);

      expect(res.status).toBe(200);

      const call = vi.mocked(prisma.member.findMany).mock.calls[0][0] as any;
      expect(call.where.AND).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            OR: expect.arrayContaining([
              { firstName: { contains: "alice", mode: "insensitive" } },
              { lastName: { contains: "alice", mode: "insensitive" } },
              { email: { contains: "alice", mode: "insensitive" } },
            ]),
          }),
        ])
      );
    });

    it("matches multi-word member searches token-by-token", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      mockSessionAndMemberListCounts(0);

      const req = new NextRequest(
        "http://localhost/api/admin/members?q=Oscar%20van%20Wheeler&pageSize=10"
      );
      const res = await getMembers(req);

      expect(res.status).toBe(200);

      const call = vi.mocked(prisma.member.findMany).mock.calls[0][0] as any;
      const searchCondition = call.where.AND[0];
      const tokenizedNameCondition = searchCondition.OR.find((condition: any) =>
        Array.isArray(condition.AND)
      );

      expect(tokenizedNameCondition).toBeDefined();
      expect(tokenizedNameCondition.AND).toHaveLength(3);
      expect(tokenizedNameCondition.AND[0].OR).toEqual(
        expect.arrayContaining([
          { firstName: { contains: "Oscar", mode: "insensitive" } },
          { lastName: { contains: "Oscar", mode: "insensitive" } },
          { email: { contains: "Oscar", mode: "insensitive" } },
        ])
      );
      expect(tokenizedNameCondition.AND[1].OR).toEqual(
        expect.arrayContaining([
          { firstName: { contains: "van", mode: "insensitive" } },
          { lastName: { contains: "van", mode: "insensitive" } },
          { email: { contains: "van", mode: "insensitive" } },
        ])
      );
      expect(tokenizedNameCondition.AND[2].OR).toEqual(
        expect.arrayContaining([
          { firstName: { contains: "Wheeler", mode: "insensitive" } },
          { lastName: { contains: "Wheeler", mode: "insensitive" } },
          { email: { contains: "Wheeler", mode: "insensitive" } },
        ])
      );
    });

    it("supports filtering searches to multiple age tiers", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      mockSessionAndMemberListCounts(0);

      const req = new NextRequest(
        "http://localhost/api/admin/members?q=oscar&active=true&ageTierIn=INFANT,CHILD,YOUTH&pageSize=10"
      );
      const res = await getMembers(req);

      expect(res.status).toBe(200);

      const call = vi.mocked(prisma.member.findMany).mock.calls[0][0] as any;
      expect(call.where.AND).toEqual(
        expect.arrayContaining([
          { active: true },
          { ageTier: { in: ["INFANT", "CHILD", "YOUTH"] } },
        ])
      );
    });
  });

  describe("GET /api/admin/xero/search-contacts", () => {
    it("uses the SDK searchTerm parameter and annotates linked contacts", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      const getContactsMock = vi.fn().mockResolvedValue({
        body: {
          contacts: [
            {
              contactID: "xero-1",
              name: "Alice Example",
              emailAddress: "alice@example.com",
            },
            {
              contactID: "xero-2",
              name: "Bob Example",
              emailAddress: "bob@example.com",
            },
          ],
        },
      });
      mockGetAuthenticatedXeroClient.mockResolvedValue({
        xero: { accountingApi: { getContacts: getContactsMock } },
        tenantId: "tenant-1",
      });
      mockCallXeroApi.mockImplementation(async (fn) => fn());
      vi.mocked(prisma.member.findMany).mockResolvedValue([
        {
          xeroContactId: "xero-1",
          firstName: "Alice",
          lastName: "Member",
        },
      ] as any);

      const req = new NextRequest(
        "http://localhost/api/admin/xero/search-contacts?q=alice"
      );
      const res = await searchXeroContacts(req);

      expect(res.status).toBe(200);
      expect(mockCallXeroApi).toHaveBeenCalledTimes(1);

      expect(getContactsMock).toHaveBeenCalledWith(
        "tenant-1",
        undefined,
        undefined,
        undefined,
        undefined,
        1,
        false,
        true,
        "alice",
        20
      );

      const data = await res.json();
      expect(data.contacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            contactId: "xero-1",
            isLinked: true,
            linkedMemberName: "Alice Member",
          }),
          expect.objectContaining({
            contactId: "xero-2",
            isLinked: false,
            linkedMemberName: null,
          }),
        ])
      );
    });
  });

  // ── Xero Link (change contact) ──

  describe("POST /api/admin/members/[id]/xero-link - change contact", () => {
    it("allows relinking to a different Xero contact", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findUnique).mockResolvedValue({
        id: "m1", firstName: "John", lastName: "Doe", xeroContactId: "old-xero-id",
      } as any);

      // No other member has this contact
      vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.member.update).mockResolvedValue({ id: "m1" } as any);

      mockGetAuthenticatedXeroClient.mockResolvedValue({
        xero: { accountingApi: { getContact: vi.fn() } },
        tenantId: "t1",
      });
      mockCallXeroApi.mockResolvedValue({
        body: { contacts: [{ contactID: "new-xero-id", name: "Jane Doe" }] },
      });

      const req = new NextRequest("http://localhost/api/admin/members/m1/xero-link", {
        method: "POST",
        body: JSON.stringify({ xeroContactId: "new-xero-id" }),
      });
      const res = await xeroLink(req, { params: Promise.resolve({ id: "m1" }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.contactName).toBe("Jane Doe");
      expect(prisma.member.update).toHaveBeenCalledWith({
        where: { id: "m1" },
        data: { xeroContactId: "new-xero-id" },
      });
      expect(mockUpsertXeroObjectLink).toHaveBeenCalledWith(
        expect.objectContaining({
          localModel: "Member",
          localId: "m1",
          xeroObjectType: "CONTACT",
          xeroObjectId: "new-xero-id",
          role: "CONTACT",
        }),
        { store: prisma },
      );
      expect(
        vi.mocked(prisma.member.update).mock.invocationCallOrder[0],
      ).toBeLessThan(mockUpsertXeroObjectLink.mock.invocationCallOrder[0]);
      expect(mockFlushMemberSubscriptionHistory).toHaveBeenCalledWith("m1");
      expect(
        mockSyncMemberSubscriptionHistoryForLinkedContact
      ).toHaveBeenCalledWith(
        "m1",
        expect.objectContaining({
          forceRefreshOnlineInvoiceUrl: true,
        })
      );
      expect(mockRefreshXeroContactCachesFromContact).toHaveBeenCalledWith(
        { contactID: "new-xero-id", name: "Jane Doe" }
      );
    });

    // #2623 T7: the manual link IS the documented remedy for a create whose
    // Xero contact exists but whose local link failed. Before this, recovering
    // the member left that operation open forever, so member merge and account
    // deletion kept refusing them while their detail page reported a clean Xero
    // state — and `manuallyResolvedAt` was written in exactly one place in the
    // codebase, the admin resolve action on a different screen.
    it("closes the provider-created create recovery it just completed", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findUnique).mockResolvedValue({
        id: "m1", firstName: "John", lastName: "Doe", xeroContactId: null,
      } as never);
      vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.xeroSyncOperation.findMany).mockResolvedValue([
        {
          id: "op-provider-created",
          responsePayload: {
            phase: "provider_contact_created_local_link_pending",
            providerContactCreated: true,
            resolvedContactId: "new-xero-id",
          },
        },
      ] as never);
      vi.mocked(prisma.xeroSyncOperation.updateMany).mockResolvedValue({
        count: 1,
      } as never);
      mockGetAuthenticatedXeroClient.mockResolvedValue({
        xero: { accountingApi: { getContact: vi.fn() } },
        tenantId: "t1",
      });
      mockCallXeroApi.mockResolvedValue({
        body: { contacts: [{ contactID: "new-xero-id", name: "Jane Doe" }] },
      });

      const res = await xeroLink(
        new NextRequest("http://localhost/api/admin/members/m1/xero-link", {
          method: "POST",
          body: JSON.stringify({ xeroContactId: "new-xero-id" }),
        }),
        { params: Promise.resolve({ id: "m1" }) },
      );

      expect(res.status).toBe(200);
      expect(prisma.xeroSyncOperation.updateMany).toHaveBeenCalledWith({
        where: {
          id: { in: ["op-provider-created"] },
          status: "FAILED",
          manuallyResolvedAt: null,
        },
        data: expect.objectContaining({ status: "SUCCEEDED" }),
      });
      // Same transaction as the pointer and ledger writes, so merge/deletion
      // cannot observe a linked member with the operation still open.
      expect(
        vi.mocked(prisma.member.update).mock.invocationCallOrder[0],
      ).toBeLessThan(
        vi.mocked(prisma.xeroSyncOperation.updateMany).mock
          .invocationCallOrder[0],
      );
    });

    it("leaves a create recovery for a DIFFERENT contact open on a manual link", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findUnique).mockResolvedValue({
        id: "m1", firstName: "John", lastName: "Doe", xeroContactId: null,
      } as never);
      vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.xeroSyncOperation.findMany).mockResolvedValue([
        {
          id: "op-provider-created",
          responsePayload: {
            phase: "provider_contact_created_local_link_pending",
            providerContactCreated: true,
            resolvedContactId: "some-other-contact",
          },
        },
      ] as never);
      mockGetAuthenticatedXeroClient.mockResolvedValue({
        xero: { accountingApi: { getContact: vi.fn() } },
        tenantId: "t1",
      });
      mockCallXeroApi.mockResolvedValue({
        body: { contacts: [{ contactID: "new-xero-id", name: "Jane Doe" }] },
      });

      const res = await xeroLink(
        new NextRequest("http://localhost/api/admin/members/m1/xero-link", {
          method: "POST",
          body: JSON.stringify({ xeroContactId: "new-xero-id" }),
        }),
        { params: Promise.resolve({ id: "m1" }) },
      );

      // Xero holds a second contact for this member; that is a duplicate an
      // operator must adjudicate, not something a link may wave away.
      expect(res.status).toBe(200);
      expect(prisma.xeroSyncOperation.updateMany).not.toHaveBeenCalled();
    });

    it("rejects linking to a contact already linked to another member", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findUnique).mockResolvedValue({
        id: "m1", firstName: "John", lastName: "Doe", xeroContactId: null,
      } as any);

      mockGetAuthenticatedXeroClient.mockResolvedValue({
        xero: { accountingApi: { getContact: vi.fn() } },
        tenantId: "t1",
      });
      mockCallXeroApi.mockResolvedValue({
        body: { contacts: [{ contactID: "xero-taken", name: "Taken Contact" }] },
      });

      vi.mocked(prisma.member.findFirst).mockResolvedValue({
        firstName: "Other", lastName: "Person",
      } as any);

      const req = new NextRequest("http://localhost/api/admin/members/m1/xero-link", {
        method: "POST",
        body: JSON.stringify({ xeroContactId: "xero-taken" }),
      });
      const res = await xeroLink(req, { params: Promise.resolve({ id: "m1" }) });
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toContain("already linked");
    });

    it("returns a privacy-safe 409 when an ambiguous contact create owns the member fence", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findUnique).mockResolvedValue({
        id: "m1",
        firstName: "John",
        lastName: "Doe",
        xeroContactId: null,
      } as never);
      vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.xeroSyncOperation.findFirst).mockResolvedValue({
        id: "operation-running",
      } as never);
      mockGetAuthenticatedXeroClient.mockResolvedValue({
        xero: { accountingApi: { getContact: vi.fn() } },
        tenantId: "t1",
      });
      mockCallXeroApi.mockResolvedValue({
        body: { contacts: [{ contactID: "xero-target", name: "Target Contact" }] },
      });

      const response = await xeroLink(
        new NextRequest("http://localhost/api/admin/members/m1/xero-link", {
          method: "POST",
          body: JSON.stringify({ xeroContactId: "xero-target" }),
        }),
        { params: Promise.resolve({ id: "m1" }) },
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error:
          "A Xero contact create is still in progress or awaiting recovery. Refresh this member before taking another Xero action.",
        code: "XERO_CONTACT_CREATE_IN_PROGRESS",
      });
      expect(prisma.member.update).not.toHaveBeenCalled();
      expect(mockUpsertXeroObjectLink).not.toHaveBeenCalled();
    });

    it("refuses an anonymised member before the Xero contact lookup", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findUnique).mockResolvedValue({
        id: "m1",
        firstName: "Deleted",
        lastName: "Member",
        email: "deleted-m1@deleted.invalid",
        passwordHash: "DELETED_ACCOUNT",
        xeroContactId: null,
      } as never);

      const response = await xeroLink(
        new NextRequest("http://localhost/api/admin/members/m1/xero-link", {
          method: "POST",
          body: JSON.stringify({ xeroContactId: "xero-target" }),
        }),
        { params: Promise.resolve({ id: "m1" }) },
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error:
          "This member account is no longer available for Xero contact changes. Refresh the member and do not retry this action.",
        code: "XERO_MEMBER_UNAVAILABLE",
      });
      expect(mockGetAuthenticatedXeroClient).not.toHaveBeenCalled();
      expect(mockCallXeroApi).not.toHaveBeenCalled();
      expect(prisma.member.update).not.toHaveBeenCalled();
      expect(mockUpsertXeroObjectLink).not.toHaveBeenCalled();
    });

    it("does not swallow participant contention as a successful history warning after the link persisted", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findUnique).mockResolvedValue({
        id: "m1",
        firstName: "John",
        lastName: "Doe",
        xeroContactId: "old-xero-id",
      } as any);
      vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.member.update).mockResolvedValue({ id: "m1" } as any);
      mockGetAuthenticatedXeroClient.mockResolvedValue({
        xero: { accountingApi: { getContact: vi.fn() } },
        tenantId: "t1",
      });
      mockCallXeroApi.mockResolvedValue({
        body: { contacts: [{ contactID: "new-xero-id", name: "Jane Doe" }] },
      });
      mockSyncMemberSubscriptionHistoryForLinkedContact.mockRejectedValue(
        new HostingCoverageParticipantRetryError(),
      );

      const response = await xeroLink(
        new NextRequest("http://localhost/api/admin/members/m1/xero-link", {
          method: "POST",
          body: JSON.stringify({ xeroContactId: "new-xero-id" }),
        }),
        { params: Promise.resolve({ id: "m1" }) },
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: HOSTING_COVERAGE_RETRY_MESSAGE,
        code: HOSTING_COVERAGE_RETRY_CODE,
        recoveryKind: "CONTACT_LINKED",
        xeroLinkMayHaveChanged: true,
        xeroContactLinked: true,
        xeroContactId: "new-xero-id",
        subscriptionRefreshPending: true,
        xeroPostProcessingPending: true,
      });
      expect(prisma.member.update).toHaveBeenCalledWith({
        where: { id: "m1" },
        data: { xeroContactId: "new-xero-id" },
      });
      expect(logAudit).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: "XERO_LINK" }),
      );
    });

    it("does not claim the member link committed when atomic object-link bookkeeping rolls back", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findUnique).mockResolvedValue({
        id: "m1", firstName: "John", lastName: "Doe", xeroContactId: null,
      } as any);
      vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.member.update).mockResolvedValue({ id: "m1" } as any);
      mockGetAuthenticatedXeroClient.mockResolvedValue({
        xero: { accountingApi: { getContact: vi.fn() } }, tenantId: "t1",
      });
      mockCallXeroApi.mockResolvedValue({
        body: { contacts: [{ contactID: "new-xero-id", name: "Jane Doe" }] },
      });
      mockUpsertXeroObjectLink.mockRejectedValueOnce(
        new Error("private object-link detail"),
      );

      const res = await xeroLink(
        new NextRequest("http://localhost/api/admin/members/m1/xero-link", {
          method: "POST",
          body: JSON.stringify({ xeroContactId: "new-xero-id" }),
        }),
        { params: Promise.resolve({ id: "m1" }) },
      );
      const body = await res.json();

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(body).not.toHaveProperty("recoveryKind");
      expect(body).not.toHaveProperty("xeroContactLinked");
      expect(JSON.stringify(body)).not.toContain("private object-link detail");
    });

    it("does not claim refresh pending when only post-refresh audit fails", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findUnique).mockResolvedValue({
        id: "m1", firstName: "John", lastName: "Doe", xeroContactId: null,
      } as any);
      vi.mocked(prisma.member.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.member.update).mockResolvedValue({ id: "m1" } as any);
      mockGetAuthenticatedXeroClient.mockResolvedValue({
        xero: { accountingApi: { getContact: vi.fn() } }, tenantId: "t1",
      });
      mockCallXeroApi.mockResolvedValue({
        body: { contacts: [{ contactID: "new-xero-id", name: "Jane Doe" }] },
      });
      vi.mocked(logAudit).mockRejectedValueOnce(new Error("private audit detail"));

      const res = await xeroLink(
        new NextRequest("http://localhost/api/admin/members/m1/xero-link", {
          method: "POST",
          body: JSON.stringify({ xeroContactId: "new-xero-id" }),
        }),
        { params: Promise.resolve({ id: "m1" }) },
      );
      const body = await res.json();

      expect(res.status).toBe(409);
      expect(body.recoveryKind).toBe("CONTACT_LINKED");
      expect(body).not.toHaveProperty("subscriptionRefreshPending");
      expect(JSON.stringify(body)).not.toContain("private audit detail");
    });
  });
});
