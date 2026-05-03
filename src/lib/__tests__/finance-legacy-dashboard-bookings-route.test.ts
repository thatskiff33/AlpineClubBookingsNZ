import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockGetLegacyDashboardBookingExport } = vi.hoisted(() => ({
  mockGetLegacyDashboardBookingExport: vi.fn(),
}));

vi.mock("@/lib/finance-legacy-dashboard-export", () => ({
  getLegacyDashboardBookingExport: mockGetLegacyDashboardBookingExport,
}));

import { GET as getFinanceLegacyDashboardBookingsRoute } from "@/app/api/finance/legacy-dashboard/bookings/route";

describe("finance legacy dashboard bookings route", () => {
  const originalToken = process.env.LEGACY_DASHBOARD_EXPORT_TOKEN;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.LEGACY_DASHBOARD_EXPORT_TOKEN = "test-export-token";
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
      new NextRequest("https://tokoroa.org.nz/api/finance/legacy-dashboard/bookings")
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Unauthorised",
    });
  });

  it("returns the export payload for authorised requests", async () => {
    const response = await getFinanceLegacyDashboardBookingsRoute(
      new NextRequest(
        "https://tokoroa.org.nz/api/finance/legacy-dashboard/bookings?historyStartDate=2020-04-01&asOfDate=2026-05-03",
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
    expect(mockGetLegacyDashboardBookingExport).toHaveBeenCalledWith({
      historyStartDate: "2020-04-01",
      asOfDate: "2026-05-03",
    });
  });

  it("rejects invalid query parameters", async () => {
    const response = await getFinanceLegacyDashboardBookingsRoute(
      new NextRequest(
        "https://tokoroa.org.nz/api/finance/legacy-dashboard/bookings?asOfDate=03-05-2026",
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
});
