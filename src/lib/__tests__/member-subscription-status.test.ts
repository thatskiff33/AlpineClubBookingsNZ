import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
const mockRequireActiveSessionUser = vi.fn(async () => null);
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: (...args: unknown[]) => mockRequireActiveSessionUser(...args),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findUnique: vi.fn(),
    },
  },
}));

// The subscription gate consults the effective module flags (Xero-off
// bypass). Default to Xero on; individual tests flip it off.
const mockLoadEffectiveModuleFlags = vi.fn();
vi.mock("@/lib/module-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/module-settings")>();
  return {
    ...actual,
    loadEffectiveModuleFlags: (...args: unknown[]) =>
      mockLoadEffectiveModuleFlags(...args),
  };
});

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { GET } from "@/app/api/member/subscription-status/route";

const mockAuth = auth as ReturnType<typeof vi.fn>;
const mockFindUnique = prisma.member.findUnique as ReturnType<typeof vi.fn>;

describe("GET /api/member/subscription-status", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-09T12:00:00Z"));
    vi.clearAllMocks();
    mockFindUnique.mockResolvedValue({
      role: "MEMBER",
      ageTier: "ADULT",
      subscriptions: [],
    });
    mockLoadEffectiveModuleFlags.mockResolvedValue({
      kiosk: true,
      chores: true,
      financeDashboard: true,
      waitlist: true,
      xeroIntegration: true,
      bedAllocation: true,
      internetBankingPayments: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns invoice metadata for the current season", async () => {
    mockAuth.mockResolvedValue({ user: { id: "member-1" } });
    mockFindUnique.mockResolvedValue({
      role: "MEMBER",
      ageTier: "ADULT",
      subscriptions: [{
        status: "UNPAID",
        xeroInvoiceId: "inv-1",
        xeroInvoiceNumber: "INV-0042",
        xeroOnlineInvoiceUrl: "https://pay.xero.com/invoice/inv-1",
      }],
    });

    const res = await GET();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({
      status: "UNPAID",
      seasonDisplay: "2026/2027",
      invoiceUrl: "https://pay.xero.com/invoice/inv-1",
      invoiceNumber: "INV-0042",
    });
    expect(mockFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "member-1" },
        select: expect.objectContaining({
          role: true,
          ageTier: true,
          subscriptions: expect.objectContaining({
            where: { seasonYear: 2026 },
            select: expect.objectContaining({
              status: true,
              xeroInvoiceId: true,
              xeroInvoiceNumber: true,
              xeroOnlineInvoiceUrl: true,
            }),
          }),
        }),
      })
    );
  });

  it("keeps member subscription reads local even when the invoice URL is missing", async () => {
    mockAuth.mockResolvedValue({ user: { id: "member-1" } });
    mockFindUnique.mockResolvedValue({
      role: "MEMBER",
      ageTier: "ADULT",
      subscriptions: [{
        status: "UNPAID",
        xeroInvoiceId: "inv-1",
        xeroInvoiceNumber: "INV-0042",
        xeroOnlineInvoiceUrl: null,
      }],
    });

    const res = await GET();
    const body = await res.json();

    expect(mockFindUnique).toHaveBeenCalledTimes(1);
    expect(body.invoiceUrl).toBeNull();
  });

  it("returns not required for members whose age tier does not require subscriptions", async () => {
    mockAuth.mockResolvedValue({ user: { id: "member-1" } });
    mockFindUnique.mockResolvedValue({
      role: "MEMBER",
      ageTier: "CHILD",
      subscriptions: [],
    });

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("NOT_REQUIRED");
    expect(body.invoiceUrl).toBeNull();
  });

  it("returns not required when the Xero module is effectively off", async () => {
    mockAuth.mockResolvedValue({ user: { id: "member-1" } });
    // Subscriptions are invoiced through Xero; with the module off the
    // status endpoint must not report an outstanding subscription.
    mockLoadEffectiveModuleFlags.mockResolvedValue({
      kiosk: true,
      chores: true,
      financeDashboard: true,
      waitlist: true,
      xeroIntegration: false,
      bedAllocation: true,
      internetBankingPayments: false,
    });
    mockFindUnique.mockResolvedValue({
      role: "MEMBER",
      ageTier: "ADULT",
      subscriptions: [{
        status: "UNPAID",
        xeroInvoiceId: "inv-1",
        xeroInvoiceNumber: "INV-0042",
        xeroOnlineInvoiceUrl: "https://pay.xero.com/invoice/inv-1",
      }],
    });

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("NOT_REQUIRED");
    expect(body.invoiceUrl).toBeNull();
    expect(body.invoiceNumber).toBeNull();
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(401);
    expect(mockFindUnique).not.toHaveBeenCalled();
  });
});
