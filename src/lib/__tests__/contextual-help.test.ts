import { describe, expect, it } from "vitest";
import {
  getContextualHelp,
  getContextualHelpPaths,
} from "@/lib/contextual-help";

describe("contextual help registry", () => {
  it("returns route-specific admin help", () => {
    const help = getContextualHelp("/admin/members", "admin");

    expect(help.title).toBe("Members");
    expect(help.fields?.map((field) => field.name)).toContain("Access role");
  });

  it("includes the booking status glossary on the bookings page help", () => {
    const help = getContextualHelp("/admin/bookings", "admin");

    const glossary = help.sections?.find(
      (section) => section.title === "Booking status glossary",
    );
    expect(glossary).toBeTruthy();
    expect(glossary?.details.some((d) => d.startsWith("Confirmed (Unpaid)"))).toBe(true);
  });

  it("documents the access-roles admin page with the seven areas", () => {
    const help = getContextualHelp("/admin/access-roles", "admin");

    expect(help.title).toBe("Access roles and admin areas");
    const areaFields = help.fields?.map((field) => field.name);
    expect(areaFields).toEqual([
      "Admin Overview",
      "Bookings & Beds",
      "Membership",
      "Finance",
      "Lodge Operations",
      "Content",
      "Support & System",
    ]);
  });

  it("explains membership-type Xero rule modes in context", () => {
    const help = getContextualHelp("/admin/membership-types", "admin");

    expect(help.title).toBe("Membership Types");
    expect(help.fields?.map((field) => field.name)).toEqual(
      expect.arrayContaining(["Xero rule mode", "Xero age scope"]),
    );

    const xeroRules = help.sections?.find(
      (section) => section.title === "Xero rules",
    );
    expect(xeroRules?.details.join(" ")).toContain(
      "Managed rules actively add matching members",
    );
    expect(xeroRules?.details.join(" ")).toContain(
      "Accepted rules tolerate the selected group",
    );
    expect(xeroRules?.details.join(" ")).toContain(
      "only one Managed rule is allowed",
    );
  });

  it("covers the Wave 5 admin setup and help surfaces", () => {
    const routes = [
      "/admin/hut-leaders",
      "/admin/roster",
      "/admin/setup",
      "/admin/membership-setup",
      "/admin/appearance",
      "/admin/bookings-setup",
      "/admin/integrations",
      "/admin/notifications",
      "/admin/membership-types",
      "/admin/members/member-1",
      "/admin/committee",
      "/admin/access-roles",
      "/admin/book",
    ];

    for (const route of routes) {
      const help = getContextualHelp(route, "admin");
      expect(help.title, `${route} should have route-specific help`).not.toBe(
        "Admin Help",
      );
    }
  });

  it("uses the most specific parent route for nested admin pages", () => {
    const help = getContextualHelp("/admin/xero/setup/provider-test", "admin");

    expect(help.title).toBe("Xero Setup");
    expect(help.fields?.map((field) => field.name)).toContain("Account mapping");
  });

  it("falls back to generic admin help for unmapped admin routes", () => {
    const help = getContextualHelp("/admin/not-yet-documented", "admin");

    expect(help.title).toBe("Admin Help");
    expect(help.actions.length).toBeGreaterThan(0);
  });

  it("returns finance dashboard help for finance routes", () => {
    const help = getContextualHelp("/finance?view=revenue", "finance");

    expect(help.title).toBe("Finance Dashboard");
    expect(help.fields?.map((field) => field.name)).toContain("View");
  });

  it("covers the primary admin and finance menu surfaces", () => {
    expect(getContextualHelpPaths("admin")).toEqual(
      expect.arrayContaining([
        "/admin/dashboard",
        "/admin/bookings",
        "/admin/members",
        "/admin/membership-setup",
        "/admin/appearance",
        "/admin/bookings-setup",
        "/admin/integrations",
        "/admin/notifications",
        "/admin/site-banners",
        "/admin/xero/setup",
      ]),
    );
    expect(getContextualHelpPaths("finance")).toEqual(["/finance"]);
  });
});
