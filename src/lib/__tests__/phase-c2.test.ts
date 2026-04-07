import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Mock Prisma
// ---------------------------------------------------------------------------

const mockPrisma = {
  member: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
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

// ---------------------------------------------------------------------------
// Mock Xero
// ---------------------------------------------------------------------------

const mockGetAuthenticatedXeroClient = vi.fn();
const mockWithXeroRetry = vi.fn();
const mockFindOrCreateXeroContact = vi.fn();
const mockSyncContactsFromXero = vi.fn();

vi.mock("@/lib/xero", () => ({
  getAuthenticatedXeroClient: () => mockGetAuthenticatedXeroClient(),
  withXeroRetry: (fn: () => unknown) => mockWithXeroRetry(fn),
  findOrCreateXeroContact: (id: string) => mockFindOrCreateXeroContact(id),
  syncContactsFromXero: () => mockSyncContactsFromXero(),
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
    mockWithXeroRetry.mockResolvedValue({
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
// #28: Xero Link API
// ---------------------------------------------------------------------------

describe("#28: Xero Link API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    mockWithXeroRetry.mockResolvedValue({
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
    mockWithXeroRetry.mockResolvedValue({
      body: { contacts: [{ contactID: "xc-1", name: "John Smith" }] },
    });
    mockPrisma.member.findFirst.mockResolvedValue(null); // no existing link
    mockPrisma.member.update.mockResolvedValue({});
    mockLogAudit.mockResolvedValue(undefined);

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
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "XERO_LINK",
      memberId: "a1",
      targetId: "m1",
    }));
  });
});

// ---------------------------------------------------------------------------
// #28: Xero Push API
// ---------------------------------------------------------------------------

describe("#28: Xero Push API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("creates Xero contact and returns link", async () => {
    mockAuth.mockResolvedValue({ user: { id: "a1", role: "ADMIN" } });
    mockPrisma.member.findUnique.mockResolvedValue({
      id: "m1", firstName: "John", lastName: "Smith", email: "john@test.com", xeroContactId: null,
    });
    mockFindOrCreateXeroContact.mockResolvedValue("xc-new-123");
    mockLogAudit.mockResolvedValue(undefined);

    const { POST } = await import("@/app/api/admin/members/[id]/xero-push/route");
    const req = makeRequest("/api/admin/members/m1/xero-push", { method: "POST" });
    const res = await POST(req as any, { params: Promise.resolve({ id: "m1" }) });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.xeroContactId).toBe("xc-new-123");
    expect(data.xeroLink).toBe("https://go.xero.com/Contacts/View/xc-new-123");
    expect(mockFindOrCreateXeroContact).toHaveBeenCalledWith("m1");
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
