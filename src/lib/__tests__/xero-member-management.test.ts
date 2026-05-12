import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock dependencies
vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
    familyGroup: { findMany: vi.fn() },
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
vi.mock("@/lib/utils", () => ({
  getSeasonYear: vi.fn().mockReturnValue(2026),
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

const mockedAuth = vi.mocked(auth);
const adminSession = { user: { id: "admin1", role: "ADMIN" } } as any;

function mockSessionAndMemberListCounts(total: number) {
  vi.mocked(prisma.member.count)
    .mockResolvedValueOnce(1)
    .mockResolvedValueOnce(total);
}

describe("Xero Member Management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    vi.mocked(prisma.member.count).mockResolvedValue(1);
    delete process.env.XERO_ENABLE_LIVE_MEMBER_GROUP_LOOKUPS;
  });

  // ── Xero Unlink ──

  describe("POST /api/admin/members/[id]/xero-unlink", () => {
    it("returns 403 for non-admin", async () => {
      mockedAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } } as any);
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
  });
});
