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
    expect(
      getRequiredFeaturesForPath("/api/admin/setup/finance-report-mappings")
    ).toEqual(["financeDashboard"]);
    expect(getRequiredFeaturesForPath("/admin/waitlist")).toEqual(["waitlist"]);
    expect(getRequiredFeaturesForPath("/admin/xero/records")).toEqual([
      "xeroIntegration",
    ]);
    expect(getRequiredFeaturesForPath("/admin/internet-banking")).toEqual([
      "xeroIntegration",
      "internetBankingPayments",
    ]);
    expect(
      getRequiredFeaturesForPath("/api/admin/internet-banking-settings")
    ).toEqual(["xeroIntegration", "internetBankingPayments"]);
    expect(getRequiredFeaturesForPath("/api/address-autocomplete/search")).toEqual([
      "addressAutocomplete",
    ]);
    expect(
      getRequiredFeaturesForPath("/api/address-autocomplete/details/123")
    ).toEqual(["addressAutocomplete"]);
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

  it("gates the AI assistant admin surface but NOT the /api/help/chat route", () => {
    // The admin usage + settings surfaces hard-gate on the module flag.
    expect(getRequiredFeaturesForPath("/api/admin/ai-assistant/usage")).toEqual([
      "aiAssistant",
    ]);
    expect(
      getRequiredFeaturesForPath("/api/admin/ai-assistant/settings"),
    ).toEqual(["aiAssistant"]);
    // The admin PAGE (C4) is gated too, so a module-off deployment 404s it
    // rather than rendering an unusable panel.
    expect(getRequiredFeaturesForPath("/admin/ai-assistant")).toEqual([
      "aiAssistant",
    ]);
    // /api/help/chat is deliberately NOT feature-gated: it returns a structured
    // module_off fallback rather than a 404 when the module is off.
    expect(getRequiredFeaturesForPath("/api/help/chat")).toEqual([]);
  });

  it("never gates the lodge admin surface behind a feature flag", () => {
    // Multi-lodge is core (ADR-005): the lodge admin page and its API are
    // always reachable (still admin-gated by the layout), so no feature flag
    // maps to them and they never appear as a required feature.
    expect(getRequiredFeaturesForPath("/admin/lodges")).toEqual([]);
    expect(getRequiredFeaturesForPath("/api/admin/lodges")).toEqual([]);
    expect(getRequiredFeaturesForPath("/api/admin/lodges/lodge-1")).toEqual([]);
    // With every flag on there is still nothing to disable on these paths.
    expect(getDisabledFeatureForPath("/admin/lodges", allOn)).toBeNull();
    expect(getDisabledFeatureForPath("/api/admin/lodges", allOn)).toBeNull();
    expect(
      getDisabledFeatureForPath("/api/admin/lodges/lodge-1", allOn)
    ).toBeNull();
  });

  it("keeps lodge management reachable for a bare single-lodge install (#132 backward-compat)", () => {
    // A single-lodge club with every optional module OFF must still reach the
    // Lodges admin surface — the whole point of promoting multi-lodge to core
    // (ADR-005). Gating it on a now-removed flag would have hidden it here.
    const allOff = Object.fromEntries(
      MODULE_KEYS.map((key) => [key, false])
    ) as FeatureFlags;
    for (const href of ["/admin/lodges", "/api/admin/lodges"]) {
      expect(getDisabledFeatureForPath(href, allOff)).toBeNull();
      expect(isFeatureHrefVisible(href, allOff)).toBe(true);
    }
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
    expect(
      getDisabledFeatureForPath("/api/address-autocomplete/search", {
        ...allOn,
        addressAutocomplete: false,
      })
    ).toBe("addressAutocomplete");
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
    expect(
      getDisabledFeatureForPath("/admin/internet-banking", {
        ...allOn,
        xeroIntegration: false,
      })
    ).toBe("xeroIntegration");
    expect(
      getDisabledFeatureForPath("/admin/internet-banking", {
        ...allOn,
        internetBankingPayments: false,
      })
    ).toBe("internetBankingPayments");
    expect(
      getDisabledFeatureForPath("/api/admin/internet-banking-settings", {
        ...allOn,
        internetBankingPayments: false,
      })
    ).toBe("internetBankingPayments");
    expect(
      getDisabledFeatureForPath(
        "/api/admin/setup/finance-report-mappings/backfill",
        { ...allOn, financeDashboard: false }
      )
    ).toBe("financeDashboard");
    expect(
      isFeatureHrefVisible("/admin/xero#xero-section-mappings", {
        ...allOn,
        xeroIntegration: false,
      })
    ).toBe(false);
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

  it("does not gate the Integrations hub on xeroIntegration (#2216)", () => {
    // The Integrations hub aggregates cards for Xero, Stripe, Google sign-in and
    // Backups; each card is feature-/permission-filtered individually and each
    // destination keeps its own gate. The hub itself must stay reachable so the
    // other integrations remain discoverable — and their hub back-links do not
    // 404 — whenever Xero is off.
    expect(getRequiredFeaturesForPath("/admin/integrations")).toEqual([]);
    expect(
      getDisabledFeatureForPath("/admin/integrations", {
        ...allOn,
        xeroIntegration: false,
      })
    ).toBeNull();
    expect(
      isFeatureHrefVisible("/admin/integrations", {
        ...allOn,
        xeroIntegration: false,
      })
    ).toBe(true);
    // The Xero setup card's own href stays gated, so it filters out with Xero off.
    expect(
      isFeatureHrefVisible("/admin/xero/setup", {
        ...allOn,
        xeroIntegration: false,
      })
    ).toBe(false);
  });

  it("does not match shared booking APIs or similar prefixes", () => {
    expect(getRequiredFeaturesForPath("/api/bookings")).toEqual([]);
    expect(getRequiredFeaturesForPath("/financex")).toEqual([]);
  });

  it("does not gate core booking routes on any lodge feature", () => {
    // Core booking creation and reads must work whether or not the club runs
    // multiple lodges. No booking route requires a lodge-related flag, and an
    // `/admin/lodges`-lookalike prefix must not catch bookings.
    expect(getRequiredFeaturesForPath("/api/bookings")).toEqual([]);
    expect(getRequiredFeaturesForPath("/api/bookings/booking-1")).toEqual([]);
    expect(getDisabledFeatureForPath("/api/bookings", allOn)).toBeNull();
    expect(
      getDisabledFeatureForPath("/api/bookings/booking-1", allOn)
    ).toBeNull();
    expect(getDisabledFeatureForPath("/admin/bookings", allOn)).toBeNull();
  });

  // The Lodge Display guided setup wizard (#2249) is the ONE page under
  // /admin/display that must survive the module being off — its first step is
  // "turn the module on". The exemption is exact-match, so every neighbouring
  // path (and the whole display API) stays gated.
  describe("lobbyDisplay setup-wizard exemption (#2249)", () => {
    it("exempts the wizard page itself, with or without a trailing slash", () => {
      expect(getRequiredFeaturesForPath("/admin/display/setup")).toEqual([]);
      expect(getRequiredFeaturesForPath("/admin/display/setup/")).toEqual([]);
      expect(
        isFeatureHrefVisible("/admin/display/setup", {
          ...allOn,
          lobbyDisplay: false,
        })
      ).toBe(true);
    });

    it("keeps every neighbouring display path gated", () => {
      for (const path of [
        "/admin/display",
        "/admin/display/devices",
        "/admin/display/templates",
        "/admin/display/setup/extra",
        "/admin/display/setupfoo",
        "/admin/display/setup-foo",
        "/api/admin/display/setup",
        "/api/admin/display/devices",
        "/display",
      ]) {
        expect(getRequiredFeaturesForPath(path)).toEqual(["lobbyDisplay"]);
        expect(
          getDisabledFeatureForPath(path, { ...allOn, lobbyDisplay: false })
        ).toBe("lobbyDisplay");
      }
    });

    it("requires nothing of a doubled-slash path, which matches no rule at all", () => {
      // Stated because the neighbouring comment used to claim this "fails
      // closed", which it does not: `//admin/display/setup` does not start with
      // `/admin/display`, so no rule matches and this map asks for no flag. It
      // is harmless because Next normalises the duplicate slash before a page is
      // resolved — there is nothing behind it to reach — but the test records
      // the real behaviour rather than the comfortable one (#2249 review L1).
      expect(getRequiredFeaturesForPath("//admin/display/setup")).toEqual([]);
      expect(getRequiredFeaturesForPath("//admin/display/devices")).toEqual([]);
    });

    it("does not let the exemption leak into another rule's flags", () => {
      // A path exempted from ONE rule still collects every other rule it
      // matches; nothing about /admin/display/setup should touch kiosk/chores.
      expect(
        getDisabledFeatureForPath("/admin/display/setup", {
          ...allOn,
          lobbyDisplay: false,
          kiosk: false,
          chores: false,
        })
      ).toBeNull();
    });
  });

  it("supports nav filtering with query strings", () => {
    expect(
      isFeatureHrefVisible("/admin/waitlist?status=WAITLISTED", {
        ...allOn,
        waitlist: false,
      })
    ).toBe(false);
    expect(isFeatureHrefVisible("/admin/bookings", allOn)).toBe(true);
    expect(
      isFeatureHrefVisible("/admin/internet-banking", {
        ...allOn,
        xeroIntegration: false,
      })
    ).toBe(false);
    expect(
      isFeatureHrefVisible("/admin/internet-banking", {
        ...allOn,
        internetBankingPayments: false,
      })
    ).toBe(false);
    expect(isFeatureHrefVisible("/admin/internet-banking", allOn)).toBe(true);
  });
});
