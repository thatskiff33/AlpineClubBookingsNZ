import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock Prisma
// ---------------------------------------------------------------------------

const mockPrisma = {
  payment: {
    findMany: vi.fn(),
    count: vi.fn(),
    aggregate: vi.fn(),
    update: vi.fn(),
  },
  memberSubscription: {
    findMany: vi.fn(),
    count: vi.fn(),
    groupBy: vi.fn(),
    findFirst: vi.fn(),
  },
  booking: {
    findFirst: vi.fn(),
  },
  member: {
    count: vi.fn(),
findUnique: vi.fn(),
  },
};

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
const {
  mockGetXeroContactGroupMemberships,
  mockGetXeroContactIdsForGroup,
  mockRequireActiveSessionUser,
} = vi.hoisted(() => ({
  mockGetXeroContactGroupMemberships: vi
    .fn<
      (contactIds: string[]) => Promise<Record<string, Array<{ id: string; name: string }>>>
    >()
    .mockResolvedValue({}),
  mockGetXeroContactIdsForGroup: vi
    .fn<(groupId: string) => Promise<string[]>>()
    .mockResolvedValue([]),
  mockRequireActiveSessionUser: vi
    .fn<(memberId: string) => Promise<Response | null>>()
    .mockResolvedValue(null),
}));
vi.mock("@/lib/xero", () => ({
  getXeroContactGroupMemberships: mockGetXeroContactGroupMemberships,
  getXeroContactIdsForGroup: mockGetXeroContactIdsForGroup,
}));

// ---------------------------------------------------------------------------
// Mock auth
// ---------------------------------------------------------------------------

const mockAuth = vi.fn();
vi.mock("@/lib/auth", () => ({
  auth: () => mockAuth(),
}));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mockRequireActiveSessionUser,
}));

// ---------------------------------------------------------------------------
// #26: Admin Payments API
// ---------------------------------------------------------------------------

describe("#26: Admin Payments API includes booking ID and Xero invoice number", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET returns payment data with booking.id field", async () => {
    mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    mockPrisma.payment.findMany
      .mockResolvedValueOnce([
        {
          id: "pay-1",
          bookingId: "book-1",
          amountCents: 5000,
          status: "SUCCEEDED",
          stripePaymentIntentId: "pi_test_123",
          xeroInvoiceId: "xero-inv-1",
          xeroInvoiceNumber: "INV-0001",
          refundedAmountCents: 0,
          updatedAt: new Date("2026-04-01T00:00:00.000Z"),
          transactions: [],
          refunds: [],
          booking: {
            id: "book-1",
            status: "PAID",
            checkIn: new Date("2026-04-10"),
            creditsFromCancellation: [],
            member: {
              id: "member-1",
              firstName: "John",
              lastName: "Doe",
              email: "john@test.com",
            },
          },
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "pay-1",
          bookingId: "book-1",
          amountCents: 5000,
          status: "SUCCEEDED",
          stripePaymentIntentId: "pi_test_123",
          xeroInvoiceId: "xero-inv-1",
          xeroInvoiceNumber: "INV-0001",
          refundedAmountCents: 0,
          createdAt: new Date("2026-04-01T00:00:00.000Z"),
          updatedAt: new Date("2026-04-01T00:00:00.000Z"),
          booking: {
            id: "book-1",
            status: "PAID",
            checkIn: new Date("2026-04-10"),
            checkOut: new Date("2026-04-12"),
            creditsFromCancellation: [],
            member: {
              id: "member-1",
              firstName: "John",
              lastName: "Doe",
              email: "john@test.com",
            },
          },
        },
      ]);

    const { GET } = await import("@/app/api/admin/payments/route");
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/admin/payments?status=all");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].booking.id).toBe("book-1");
    expect(body.data[0].xeroInvoiceNumber).toBe("INV-0001");
  });

  it("returns 403 for non-admin", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", role: "MEMBER" } });

    const { GET } = await import("@/app/api/admin/payments/route");
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/admin/payments");
    const res = await GET(req);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// #26: Payment Page UI (file content checks)
// ---------------------------------------------------------------------------

describe("#26: Payments Page has clickable links", () => {
  it("includes Xero invoice link markup", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const content = fs.readFileSync(
      path.resolve("src/app/(admin)/admin/payments/page.tsx"),
      "utf-8"
    );
    // Should have Xero link
    expect(content).toContain("go.xero.com/AccountsReceivable");
    expect(content).toContain("xeroInvoiceNumber");
    // Should have Stripe dashboard link
    expect(content).toContain("dashboard.stripe.com");
    // Should have booking detail link
    expect(content).toContain("/bookings/");
    // Should have ExternalLink icon
    expect(content).toContain("ExternalLink");
  });
});

// ---------------------------------------------------------------------------
// #27: Xero Account Mappings Lock/Edit Mode
// ---------------------------------------------------------------------------

describe("#27: Xero Account Mappings lock/edit mode", () => {
  it("page has edit mode toggle state and UI elements", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const content = fs.readFileSync(
      path.resolve("src/app/(admin)/admin/xero/page.tsx"),
      "utf-8"
    );
    // Should have isEditingMappings state
    expect(content).toContain("isEditingMappings");
    // Should have Edit button
    expect(content).toContain("Edit Mappings");
    // Should have Save and Cancel in edit mode
    expect(content).toContain("Save Changes");
    expect(content).toContain("Cancel");
    // Should have savedMappings for revert
    expect(content).toContain("savedMappings");
    // Locked state should show read-only values
    expect(content).toContain("bg-slate-50");
  });
});

// ---------------------------------------------------------------------------
// #27: Scan for Duplicates wording
// ---------------------------------------------------------------------------

describe("#27: Scan for Duplicates wording update", () => {
  it("references Family Groups in scan section", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const content = fs.readFileSync(
      path.resolve("src/app/(admin)/admin/xero/page.tsx"),
      "utf-8"
    );
    expect(content).toContain("Duplicates & Family Groups");
    expect(content).toContain("Scan for Duplicates & Family Groups");
    expect(content).toContain("Family Group");
  });
});

describe("#27: Xero import supports INFANT tier mapping", () => {
  it("includes an Infant option in the group import age-tier selector", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const content = fs.readFileSync(
      path.resolve("src/app/(admin)/admin/xero/page.tsx"),
      "utf-8"
    );
    expect(content).toContain('<SelectItem value="INFANT">Infant</SelectItem>');
  });
});

describe("#27: Xero contact sync admin action", () => {
  it("runs the broad contact sync as a full resync", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const content = fs.readFileSync(
      path.resolve("src/app/(admin)/admin/xero/page.tsx"),
      "utf-8"
    );

    expect(content).toContain('fetch("/api/admin/xero/sync-contacts", {');
    expect(content).toContain('body: JSON.stringify({ fullResync: true })');
  });
});

// ---------------------------------------------------------------------------
// #32: Admin Subscriptions API
// ---------------------------------------------------------------------------

describe("#32: Admin Subscriptions API includes Xero invoice number", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetXeroContactGroupMemberships.mockResolvedValue({});
    mockGetXeroContactIdsForGroup.mockResolvedValue([]);
  });

  it("GET returns subscription data (Prisma includes xeroInvoiceNumber by default)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } });
    mockGetXeroContactGroupMemberships.mockResolvedValue({
      "xc-1": [{ id: "cg-1", name: "Adult Members" }],
    });
    mockPrisma.memberSubscription.findMany.mockResolvedValue([
      {
        id: "sub-1",
        memberId: "m1",
        seasonYear: 2026,
        status: "PAID",
        xeroInvoiceId: "xero-123",
        xeroInvoiceNumber: "INV-0042",
        paidAt: new Date(),
        member: {
          firstName: "Alice",
          lastName: "Smith",
          email: "alice@test.com",
          ageTier: "ADULT",
          xeroContactId: "xc-1",
        },
      },
    ]);
    mockPrisma.memberSubscription.count.mockResolvedValue(1);
    mockPrisma.memberSubscription.groupBy.mockResolvedValue([
      { status: "PAID", _count: 1 },
    ]);

    const { GET } = await import("@/app/api/admin/subscriptions/route");
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://localhost/api/admin/subscriptions?seasonYear=2026&status=all");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].xeroInvoiceNumber).toBe("INV-0042");
    expect(body.data[0].xeroInvoiceId).toBe("xero-123");
    expect(body.data[0].xeroContactGroups).toEqual([
      { id: "cg-1", name: "Adult Members" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// #32: Subscriptions Page UI
// ---------------------------------------------------------------------------

describe("#32: Subscriptions Page has Xero invoice link", () => {
  it("includes Xero link markup, invoice number field, and age/group filters", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const content = fs.readFileSync(
      path.resolve("src/app/(admin)/admin/subscriptions/page.tsx"),
      "utf-8"
    );
    expect(content).toContain("go.xero.com/AccountsReceivable");
    expect(content).toContain("xeroInvoiceNumber");
    expect(content).toContain("Age Group");
    expect(content).toContain("Xero Contact Group");
    expect(content).toContain("useAgeTierOptions");
    expect(content).toContain("ExternalLink");
  });
});

// ---------------------------------------------------------------------------
// #32: Booking creation returns invoice URL on subscription error
// ---------------------------------------------------------------------------

describe("#32: Booking subscription error includes invoice URL", () => {
  it("booking route returns invoiceUrl and code when subscription not paid", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const content = fs.readFileSync(
      path.resolve("src/app/api/bookings/route.ts"),
      "utf-8"
    );
    // Should include SUBSCRIPTION_REQUIRED code
    expect(content).toContain("SUBSCRIPTION_REQUIRED");
    // Should include invoiceUrl in response
    expect(content).toContain("invoiceUrl");
    // Should include invoiceNumber in response
    expect(content).toContain("invoiceNumber");
    // Should query xeroOnlineInvoiceUrl
    expect(content).toContain("xeroOnlineInvoiceUrl");
  });
});

// ---------------------------------------------------------------------------
// #32: Booking wizard shows payment link
// ---------------------------------------------------------------------------

describe("#32: Booking wizard shows subscription payment link", () => {
  it("handles SUBSCRIPTION_REQUIRED error with invoice URL", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const content = fs.readFileSync(
      path.resolve("src/app/(authenticated)/book/page.tsx"),
      "utf-8"
    );
    expect(content).toContain("subscriptionInvoiceUrl");
    // SUBSCRIPTION_REQUIRED is handled via getBookingErrorPaymentTargets (imported helper)
    expect(content).toContain("getBookingErrorPaymentTargets");
    expect(content).toContain("Pay Your Subscription");
  });
});

// ---------------------------------------------------------------------------
// #26: Xero invoice number saved during invoice creation
// ---------------------------------------------------------------------------

describe("#26: Xero invoice number stored during creation", () => {
  it("xero.ts saves invoiceNumber when creating booking invoice", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const content = fs.readFileSync(
      path.resolve("src/lib/xero.ts"),
      "utf-8"
    );
    // Should save xeroInvoiceNumber in payment update
    expect(content).toContain("xeroInvoiceNumber: createdInvoice.invoiceNumber");
  });
});

// ---------------------------------------------------------------------------
// #32: Xero stores subscription invoice number and online URL
// ---------------------------------------------------------------------------

describe("#32: Xero subscription sync stores invoice number and online URL", () => {
  it("xero.ts saves invoiceNumber and onlineInvoiceUrl for subscriptions", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const content = fs.readFileSync(
      path.resolve("src/lib/xero.ts"),
      "utf-8"
    );
    // Should save xeroInvoiceNumber in subscription upsert (via matchedInvoiceNumber intermediate var)
    expect(content).toContain("matchedInvoiceNumber = subscriptionInvoice.invoiceNumber");
    // Should fetch online invoice URL
    expect(content).toContain("getOnlineInvoice");
    expect(content).toContain("xeroOnlineInvoiceUrl");
  });
});

// ---------------------------------------------------------------------------
// Schema changes
// ---------------------------------------------------------------------------

describe("Schema changes for Phase C1", () => {
  it("Payment model has xeroInvoiceNumber field", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const schema = fs.readFileSync(path.resolve("prisma/schema.prisma"), "utf-8");
    // Payment should have xeroInvoiceNumber
    const paymentSection = schema.substring(
      schema.indexOf("model Payment"),
      schema.indexOf("}", schema.indexOf("model Payment")) + 1
    );
    expect(paymentSection).toContain("xeroInvoiceNumber");
  });

  it("MemberSubscription model has xeroInvoiceNumber and xeroOnlineInvoiceUrl fields", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const schema = fs.readFileSync(path.resolve("prisma/schema.prisma"), "utf-8");
    const subSection = schema.substring(
      schema.indexOf("model MemberSubscription"),
      schema.indexOf("}", schema.indexOf("model MemberSubscription")) + 1
    );
    expect(subSection).toContain("xeroInvoiceNumber");
    expect(subSection).toContain("xeroOnlineInvoiceUrl");
  });
});
