import { describe, expect, it } from "vitest";
import {
  FEATURE_ROUTE_RULES,
  getDisabledFeatureForPath,
  getRequiredFeaturesForPath,
  isFeatureHrefVisible,
} from "@/config/feature-routes";
import {
  MODULE_KEYS,
  getEffectiveModuleFlags,
  type ModuleKey,
} from "@/config/modules";
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

  it("gates the whole events-calendar surface on eventsCalendar (#2241)", () => {
    // The calendar shipped with no module key at all, so every one of its three
    // prefixes has to be listed: the member page, the admin page, and the shared
    // API both pages read and write through. There is deliberately no
    // "/api/admin/calendar" prefix — no admin-only calendar API exists, and
    // admin-route-map-drift.test.ts fails a prefix matching no real file.
    expect(getRequiredFeaturesForPath("/calendar")).toEqual(["eventsCalendar"]);
    expect(getRequiredFeaturesForPath("/api/calendar")).toEqual([
      "eventsCalendar",
    ]);
    expect(getRequiredFeaturesForPath("/admin/calendar")).toEqual([
      "eventsCalendar",
    ]);

    // Nested paths under each prefix are gated too — the event detail route and
    // the meeting-join endpoint included.
    const off = { ...allOn, eventsCalendar: false };
    for (const href of [
      "/calendar",
      "/api/calendar/events",
      "/api/calendar/events/event-1",
      "/api/calendar/events/event-1/join",
      "/admin/calendar",
    ]) {
      expect(getDisabledFeatureForPath(href, off)).toBe("eventsCalendar");
      expect(isFeatureHrefVisible(href, off)).toBe(false);
      expect(getDisabledFeatureForPath(href, allOn)).toBeNull();
    }

    // Lookalike prefixes must not be caught by the gate.
    expect(getRequiredFeaturesForPath("/calendarx")).toEqual([]);
    expect(getRequiredFeaturesForPath("/admin/calendarx")).toEqual([]);
  });

  it("keeps the calendar API inside the proxy matcher (#2241)", async () => {
    // The rule above is inert for "/api/calendar" unless the proxy actually runs
    // on those requests: config.matcher's first entry excludes every "/api/…"
    // path, so each gated API prefix needs its own entry. This asserts the pair
    // stays together — a rule with no matcher entry is a gate that never fires.
    const { config } = await import("@/proxy");
    expect(config.matcher).toContain("/api/calendar/:path*");
  });

  it("gates every maintenance-reports surface and keeps its API prefixes in the matcher (#2780)", async () => {
    // This is the regression the #2780 security review caught: FEATURE_ROUTE_RULES
    // gated both /api prefixes, but the proxy matcher listed NEITHER, so with the
    // module off the pages 404'd (non-/api, caught by the root matcher entry) while
    // the two API doors — including the UNAUTHENTICATED QR submit — stayed live.
    const off = { ...allOn, maintenanceReports: false };
    for (const href of [
      "/maintenance-report",
      "/lodge-maintenance/tok-1",
      "/admin/maintenance-reports",
      "/api/maintenance-reports",
      "/api/lodge-maintenance/tok-1",
      "/api/admin/maintenance-reports",
      "/api/admin/maintenance-reports/tokens",
    ]) {
      expect(getDisabledFeatureForPath(href, off)).toBe("maintenanceReports");
      expect(getDisabledFeatureForPath(href, allOn)).toBeNull();
    }

    // Both member-facing /api prefixes need their OWN matcher entry — the root
    // entry excludes every "/api/…" path, so a gate with no matcher entry never
    // fires. (The admin prefix is covered by "/api/admin/:path*".)
    const { config } = await import("@/proxy");
    expect(config.matcher).toContain("/api/maintenance-reports/:path*");
    expect(config.matcher).toContain("/api/lodge-maintenance/:path*");

    // Lookalike prefixes must not be caught by the gate.
    expect(getRequiredFeaturesForPath("/api/lodge-maintenancex")).toEqual([]);
    expect(getRequiredFeaturesForPath("/maintenance-reportx")).toEqual([]);
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

  it("gates the AI Diagnostics budget settings but keeps readiness reachable module-off (AID-2)", () => {
    // The operational budget settings hard-gate on the module flag, exactly like
    // the page-help settings route above.
    expect(
      getRequiredFeaturesForPath("/api/admin/ai-diagnostics/settings"),
    ).toEqual(["aiDiagnostics"]);
    expect(
      getDisabledFeatureForPath("/api/admin/ai-diagnostics/settings", {
        ...allOn,
        aiDiagnostics: false,
      }),
    ).toBe("aiDiagnostics");
    // The readiness endpoint is EXEMPT so setup can be guided before enabling —
    // it must stay reachable with the module OFF, in every spelling.
    expect(
      getRequiredFeaturesForPath("/api/admin/ai-diagnostics/readiness"),
    ).toEqual([]);
    expect(
      getDisabledFeatureForPath("/api/admin/ai-diagnostics/readiness", {
        ...allOn,
        aiDiagnostics: false,
      }),
    ).toBeNull();
    expect(
      getRequiredFeaturesForPath("/api/admin/ai-diagnostics/readiness.rsc"),
    ).toEqual([]);
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

  it("applies every pattern rule to the trailing-slash and data spellings too", () => {
    // Symmetric with the consent case (#2435 review): each `$`-anchored rule
    // must still fire on the spellings Next's matcher lets through the proxy.
    expect(
      getRequiredFeaturesForPath("/api/bookings/booking-1/waitlist-confirm/"),
    ).toEqual(["waitlist"]);
    expect(
      getRequiredFeaturesForPath(
        "/api/admin/bookings/booking-1/force-confirm.json",
      ),
    ).toEqual(["waitlist"]);
    expect(
      getRequiredFeaturesForPath(
        "/api/admin/bookings/booking-1/return-to-waitlist/",
      ),
    ).toEqual(["waitlist"]);
    for (const action of ["link", "push", "unlink"]) {
      expect(
        getRequiredFeaturesForPath(
          `/api/admin/members/member-1/xero-${action}`,
        ),
      ).toEqual(["xeroIntegration"]);
      expect(
        getRequiredFeaturesForPath(
          `/api/admin/members/member-1/xero-${action}/`,
        ),
      ).toEqual(["xeroIntegration"]);
    }
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

  describe("member guests (#2305 / #2307)", () => {
    it("gates the delegate answer page and the consent endpoint", () => {
      expect(getRequiredFeaturesForPath("/bookings/consent/bg-1")).toEqual([
        "memberGuests",
      ]);
      expect(
        getRequiredFeaturesForPath("/api/bookings/bk-1/guests/bg-1/consent"),
      ).toEqual(["memberGuests"]);
      expect(
        getDisabledFeatureForPath("/bookings/consent/bg-1", {
          ...allOn,
          memberGuests: false,
        }),
      ).toBe("memberGuests");
      expect(
        getDisabledFeatureForPath("/api/bookings/bk-1/guests/bg-1/consent", {
          ...allOn,
          memberGuests: false,
        }),
      ).toBe("memberGuests");
    });

    it("gates the consent endpoint in the spellings the matcher admits", () => {
      // The proxy runs BEFORE Next's canonicalising 308, and Next's matcher
      // admits the data-request spellings of every entry — so a `$`-anchored
      // pattern that only matched the bare path would leave the outer gate
      // inert for exactly the requests that reach it (#2435 review).
      for (const path of [
        "/api/bookings/b1/guests/g1/consent/",
        "/api/bookings/b1/guests/g1/consent.json",
        "/api/bookings/b1/guests/g1/consent.rsc",
      ]) {
        expect(getRequiredFeaturesForPath(path)).toEqual(["memberGuests"]);
        expect(
          getDisabledFeatureForPath(path, { ...allOn, memberGuests: false }),
        ).toBe("memberGuests");
      }
    });

    it("leaves the shared booking-guest routes alone", () => {
      // Ordinary (non-member) guests are core booking behaviour and travel
      // through the same two paths. Gating either on memberGuests would stop a
      // club that does not run member guests from adding a guest at all.
      expect(getRequiredFeaturesForPath("/api/bookings/bk-1/guests")).toEqual(
        [],
      );
      expect(
        getRequiredFeaturesForPath("/api/bookings/bk-1/guests/bg-1"),
      ).toEqual([]);
      expect(getRequiredFeaturesForPath("/bookings/bk-1")).toEqual([]);
    });

    it("keeps the admin settings route reachable while the module is off", () => {
      // MG2-M-4: an admin configures the member-guest policy first and turns
      // the module on afterwards, so this route must survive the module being
      // off. It is protected by its `bookings` admin permission area instead.
      expect(
        getRequiredFeaturesForPath("/api/admin/member-guest-settings"),
      ).toEqual([]);
      expect(
        getDisabledFeatureForPath("/api/admin/member-guest-settings", {
          ...allOn,
          memberGuests: false,
        }),
      ).toBeNull();
      expect(
        getDisabledFeatureForPath("/admin/bookings-setup", {
          ...allOn,
          memberGuests: false,
        }),
      ).toBeNull();
    });
  });

  it("gives every module a feature-route rule, or a stated reason for having none", () => {
    // A whole module once shipped with pages, API routes and no rule at all,
    // and every suite still passed (#2307 review M10). This is the tripwire: a
    // new module key either gates its own routes here, or it is written down
    // below as one that owns no routes to gate.
    //
    // The allow-list is only for modules that change how an EXISTING shared
    // route behaves rather than owning a route namespace of their own:
    //   twoFactor / magicLink / googleLogin — extra ways to get through the
    //     shared login and account pages. Gating /login on any of them would
    //     lock every member out of the site whenever the module was off.
    //
    // `analytics` was on this list until #2573 gave it a namespace of its own:
    // its GA4 measurement id, consent-banner mode and banner wording moved out of
    // NEXT_PUBLIC_GA_MEASUREMENT_ID into the database, behind
    // /api/admin/integrations/analytics, which the module flag now 404s. It still
    // injects a script into public pages rather than owning a public route, so the
    // rule gates only the admin configuration subtree.
    const MODULES_WITHOUT_ROUTE_RULES: ModuleKey[] = [
      "twoFactor",
      "magicLink",
      "googleLogin",
    ];

    const gatedFlags = new Set<string>(
      FEATURE_ROUTE_RULES.map((rule) => rule.flag),
    );

    expect(
      MODULE_KEYS.filter(
        (key) =>
          !gatedFlags.has(key) && !MODULES_WITHOUT_ROUTE_RULES.includes(key),
      ),
    ).toEqual([]);

    // The allow-list must not rot either: once a module grows a rule, it stops
    // being an exception and the list has to say so.
    expect(
      MODULES_WITHOUT_ROUTE_RULES.filter((key) => gatedFlags.has(key)),
    ).toEqual([]);
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

    it("exempts the wizard's data-request spelling as well", () => {
      // The exemption is compared against the same canonical form the rules
      // are, so the page stays reachable in every spelling that reaches it —
      // otherwise its own data requests would 404 with the module off.
      expect(getRequiredFeaturesForPath("/admin/display/setup.rsc")).toEqual([]);
      expect(getRequiredFeaturesForPath("/admin/display/setup.json")).toEqual(
        []
      );
    });

    it("keeps every neighbouring display path gated", () => {
      for (const path of [
        "/admin/display",
        "/admin/display/devices",
        "/admin/display/devices.rsc",
        "/admin/display/setup.txt",
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
