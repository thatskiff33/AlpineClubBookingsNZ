import { describe, expect, it } from "vitest";
import {
  getDisabledFeatureForPath,
  getRequiredFeaturesForPath,
  isFeatureHrefVisible,
} from "@/config/feature-routes";
import type { FeatureFlags } from "@/config/schema";

const allOn: FeatureFlags = {
  kiosk: true,
  chores: true,
  financeDashboard: true,
  waitlist: true,
  xeroIntegration: true,
};

describe("feature route map", () => {
  it("maps optional module routes to the expected feature flags", () => {
    expect(getRequiredFeaturesForPath("/lodge/kiosk")).toEqual(["kiosk"]);
    expect(getRequiredFeaturesForPath("/admin/chores")).toEqual(["chores"]);
    expect(getRequiredFeaturesForPath("/finance/revenue")).toEqual([
      "financeDashboard",
    ]);
    expect(getRequiredFeaturesForPath("/admin/waitlist")).toEqual(["waitlist"]);
    expect(getRequiredFeaturesForPath("/admin/xero/records")).toEqual([
      "xeroIntegration",
    ]);
  });

  it("requires both kiosk and chores for lodge roster routes", () => {
    expect(getRequiredFeaturesForPath("/lodge/roster/2026-07-01")).toEqual([
      "kiosk",
      "chores",
    ]);
  });

  it("detects the disabled feature for protected route and API paths", () => {
    expect(
      getDisabledFeatureForPath("/api/bookings/booking-1/waitlist-confirm", {
        ...allOn,
        waitlist: false,
      })
    ).toBe("waitlist");
    expect(
      getDisabledFeatureForPath("/api/admin/members/member-1/xero-link", {
        ...allOn,
        xeroIntegration: false,
      })
    ).toBe("xeroIntegration");
  });

  it("does not match shared booking APIs or similar prefixes", () => {
    expect(getRequiredFeaturesForPath("/api/bookings")).toEqual([]);
    expect(getRequiredFeaturesForPath("/financex")).toEqual([]);
  });

  it("supports nav filtering with query strings", () => {
    expect(
      isFeatureHrefVisible("/admin/waitlist?status=WAITLISTED", {
        ...allOn,
        waitlist: false,
      })
    ).toBe(false);
    expect(isFeatureHrefVisible("/admin/bookings", allOn)).toBe(true);
  });
});
