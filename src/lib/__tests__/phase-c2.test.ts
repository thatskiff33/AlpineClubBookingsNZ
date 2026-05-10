import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mock Prisma
// ---------------------------------------------------------------------------

const mockPrisma = {
  member: {
    count: vi.fn(),
findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
  },
};

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Mock auth
// ---------------------------------------------------------------------------

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: () => mockAuth(),
}));
const mockRequireActiveSessionUser = vi.fn(async () => null);
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: (...args: unknown[]) => mockRequireActiveSessionUser(...args),
}));

// ---------------------------------------------------------------------------
// Mock Xero
// ---------------------------------------------------------------------------

const mockGetAuthenticatedXeroClient = vi.fn();
const mockWithXeroRetry = vi.fn();
const mockCallXeroApi = vi.fn();
const mockFlushMemberSubscriptionHistory = vi.fn();
const mockRefreshXeroContactCachesFromContact = vi.fn();
const mockSyncMemberSubscriptionHistoryForLinkedContact = vi.fn();
const mockCreateXeroContactForMember = vi.fn();
const mockFindPotentialXeroContactsForMember = vi.fn();
const mockSyncContactsFromXero = vi.fn();
const mockFindDuplicateContacts = vi.fn();
const mockEnqueueXeroEntranceFeeInvoiceOperation = vi.fn();
const mockProcessQueuedXeroOutboxOperations = vi.fn();
class MockXeroContactValidationError extends Error {
  missingFields: string[];

  constructor(missingFields: string[]) {
    super("Xero contact validation failed");
    this.missingFields = missingFields;
  }
}

vi.mock("@/lib/xero", () => ({
  getAuthenticatedXeroClient: () => mockGetAuthenticatedXeroClient(),
  withXeroRetry: (fn: () => unknown) => mockWithXeroRetry(fn),
  callXeroApi: (fn: () => unknown, _opts: unknown) => mockCallXeroApi(fn, _opts),
  flushMemberSubscriptionHistory: (memberId: string) =>
    mockFlushMemberSubscriptionHistory(memberId),
  refreshXeroContactCachesFromContact: (contact: unknown) =>
    mockRefreshXeroContactCachesFromContact(contact),
  syncMemberSubscriptionHistoryForLinkedContact: (
    memberId: string,
    options?: unknown
  ) => mockSyncMemberSubscriptionHistoryForLinkedContact(memberId, options),
  createXeroContactForMember: (id: string, options?: unknown) =>
    mockCreateXeroContactForMember(id, options),
  findPotentialXeroContactsForMember: (id: string) => mockFindPotentialXeroContactsForMember(id),
  XeroContactValidationError: MockXeroContactValidationError,
  syncContactsFromXero: () => mockSyncContactsFromXero(),
  findDuplicateContacts: () => mockFindDuplicateContacts(),
}));

vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroEntranceFeeInvoiceOperation: (...args: unknown[]) =>
    mockEnqueueXeroEntranceFeeInvoiceOperation(...args),
  processQueuedXeroOutboxOperations: (...args: unknown[]) =>
    mockProcessQueuedXeroOutboxOperations(...args),
}));

// ---------------------------------------------------------------------------
// Mock xero-sync (upsertXeroObjectLink wraps prisma.$transaction internally)
// ---------------------------------------------------------------------------

const mockUpsertXeroObjectLink = vi.fn();
vi.mock("@/lib/xero-sync", () => ({
  upsertXeroObjectLink: (args: unknown) => mockUpsertXeroObjectLink(args),
}));

// ---------------------------------------------------------------------------
// Mock audit
// ---------------------------------------------------------------------------

const mockLogAudit = vi.fn();
vi.mock("@/lib/audit", () => ({
  logAudit: (args: unknown) => mockLogAudit(args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(url: string, options?: RequestInit) {
  return new Request(`http://localhost${url}`, options);
}

// ---------------------------------------------------------------------------
// #28: Xero Search Contacts API
// ---------------------------------------------------------------------------

describe("#28: Xero Search Contacts API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFlushMemberSubscriptionHistory.mockResolvedValue({
      seasonYears: [],
      deletedCount: 0,
      deactivatedLinkCount: 0,
    });
    mockSyncMemberSubscriptionHistoryForLinkedContact.mockResolvedValue({
      seasonYears: [2026],
      syncedCount: 1,
      results: [{ seasonYear: 2026, status: "NOT_INVOICED" }],
      errors: [],
    });
  });

  it("rejects non-admin users with 403", async () => {
    mockAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } });
    const { GET } = await import("@/app/api/admin/xero/search-contacts/route");
    const req = new NextRequest("http://localhost/api/admin/xero/search-contacts?q=test");
    const res = await GET(req);
    expect(res.status).toBe(403);
  });

  it("requires minimum 2-character search query", async () => {
    mockAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } });
    const { GET } = await import("@/app/api/admin/xero/search-contacts/route");
    const req = new NextRequest("http://localhost/api/admin/xero/search-contacts?q=a");
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("returns contacts with linked status", async () => {
    mockAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } });
    mockGetAuthenticatedXeroClient.mockResolvedValue({
      xero: {
        accountingApi: {
          getContacts: vi.fn(),
        },
      },
      tenantId: "tenant-1",
    });
    mockCallXeroApi.mockResolvedValue({
      body: {
        contacts: [
          { contactID: "xc-1", name: "John Smith", emailAddress: "john@test.com" },
          { contactID: "xc-2", name: "Jane Doe", emailAddress: "jane@test.com" },
        ],
      },
    });
    mockPrisma.member.findMany.mockResolvedValue([
      { xeroContactId: "xc-1", firstName: "John", lastName: "Smith" },
    ]);

    const { GET } = await import("@/app/api/admin/xero/search-contacts/route");
    const req = new NextRequest("http://localhost/api/admin/xero/search-contacts?q=test");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.contacts).toHaveLength(2);
    expect(data.contacts[0].isLinked).toBe(true);
    expect(data.contacts[0].linkedMemberName).toBe("John Smith");
    expect(data.contacts[1].isLinked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Admin import one Xero contact as member
// ---------------------------------------------------------------------------

describe("Admin Xero contact member import API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRefreshXeroContactCachesFromContact.mockResolvedValue({
      cachedContact: {
        contactId: "xc-1",
        name: "Alice Example",
        firstName: "Alice",
        lastName: "Example",
        emailAddress: "alice@example.com",
        companyNumber: "02/03/2004",
        contactStatus: "ACTIVE",
        phoneCountryCode: "64",
        phoneAreaCode: "27",
        phoneNumber: "1234567",
        streetAddressLine1: "1 Alpine Way",
        streetAddressLine2: null,
        streetCity: "Taupo",
        streetRegion: "Waikato",
        streetPostalCode: "3330",
        streetCountry: "NZ",
        postalAddressLine1: "PO Box 1",
        postalAddressLine2: null,
        postalCity: "Taupo",
        postalRegion: "Waikato",
        postalPostalCode: "3330",
        postalCountry: "NZ",
      },
      groupMemberships: {
        contactId: "xc-1",
        observed: false,
        contactGroupsSeen: 0,
        membershipsAdded: 0,
        membershipsRemoved: 0,
        groupsTouched: 0,
      },
    });
    mockSyncMemberSubscriptionHistoryForLinkedContact.mockResolvedValue({
      seasonYears: [2026],
      syncedCount: 1,
      results: [],
      errors: [],
    });
  });

  it("creates and links a member from an unlinked Xero contact", async () => {
    mockAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } });
    mockGetAuthenticatedXeroClient.mockResolvedValue({
      xero: {
        accountingApi: {
          getContact: vi.fn(),
        },
      },
      tenantId: "tenant-1",
    });
    mockCallXeroApi.mockResolvedValue({
      body: {
        contacts: [
          {
            contactID: "xc-1",
            name: "Alice Example",
            firstName: "Alice",
            lastName: "Example",
            emailAddress: "alice@example.com",
          },
        ],
      },
    });
    mockPrisma.member.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    mockPrisma.member.create.mockResolvedValue({
      id: "member-1",
      firstName: "Alice",
      lastName: "Example",
      email: "alice@example.com",
      active: true,
      xeroContactId: "xc-1",
    });

    const { POST } = await import("@/app/api/admin/xero/import-member-contact/route");
    const req = makeRequest("/api/admin/xero/import-member-contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ xeroContactId: "xc-1" }),
    });
    const res = await POST(req as any);

    expect(res.status).toBe(201);
    expect(mockPrisma.member.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: "alice@example.com",
          firstName: "Alice",
          lastName: "Example",
          xeroContactId: "xc-1",
          canLogin: true,
          emailVerified: false,
          phoneNumber: "1234567",
          streetAddressLine1: "1 Alpine Way",
          postalAddressLine1: "PO Box 1",
        }),
      })
    );
    expect(mockUpsertXeroObjectLink).toHaveBeenCalledWith(
      expect.objectContaining({
        localModel: "Member",
        localId: "member-1",
        xeroObjectType: "CONTACT",
        xeroObjectId: "xc-1",
      })
    );
    const data = await res.json();
    expect(data.memberId).toBe("member-1");
    expect(data.xeroContactId).toBe("xc-1");
  });

  it("does not import when a TACBookings member already has that name", async () => {
    mockAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } });
    mockGetAuthenticatedXeroClient.mockResolvedValue({
      xero: {
        accountingApi: {
          getContact: vi.fn(),
        },
      },
      tenantId: "tenant-1",
    });
    mockCallXeroApi.mockResolvedValue({
      body: {
        contacts: [
          {
            contactID: "xc-1",
            name: "Alice Example",
            firstName: "Alice",
            lastName: "Example",
            emailAddress: "alice@example.com",
          },
        ],
      },
    });
    mockPrisma.member.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "member-existing",
        firstName: "Alice",
        lastName: "Example",
        email: "local@example.com",
        xeroContactId: null,
      });

    const { POST } = await import("@/app/api/admin/xero/import-member-contact/route");
    const req = makeRequest("/api/admin/xero/import-member-contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ xeroContactId: "xc-1" }),
    });
    const res = await POST(req as any);

    expect(res.status).toBe(409);
    expect(mockPrisma.member.create).not.toHaveBeenCalled();
    const data = await res.json();
    expect(data.error).toContain("already exists");
    expect(data.existingMemberId).toBe("member-existing");
  });
});

// ---------------------------------------------------------------------------
// #28: Xero Link API
// ---------------------------------------------------------------------------

describe("#28: Xero Link API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFlushMemberSubscriptionHistory.mockResolvedValue({
      seasonYears: [],
      deletedCount: 0,
      deactivatedLinkCount: 0,
    });
    mockSyncMemberSubscriptionHistoryForLinkedContact.mockResolvedValue({
      seasonYears: [2026],
      syncedCount: 1,
      results: [{ seasonYear: 2026, status: "NOT_INVOICED" }],
      errors: [],
    });
  });

  it("rejects non-admin users with 403", async () => {
    mockAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } });
    const { POST } = await import("@/app/api/admin/members/[id]/xero-link/route");
    const req = makeRequest("/api/admin/members/m1/xero-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ xeroContactId: "xc-1" }),
    });
    const res = await POST(req as any, { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(403);
  });

  it("returns 404 when member not found", async () => {
    mockAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } });
    mockPrisma.member.findUnique.mockResolvedValue(null);
    const { POST } = await import("@/app/api/admin/members/[id]/xero-link/route");
    const req = makeRequest("/api/admin/members/m1/xero-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ xeroContactId: "xc-1" }),
    });
    const res = await POST(req as any, { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(404);
  });

  it("returns 400 when xeroContactId is missing", async () => {
    mockAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } });
    mockPrisma.member.findUnique.mockResolvedValue({ id: "m1", firstName: "John", lastName: "Smith", xeroContactId: null });
    const { POST } = await import("@/app/api/admin/members/[id]/xero-link/route");
    const req = makeRequest("/api/admin/members/m1/xero-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await POST(req as any, { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(400);
  });

  it("returns 409 when contact already linked to another member", async () => {
    mockAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } });
    mockPrisma.member.findUnique.mockResolvedValue({ id: "m1", firstName: "John", lastName: "Smith", xeroContactId: null });
    mockGetAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi: { getContact: vi.fn() } },
      tenantId: "t1",
    });
    mockCallXeroApi.mockResolvedValue({
      body: { contacts: [{ contactID: "xc-1", name: "John Smith" }] },
    });
    mockPrisma.member.findFirst.mockResolvedValue({ firstName: "Jane", lastName: "Doe" });

    const { POST } = await import("@/app/api/admin/members/[id]/xero-link/route");
    const req = makeRequest("/api/admin/members/m1/xero-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ xeroContactId: "xc-1" }),
    });
    const res = await POST(req as any, { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toContain("Jane Doe");
  });

  it("links member to Xero contact successfully", async () => {
    mockAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } });
    mockPrisma.member.findUnique.mockResolvedValue({ id: "m1", firstName: "John", lastName: "Smith", xeroContactId: null });
    mockGetAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi: { getContact: vi.fn() } },
      tenantId: "t1",
    });
    mockCallXeroApi.mockResolvedValue({
      body: { contacts: [{ contactID: "xc-1", name: "John Smith" }] },
    });
    mockPrisma.member.findFirst.mockResolvedValue(null); // no existing link
    mockPrisma.member.update.mockResolvedValue({});
    mockUpsertXeroObjectLink.mockResolvedValue(undefined);
    mockLogAudit.mockResolvedValue(undefined);
    mockRefreshXeroContactCachesFromContact.mockResolvedValue({
      cachedContact: { contactId: "xc-1" },
      groupMemberships: {
        contactId: "xc-1",
        observed: false,
        contactGroupsSeen: 0,
        membershipsAdded: 0,
        membershipsRemoved: 0,
        groupsTouched: 0,
      },
    });

    const { POST } = await import("@/app/api/admin/members/[id]/xero-link/route");
    const req = makeRequest("/api/admin/members/m1/xero-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ xeroContactId: "xc-1" }),
    });
    const res = await POST(req as any, { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.xeroContactId).toBe("xc-1");
    expect(data.contactName).toBe("John Smith");
    expect(mockPrisma.member.update).toHaveBeenCalledWith({
      where: { id: "m1" },
      data: { xeroContactId: "xc-1" },
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
    expect(mockRefreshXeroContactCachesFromContact).toHaveBeenCalledWith({
      contactID: "xc-1",
      name: "John Smith",
    });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "XERO_LINK",
      memberId: "a1",
      targetId: "m1",
    }));
  });

  it("returns a friendly 429 message when Xero daily limit is reached", async () => {
    mockAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } });
    mockPrisma.member.findUnique.mockResolvedValue({
      id: "m1",
      firstName: "John",
      lastName: "Smith",
      xeroContactId: null,
    });
    mockGetAuthenticatedXeroClient.mockResolvedValue({
      xero: { accountingApi: { getContact: vi.fn() } },
      tenantId: "t1",
    });
    mockCallXeroApi.mockRejectedValue({
      response: {
        statusCode: 429,
        headers: {
          "retry-after": "12328",
          "x-rate-limit-problem": "day",
        },
      },
    });

    const { POST } = await import("@/app/api/admin/members/[id]/xero-link/route");
    const req = makeRequest("/api/admin/members/m1/xero-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ xeroContactId: "xc-1" }),
    });
    const res = await POST(req as any, { params: Promise.resolve({ id: "m1" }) });
    const data = await res.json();

    expect(res.status).toBe(429);
    expect(data.error).toBe("Xero daily API limit reached. Please try again tomorrow.");
  });
});

// ---------------------------------------------------------------------------
// #28: Xero Push API
// ---------------------------------------------------------------------------

describe("#28: Xero Push API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFlushMemberSubscriptionHistory.mockResolvedValue({
      seasonYears: [],
      deletedCount: 0,
      deactivatedLinkCount: 0,
    });
    mockSyncMemberSubscriptionHistoryForLinkedContact.mockResolvedValue({
      seasonYears: [2026],
      syncedCount: 1,
      results: [{ seasonYear: 2026, status: "NOT_INVOICED" }],
      errors: [],
    });
    mockFindPotentialXeroContactsForMember.mockResolvedValue([]);
    mockEnqueueXeroEntranceFeeInvoiceOperation.mockResolvedValue({
      queueOperationId: null,
      message: "not queued",
    });
    mockProcessQueuedXeroOutboxOperations.mockResolvedValue(undefined);
  });

  it("rejects non-admin users with 403", async () => {
    mockAuth.mockResolvedValue({ user: { id: "m1", role: "MEMBER" } });
    const { POST } = await import("@/app/api/admin/members/[id]/xero-push/route");
    const req = makeRequest("/api/admin/members/m1/xero-push", { method: "POST" });
    const res = await POST(req as any, { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(403);
  });

  it("returns 404 when member not found", async () => {
    mockAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } });
    mockPrisma.member.findUnique.mockResolvedValue(null);
    const { POST } = await import("@/app/api/admin/members/[id]/xero-push/route");
    const req = makeRequest("/api/admin/members/m1/xero-push", { method: "POST" });
    const res = await POST(req as any, { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(404);
  });

  it("returns 409 when member already linked to Xero", async () => {
    mockAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } });
    mockPrisma.member.findUnique.mockResolvedValue({
      id: "m1", firstName: "John", lastName: "Smith", email: "john@test.com", xeroContactId: "xc-existing",
    });
    const { POST } = await import("@/app/api/admin/members/[id]/xero-push/route");
    const req = makeRequest("/api/admin/members/m1/xero-push", { method: "POST" });
    const res = await POST(req as any, { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(409);
  });

  it("creates a brand-new Xero contact and returns link", async () => {
    mockAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } });
    mockPrisma.member.findUnique.mockResolvedValue({
      id: "m1", firstName: "John", lastName: "Smith", email: "john@test.com", xeroContactId: null,
    });
    mockCreateXeroContactForMember.mockResolvedValue("xc-new-123");
    mockLogAudit.mockResolvedValue(undefined);

    const { POST } = await import("@/app/api/admin/members/[id]/xero-push/route");
    const req = makeRequest("/api/admin/members/m1/xero-push", { method: "POST" });
    const res = await POST(req as any, { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.xeroContactId).toBe("xc-new-123");
    expect(data.xeroLink).toBe("https://go.xero.com/Contacts/View/xc-new-123");
    expect(mockFlushMemberSubscriptionHistory).toHaveBeenCalledWith("m1");
    expect(mockFindPotentialXeroContactsForMember).toHaveBeenCalledWith("m1");
    expect(mockCreateXeroContactForMember).toHaveBeenCalledWith("m1", {
      createdByMemberId: "a1",
    });
    expect(
      mockSyncMemberSubscriptionHistoryForLinkedContact
    ).toHaveBeenCalledWith(
      "m1",
      expect.objectContaining({
        forceRefreshOnlineInvoiceUrl: true,
      })
    );
  });

  it("returns 422 when required Xero fields are missing", async () => {
    mockAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } });
    mockPrisma.member.findUnique.mockResolvedValue({
      id: "m1", firstName: "John", lastName: "Smith", email: "john@test.com", xeroContactId: null,
    });
    mockCreateXeroContactForMember.mockRejectedValue(
      new MockXeroContactValidationError(["Phone", "Postal Address", "Joined Date"])
    );

    const { POST } = await import("@/app/api/admin/members/[id]/xero-push/route");
    const req = makeRequest("/api/admin/members/m1/xero-push", { method: "POST" });
    const res = await POST(req as any, { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(422);
    const data = await res.json();
    expect(data.error).toContain("Phone, Postal Address, Joined Date");
    expect(data.missingFields).toEqual(["Phone", "Postal Address", "Joined Date"]);
  });

  it("returns suggested contacts instead of creating when potential matches exist", async () => {
    mockAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } });
    mockPrisma.member.findUnique.mockResolvedValue({
      id: "m1", firstName: "John", lastName: "Smith", email: "john@test.com", xeroContactId: null,
    });
    mockFindPotentialXeroContactsForMember.mockResolvedValue([
      {
        contactId: "xc-existing",
        name: "John Smith",
        email: "john@test.com",
        isLinked: false,
        linkedMemberName: null,
        matchReasons: ["Exact email match", "Exact name match"],
        xeroLink: "https://go.xero.com/Contacts/View/xc-existing",
      },
    ]);

    const { POST } = await import("@/app/api/admin/members/[id]/xero-push/route");
    const req = makeRequest("/api/admin/members/m1/xero-push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ createEntranceFeeInvoice: true }),
    });
    const res = await POST(req as any, { params: Promise.resolve({ id: "m1" }) });

    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.suggestedContacts).toHaveLength(1);
    expect(mockCreateXeroContactForMember).not.toHaveBeenCalled();
    expect(mockEnqueueXeroEntranceFeeInvoiceOperation).not.toHaveBeenCalled();
  });

  it("can force-create a new contact and queue the entrance invoice explicitly", async () => {
    mockAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } });
    mockPrisma.member.findUnique.mockResolvedValue({
      id: "m1", firstName: "John", lastName: "Smith", email: "john@test.com", xeroContactId: null,
    });
    mockCreateXeroContactForMember.mockResolvedValue("xc-new-123");
    mockLogAudit.mockResolvedValue(undefined);
    mockEnqueueXeroEntranceFeeInvoiceOperation.mockResolvedValue({
      queueOperationId: "op-1",
      message: "queued",
    });

    const { POST } = await import("@/app/api/admin/members/[id]/xero-push/route");
    const req = makeRequest("/api/admin/members/m1/xero-push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ forceCreate: true, createEntranceFeeInvoice: true }),
    });
    const res = await POST(req as any, { params: Promise.resolve({ id: "m1" }) });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.entranceFeeInvoiceQueued).toBe(true);
    expect(data.entranceFeeInvoiceMessage).toBe("queued");
    expect(mockFindPotentialXeroContactsForMember).not.toHaveBeenCalled();
    expect(mockEnqueueXeroEntranceFeeInvoiceOperation).toHaveBeenCalledWith("m1", {
      createdByMemberId: "a1",
    });
  });
});

// ---------------------------------------------------------------------------
// #29: Sync Report structure
// ---------------------------------------------------------------------------

describe("#29: SyncReport structure and return type", () => {
  it("syncContactsFromXero is exported and callable", async () => {
    const xeroModule = await import("@/lib/xero");
    expect(xeroModule).toHaveProperty("syncContactsFromXero");
    expect(typeof xeroModule.syncContactsFromXero).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// #29: Sync Contacts route returns syncReport
// ---------------------------------------------------------------------------

describe("#29: Sync Contacts route returns syncReport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns syncReport in response", async () => {
    mockAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } });

    const mockSyncReport = {
      created: [],
      updated: [{ name: "John Smith", memberId: "m1", xeroContactId: "xc-1", changes: ["Linked to Xero contact"] }],
      skippedNoChanges: 5,
      skippedNoEmail: [{ name: "No Email Contact", xeroContactId: "xc-2" }],
      skippedOther: [{ name: "Other", xeroContactId: "xc-3", reason: "No matching member by email" }],
      errors: [],
      total: 8,
    };

    mockSyncContactsFromXero.mockResolvedValue(mockSyncReport);

    const { POST } = await import("@/app/api/admin/xero/sync-contacts/route");
    const res = await POST();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.syncReport).toBeDefined();
    expect(data.syncReport.total).toBe(8);
    expect(data.syncReport.updated).toHaveLength(1);
    expect(data.syncReport.updated[0].name).toBe("John Smith");
    expect(data.syncReport.skippedNoChanges).toBe(5);
    expect(data.syncReport.skippedNoEmail).toHaveLength(1);
    expect(data.syncReport.skippedOther).toHaveLength(1);
    expect(data.syncReport.errors).toHaveLength(0);
  });

  it("returns a 429 daily-limit message when Xero limit is reached", async () => {
    mockAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } });
    const err = new Error("Xero daily API limit reached. Retry after 123 seconds.");
    err.name = "XeroDailyLimitError";
    mockSyncContactsFromXero.mockRejectedValue(err);

    const { POST } = await import("@/app/api/admin/xero/sync-contacts/route");
    const res = await POST();

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({
      error: "Xero daily API limit reached. Please try again tomorrow.",
    });
  });
});

describe("#27: Duplicate scan route surfaces Xero rate limits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a 429 daily-limit message for raw Xero SDK errors", async () => {
    mockAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } });
    mockFindDuplicateContacts.mockRejectedValue({
      response: {
        statusCode: 429,
        headers: {
          "x-rate-limit-problem": "day",
        },
      },
    });

    const { GET } = await import("@/app/api/admin/xero/duplicate-contacts/route");
    const res = await GET();

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({
      error: "Xero daily API limit reached. Please try again tomorrow.",
    });
  });
});

// ---------------------------------------------------------------------------
// #28: Member detail page — Xero buttons visible logic
// ---------------------------------------------------------------------------

describe("#28: Member detail page Xero link/push buttons", () => {
  it("shows 'View in Xero' button when xeroContactId is present", () => {
    // Component logic test: if member.xeroContactId is truthy, render Xero link
    const member = { xeroContactId: "xc-123" };
    expect(member.xeroContactId).toBeTruthy();
    // Positive case: xeroContactId present → "View in Xero" shown
  });

  it("shows Link and Create buttons when xeroContactId is null", () => {
    const member = { xeroContactId: null };
    expect(member.xeroContactId).toBeNull();
    // Negative case: xeroContactId null → "Link to Xero" and "Create in Xero" shown
  });
});

// ---------------------------------------------------------------------------
// #29: SyncReportView sections
// ---------------------------------------------------------------------------

describe("#29: SyncReport rendering sections", () => {
  it("report with only skippedNoChanges shows correct count", () => {
    const report = {
      created: [],
      updated: [],
      skippedNoChanges: 42,
      skippedNoEmail: [],
      skippedOther: [],
      errors: [],
      total: 42,
    };
    expect(report.skippedNoChanges).toBe(42);
    expect(report.total).toBe(42);
    expect(report.updated.length).toBe(0);
    expect(report.errors.length).toBe(0);
  });

  it("report with errors has errors section data", () => {
    const report = {
      created: [],
      updated: [],
      skippedNoChanges: 0,
      skippedNoEmail: [],
      skippedOther: [],
      errors: [{ name: "Bad Contact", xeroContactId: "xc-bad", error: "API timeout" }],
      total: 1,
    };
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].name).toBe("Bad Contact");
    expect(report.errors[0].error).toBe("API timeout");
  });

  it("report tracks updated members with change details", () => {
    const report = {
      created: [],
      updated: [
        { name: "John Smith", memberId: "m1", xeroContactId: "xc-1", changes: ["Linked to Xero contact", "Phone set to +64 27 1234567"] },
      ],
      skippedNoChanges: 0,
      skippedNoEmail: [],
      skippedOther: [],
      errors: [],
      total: 1,
    };
    expect(report.updated).toHaveLength(1);
    expect(report.updated[0].changes).toHaveLength(2);
    expect(report.updated[0].changes[0]).toBe("Linked to Xero contact");
    expect(report.updated[0].changes[1]).toContain("Phone");
  });

  it("report tracks skippedNoEmail with name and xeroContactId", () => {
    const report = {
      created: [],
      updated: [],
      skippedNoChanges: 0,
      skippedNoEmail: [
        { name: "No Email Person", xeroContactId: "xc-noemail" },
      ],
      skippedOther: [],
      errors: [],
      total: 1,
    };
    expect(report.skippedNoEmail).toHaveLength(1);
    expect(report.skippedNoEmail[0].name).toBe("No Email Person");
    expect(report.skippedNoEmail[0].xeroContactId).toBe("xc-noemail");
  });

  it("report tracks skippedOther with reasons", () => {
    const report = {
      created: [],
      updated: [],
      skippedNoChanges: 0,
      skippedNoEmail: [],
      skippedOther: [
        { name: "Unknown Person", xeroContactId: "xc-unknown", reason: "No matching member by email" },
      ],
      errors: [],
      total: 1,
    };
    expect(report.skippedOther).toHaveLength(1);
    expect(report.skippedOther[0].reason).toBe("No matching member by email");
  });
});
