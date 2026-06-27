import { describe, expect, it } from "vitest";
import {
  getDisabledFeatureForPath,
  getRequiredFeaturesForPath,
  isFeatureHrefVisible,
} from "@/config/feature-routes";
import { MODULE_KEYS, getEffectiveModuleFlags } from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";

const allOn = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, true]),
) as FeatureFlags;

describe("feature route map", () => {
  it("maps optional module routes to the expected feature flags", () => {
    expect(getRequiredFeaturesForPath("/lodge/kiosk")).toEqual(["kiosk"]);
    expect(getRequiredFeaturesForPath("/admin/chores")).toEqual(["chores"]);
    expect(getRequiredFeaturesForPath("/finance")).toEqual([
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

  it("maps the newer toggleable module routes to their flags", () => {
    expect(getRequiredFeaturesForPath("/api/group-bookings")).toEqual([
      "groupBookings",
    ]);
    expect(getRequiredFeaturesForPath("/admin/lockers")).toEqual(["lockers"]);
    expect(getRequiredFeaturesForPath("/admin/induction")).toEqual([
      "induction",
    ]);
    expect(getRequiredFeaturesForPath("/induction")).toEqual(["induction"]);
    expect(getRequiredFeaturesForPath("/admin/work-parties")).toEqual([
      "workParties",
    ]);
    expect(getRequiredFeaturesForPath("/admin/promo-codes")).toEqual([
      "promoCodes",
    ]);
    expect(getRequiredFeaturesForPath("/admin/hut-leaders")).toEqual([
      "hutLeaders",
    ]);
    expect(getRequiredFeaturesForPath("/admin/communications")).toEqual([
      "communications",
    ]);
    expect(getRequiredFeaturesForPath("/api/skifield-whakapapa")).toEqual([
      "skifieldConditions",
    ]);
  });

  it("blocks each new module's pages AND api routes when it is off", () => {
    // Both a page and an API route 404 when the module is disabled — i.e. an
    // off module is fully gated, not just hidden in the UI.
    expect(
      getDisabledFeatureForPath("/admin/lockers", { ...allOn, lockers: false })
    ).toBe("lockers");
    expect(
      getDisabledFeatureForPath("/api/admin/lockers", {
        ...allOn,
        lockers: false,
      })
    ).toBe("lockers");
    expect(
      getDisabledFeatureForPath("/api/group-bookings/abc/join", {
        ...allOn,
        groupBookings: false,
      })
    ).toBe("groupBookings");
    expect(
      getDisabledFeatureForPath("/api/promo-codes/validate", {
        ...allOn,
        promoCodes: false,
      })
    ).toBe("promoCodes");
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

  it("uses the admin module toggle for effective state", () => {
    // Admin off → disabled.
    expect(
      getDisabledFeatureForPath(
        "/admin/waitlist",
        getEffectiveModuleFlags({ ...allOn, waitlist: false })
      )
    ).toBe("waitlist");
    // Admin on → enabled.
    expect(
      getDisabledFeatureForPath(
        "/admin/waitlist",
        getEffectiveModuleFlags({ ...allOn, waitlist: true })
      )
    ).toBeNull();
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
