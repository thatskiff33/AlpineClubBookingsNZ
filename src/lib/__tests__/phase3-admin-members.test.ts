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
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    booking: {
      findMany: vi.fn(),
      aggregate: vi.fn(),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}), findMany: vi.fn() },
    passwordResetToken: { create: vi.fn() },
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
vi.mock("@/lib/audit", () => ({
  buildStructuredAuditLogCreateArgs: vi.fn((event) => ({ data: event })),
  getAuditEmailDomain: vi.fn((email?: string | null) =>
    email?.split("@")[1]?.toLowerCase() ?? null
  ),
  getAuditRequestContext: vi.fn(() => ({ ipAddress: "127.0.0.1" })),
  logAudit: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({ applyRateLimit: vi.fn().mockReturnValue(null) }));
vi.mock("@/lib/age-tier", () => ({
  computeAgeTier: vi.fn().mockResolvedValue("ADULT"),
  getSeasonStartDate: vi.fn().mockReturnValue(new Date("2026-04-01")),
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
import { logAudit } from "@/lib/audit";
import { sendMemberSetupInviteEmail } from "@/lib/email";
import { GET as getMembers, POST as createMember } from "@/app/api/admin/members/route";
import { GET as exportMembers } from "@/app/api/admin/members/export/route";
import { POST as importMembers } from "@/app/api/admin/members/import/route";
import { POST as bulkUpdate } from "@/app/api/admin/members/bulk-update/route";
import { GET as getMemberDetail } from "@/app/api/admin/members/[id]/route";

const mockedAuth = vi.mocked(auth);
const mockedSendMemberSetupInviteEmail = vi.mocked(sendMemberSetupInviteEmail);
const adminSession = { user: { id: "admin1", role: "ADMIN" } } as any;
const memberSession = { user: { id: "m1", role: "MEMBER" } } as any;

function mockSessionAndMemberListCounts(total: number) {
  vi.mocked(prisma.member.count).mockResolvedValue(total);
}

describe("Phase 3: Admin Member Management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsXeroConnected.mockResolvedValue(false);
    mockGetXeroContactGroupMemberships.mockResolvedValue({});
    vi.mocked(prisma.member.count).mockResolvedValue(1);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({
      id: "session-member",
      active: true,
      forcePasswordChange: false,
    } as any);
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
      expect(call.where?.AND).toEqual(expect.arrayContaining([{ role: "ADMIN" }]));
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
          { parentMemberId: null },
          { inheritEmailFromId: null },
          { id: { not: "child-1" } },
        ])
      );
    });

    it("combines text search with filters (AND logic)", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);
      mockSessionAndMemberListCounts(0);

      await getMembers(new NextRequest("http://localhost/api/admin/members?q=alice&role=MEMBER&active=true"));
      const call = vi.mocked(prisma.member.findMany).mock.calls[0][0]!;
      const andConditions = call.where?.AND as any[];
      expect(andConditions.length).toBe(3); // text search + role + active
      expect(andConditions).toEqual(expect.arrayContaining([
        { role: "MEMBER" },
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
      expect(call.where?.AND).toEqual(expect.arrayContaining([
        { subscriptions: { none: { seasonYear: 2026 } } },
      ]));
    });

  });

  // ── A3: CSV Export ──

  describe("A3 - CSV Export", () => {
    it("returns 401 for non-admin", async () => {
      mockedAuth.mockResolvedValue(memberSession);
      const res = await exportMembers(new NextRequest("http://localhost/api/admin/members/export"));
      expect(res.status).toBe(401);
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
      expect(lines[0]).toBe("First Name,Last Name,Email,Phone Country Code,Phone Area Code,Phone Number,Date of Birth,Role,Age Tier,Active,Xero Contact ID,Subscription Status,Created At");
      expect(lines[1]).toContain("Alice");
      expect(lines[1]).toContain("PAID");
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
    it("returns 401 for non-admin", async () => {
      mockedAuth.mockResolvedValue(memberSession);
      const req = new NextRequest("http://localhost/api/admin/members/import", {
        method: "POST",
        body: JSON.stringify({ rows: [], sendInvites: false }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await importMembers(req);
      expect(res.status).toBe(401);
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

    it("detects duplicate emails within file", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]);

      const req = new NextRequest("http://localhost/api/admin/members/import", {
        method: "POST",
        body: JSON.stringify({
          rows: [
            { firstName: "Alice", lastName: "A", email: "dup@test.com" },
            { firstName: "Bob", lastName: "B", email: "dup@test.com" },
          ],
          sendInvites: false,
        }),
        headers: { "Content-Type": "application/json" },
      });
      const res = await importMembers(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.errors.length).toBeGreaterThan(0);
      // All-or-nothing: no members created when errors exist
      expect(body.created).toBe(0);
    });

    it("creates members in a transaction (all-or-nothing)", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([]); // no existing

      const mockCreated = [
        { id: "new1", email: "a@test.com", firstName: "Alice", lastName: "A" },
        { id: "new2", email: "b@test.com", firstName: "Bob", lastName: "B" },
      ];
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
        const tx = {
          member: { create: vi.fn() },
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
    });

    it("skips members that already exist in DB", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      vi.mocked(prisma.member.findMany).mockResolvedValue([
        { email: "existing@test.com" },
      ] as any);
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
        const tx = { member: { create: vi.fn().mockResolvedValue({ id: "new1", email: "new@test.com", firstName: "New", lastName: "User" }) } };
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
      expect(body.created).toBe(1);
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
            }),
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
        body: JSON.stringify({ ids: ["admin1"], action: "set-role", role: "MEMBER" }),
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
          member: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
          familyGroupMember: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
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
        const tx = { member: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } };
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
        .mockResolvedValueOnce({
          id: "session-member",
          active: true,
          forcePasswordChange: false,
        } as any)
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
      vi.mocked(prisma.member.findUnique).mockResolvedValue({
        id: "m1", firstName: "Alice", lastName: "Smith", email: "alice@test.com",
        phone: "021-123", dateOfBirth: new Date("1990-01-15"),
        role: "MEMBER", ageTier: "ADULT", active: true, forcePasswordChange: false,
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

    it("returns member detail with the placeholder when cached Xero groups are not ready", async () => {
      mockedAuth.mockResolvedValue(adminSession);
      mockIsXeroConnected.mockResolvedValue(true);
      vi.mocked(prisma.member.findUnique).mockResolvedValue({
        id: "m1", firstName: "Alice", lastName: "Smith", email: "alice@test.com",
        phone: "021-123", dateOfBirth: new Date("1990-01-15"),
        role: "MEMBER", ageTier: "ADULT", active: true, forcePasswordChange: false,
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
          streetCity: "Tokoroa",
          streetRegion: "Waikato",
          streetPostalCode: "3420",
          streetCountry: "NZ",
          postalAddressLine1: "PO Box 10",
          postalCity: "Tokoroa",
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
      expect(createArgs.data.streetCity).toBe("Tokoroa");
      expect(createArgs.data.streetRegion).toBe("Waikato");
      expect(createArgs.data.streetPostalCode).toBe("3420");
      expect(createArgs.data.streetCountry).toBe("NZ");
      expect(createArgs.data.postalAddressLine1).toBe("PO Box 10");
      expect(createArgs.data.postalCity).toBe("Tokoroa");
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
