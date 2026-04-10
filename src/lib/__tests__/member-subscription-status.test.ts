import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { count: vi.fn() },
    memberSubscription: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock("@/lib/xero", () => ({
  checkMembershipStatus: vi.fn(),
  isXeroConnected: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { checkMembershipStatus, isXeroConnected } from "@/lib/xero";
import { GET } from "@/app/api/member/subscription-status/route";

const mockAuth = auth as ReturnType<typeof vi.fn>;
const mockFindFirst = prisma.memberSubscription.findFirst as ReturnType<typeof vi.fn>;
const mockCheckMembershipStatus = checkMembershipStatus as ReturnType<typeof vi.fn>;
const mockIsXeroConnected = isXeroConnected as ReturnType<typeof vi.fn>;

describe("GET /api/member/subscription-status", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-09T12:00:00Z"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns invoice metadata for the current season", async () => {
    mockAuth.mockResolvedValue({ user: { id: "member-1" } });
    mockFindFirst.mockResolvedValue({
      status: "UNPAID",
      xeroInvoiceId: "inv-1",
      xeroInvoiceNumber: "INV-0042",
      xeroOnlineInvoiceUrl: "https://pay.xero.com/invoice/inv-1",
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
    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { memberId: "member-1", seasonYear: 2026 },
        select: expect.objectContaining({
          status: true,
          xeroInvoiceId: true,
          xeroInvoiceNumber: true,
          xeroOnlineInvoiceUrl: true,
        }),
      })
    );
  });

  it("refreshes from Xero when the stored invoice URL is missing", async () => {
    mockAuth.mockResolvedValue({ user: { id: "member-1" } });
    mockIsXeroConnected.mockResolvedValue(true);
    mockCheckMembershipStatus.mockResolvedValue({
      status: "UNPAID",
      xeroInvoiceId: "inv-1",
    });
    mockFindFirst
      .mockResolvedValueOnce({
        status: "UNPAID",
        xeroInvoiceId: "inv-1",
        xeroInvoiceNumber: "INV-0042",
        xeroOnlineInvoiceUrl: null,
      })
      .mockResolvedValueOnce({
        status: "UNPAID",
        xeroInvoiceId: "inv-1",
        xeroInvoiceNumber: "INV-0042",
        xeroOnlineInvoiceUrl: "https://pay.xero.com/invoice/inv-1",
      });

    const res = await GET();
    const body = await res.json();

    expect(mockIsXeroConnected).toHaveBeenCalledTimes(1);
    expect(mockCheckMembershipStatus).toHaveBeenCalledWith("member-1", 2026);
    expect(mockFindFirst).toHaveBeenCalledTimes(2);
    expect(body.invoiceUrl).toBe("https://pay.xero.com/invoice/inv-1");
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(401);
    expect(mockFindFirst).not.toHaveBeenCalled();
  });
});
