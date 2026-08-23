import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const {
  mockRequireFinanceViewerApiAccess,
  mockGetLegacyDashboardBookingExport,
  mockLogger,
} = vi.hoisted(() => ({
  mockRequireFinanceViewerApiAccess: vi.fn(),
  mockGetLegacyDashboardBookingExport: vi.fn(),
  mockLogger: {
    error: vi.fn(),
  },
}));

vi.mock("@/lib/finance-api-auth", () => ({
  requireFinanceViewerApiAccess: mockRequireFinanceViewerApiAccess,
}));

vi.mock("@/lib/finance-legacy-dashboard-export", () => ({
  getLegacyDashboardBookingExport: mockGetLegacyDashboardBookingExport,
}));

vi.mock("@/lib/logger", () => ({
  default: mockLogger,
}));

/**
 * The CLUB's persisted zone, pinned to something that is neither this runner's
 * nor the documented fallback (CT-5, #2869). Without the pin the route would
 * resolve the environment seed and the assertion below would be reading the
 * host's own zone back — a pass that proves nothing, and a red on any machine
 * whose `TZ` is not New Zealand.
 */
const CLUB_TIME_ZONE = "Pacific/Chatham";

vi.mock("@/lib/club-time/server", () => ({
  clubTimeZone: vi.fn(async () => CLUB_TIME_ZONE),
}));

import { GET as getFinanceLegacyDashboardBookingsRoute } from "@/app/api/finance/legacy-dashboard/bookings/route";

describe("finance legacy dashboard bookings route", () => {
  const originalToken = process.env.LEGACY_DASHBOARD_EXPORT_TOKEN;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.LEGACY_DASHBOARD_EXPORT_TOKEN = "test-export-token";
    mockRequireFinanceViewerApiAccess.mockResolvedValue({
      ok: true,
      member: {
        id: "finance-viewer-1",
        financeAccessLevel: "VIEWER",
      },
    });
    mockGetLegacyDashboardBookingExport.mockResolvedValue({
      generatedAt: "2026-05-03T00:00:00.000Z",
      historyStartDate: "2020-04-01",
      asOfDate: "2026-05-03",
      bookings: [],
      forward_bookings: [],
    });
  });

  afterAll(() => {
    process.env.LEGACY_DASHBOARD_EXPORT_TOKEN = originalToken;
  });

  it("rejects requests without the export token", async () => {
    const response = await getFinanceLegacyDashboardBookingsRoute(
      new NextRequest(
        "https://example.org/api/finance/legacy-dashboard/bookings"
      )
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Unauthorised",
    });
  });

  it("returns the export payload when the bearer token is identical", async () => {
    const response = await getFinanceLegacyDashboardBookingsRoute(
      new NextRequest(
        "https://example.org/api/finance/legacy-dashboard/bookings?historyStartDate=2020-04-01&asOfDate=2026-05-03",
        {
          headers: {
            authorization: "Bearer test-export-token",
          },
        }
      )
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      historyStartDate: "2020-04-01",
      asOfDate: "2026-05-03",
    });
    // The CLUB's persisted zone is passed explicitly (CT-5, #2869): the export
    // derives every row's `created_date` from it, and the route derives the
    // default `asOfDate` cut-off from it too.
    expect(mockGetLegacyDashboardBookingExport).toHaveBeenCalledWith({
      historyStartDate: "2020-04-01",
      asOfDate: "2026-05-03",
      clubTimeZone: CLUB_TIME_ZONE,
    });
  });

  it("rejects a different-length bearer token", async () => {
    const response = await getFinanceLegacyDashboardBookingsRoute(
      new NextRequest(
        "https://example.org/api/finance/legacy-dashboard/bookings",
        {
          headers: {
            authorization: "Bearer test-export-token-extra",
          },
        }
      )
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Unauthorised",
    });
    expect(mockGetLegacyDashboardBookingExport).not.toHaveBeenCalled();
  });

  it("rejects a same-length one-byte-different bearer token", async () => {
    const response = await getFinanceLegacyDashboardBookingsRoute(
      new NextRequest(
        "https://example.org/api/finance/legacy-dashboard/bookings",
        {
          headers: {
            authorization: "Bearer test-export-tokea",
          },
        }
      )
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Unauthorised",
    });
    expect(mockGetLegacyDashboardBookingExport).not.toHaveBeenCalled();
  });

  it("rejects requests without finance viewer access before checking the export token", async () => {
    mockRequireFinanceViewerApiAccess.mockResolvedValue({
      ok: false,
      response: NextResponse.json(
        { error: "Finance viewer access required" },
        { status: 403 }
      ),
    });

    const response = await getFinanceLegacyDashboardBookingsRoute(
      new NextRequest(
        "https://example.org/api/finance/legacy-dashboard/bookings",
        {
          headers: {
            authorization: "Bearer test-export-token",
          },
        }
      )
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Finance viewer access required",
    });
    expect(mockGetLegacyDashboardBookingExport).not.toHaveBeenCalled();
  });

  it("rejects invalid query parameters", async () => {
    const response = await getFinanceLegacyDashboardBookingsRoute(
      new NextRequest(
        "https://example.org/api/finance/legacy-dashboard/bookings?asOfDate=03-05-2026",
        {
          headers: {
            authorization: "Bearer test-export-token",
          },
        }
      )
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error:
        "Invalid legacy dashboard export query. Use YYYY-MM-DD for historyStartDate and asOfDate.",
    });
  });

  it("logs backend failures without returning raw error details", async () => {
    mockGetLegacyDashboardBookingExport.mockRejectedValue(
      new Error("database password leaked in driver detail")
    );

    const response = await getFinanceLegacyDashboardBookingsRoute(
      new NextRequest(
        "https://example.org/api/finance/legacy-dashboard/bookings",
        {
          headers: {
            authorization: "Bearer test-export-token",
          },
        }
      )
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Failed to load legacy dashboard bookings export",
    });
    expect(mockLogger.error).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      "Failed to load legacy dashboard bookings export"
    );
  });
});
