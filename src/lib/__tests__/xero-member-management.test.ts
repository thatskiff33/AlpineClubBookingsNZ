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
  mockWithXeroRetry,
} = vi.hoisted(() => ({
  mockIsXeroConnected: vi.fn().mockResolvedValue(false),
  mockGetXeroContactGroupMemberships: vi.fn().mockResolvedValue({}),
  mockGetXeroContactIdsForGroup: vi.fn().mockResolvedValue([]),
  mockGetAuthenticatedXeroClient: vi.fn(),
  mockWithXeroRetry: vi.fn(),
}));
vi.mock("@/lib/xero", () => ({
  isXeroConnected: mockIsXeroConnected,
  getXeroContactGroupMemberships: mockGetXeroContactGroupMemberships,
  getXeroContactIdsForGroup: mockGetXeroContactIdsForGroup,
  getAuthenticatedXeroClient: mockGetAuthenticatedXeroClient,
  withXeroRetry: mockWithXeroRetry,
  findOrCreateXeroContact: vi.fn(),
}));

vi.mock("@/lib/age-tier", () => ({
  computeAgeTier: vi.fn().mockResolvedValue("ADULT"),
  getSeasonStartDate: vi.fn().mockReturnValue(new Date("2026-04-01")),
}));

import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { GET as getMembers } from "@/app/api/admin/members/route";
import { POST as xeroUnlink } from "@/app/api/admin/members/[id]/xero-unlink/route";
import { POST as xeroLink } from "@/app/api/admin/members/[id]/xero-link/route";

const mockedAuth = vi.mocked(auth);
const adminSession = { user: { id: "admin1", role: "ADMIN" } } as any;

describe("Xero Member Management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsXeroConnected.mockResolvedValue(false);
    mockGetXeroContactGroupMemberships.mockResolvedValue({});
    mockGetXeroContactIdsForGroup.mockResolvedValue([]);
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
      mockedAuth.mockResolvedValue(adminSession);
      mockIsXeroConnected.mockResolvedValue(true);
      mockGetXeroContactIdsForGroup.mockResolvedValue(["xero-1", "xero-2"]);
      vi.mocked(prisma.member.findMany).mockResolvedValue([baseMember] as any);
      vi.mocked(prisma.member.count).mockResolvedValue(1);

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
      mockedAuth.mockResolvedValue(adminSession);
      mockIsXeroConnected.mockResolvedValue(true);
      mockGetXeroContactIdsForGroup.mockResolvedValue([]);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      vi.mocked(prisma.member.count).mockResolvedValue(0);

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
      mockedAuth.mockResolvedValue(adminSession);
      mockIsXeroConnected.mockResolvedValue(true);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      vi.mocked(prisma.member.count).mockResolvedValue(0);

      const req = new NextRequest("http://localhost/api/admin/members?xeroContactGroup=all");
      const res = await getMembers(req);
      expect(res.status).toBe(200);
      expect(mockGetXeroContactIdsForGroup).not.toHaveBeenCalled();
    });

    it("falls through gracefully when Xero call fails", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      mockIsXeroConnected.mockResolvedValue(true);
      mockGetXeroContactIdsForGroup.mockRejectedValue(new Error("API error"));
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      vi.mocked(prisma.member.count).mockResolvedValue(0);

      const req = new NextRequest("http://localhost/api/admin/members?xeroContactGroup=group-1");
      const res = await getMembers(req);
      // Should still succeed — filter just not applied
      expect(res.status).toBe(200);
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
      mockWithXeroRetry.mockResolvedValue({
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
      mockWithXeroRetry.mockResolvedValue({
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
