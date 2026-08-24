import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getContextualHelp,
  getContextualHelpPaths,
} from "@/lib/contextual-help";
import type { HelpEntry } from "@/lib/contextual-help/types";

function findQualifiedRegistrationDrift(
  discovered: readonly string[],
  registered: readonly string[],
): string[] {
  const remainingRegistered = new Map<string, number>();
  for (const key of registered) {
    remainingRegistered.set(key, (remainingRegistered.get(key) ?? 0) + 1);
  }

  const drift: string[] = [];
  for (const key of discovered) {
    const remaining = remainingRegistered.get(key) ?? 0;
    if (remaining === 0) {
      drift.push(`discovered but not registered: ${key}`);
    } else if (remaining === 1) {
      remainingRegistered.delete(key);
    } else {
      remainingRegistered.set(key, remaining - 1);
    }
  }
  for (const [key, count] of remainingRegistered) {
    for (let index = 0; index < count; index += 1) {
      drift.push(`registered but not discovered: ${key}`);
    }
  }
  return drift.sort();
}

describe("contextual help registry", () => {
  it.each([
    ["/admin/members", "search, filters, sort, and page"],
    ["/admin/bookings", "without changing the selected lodge"],
    ["/admin/payments", "rolling three-month Updated range"],
    ["/admin/subscriptions", "without changing the selected season"],
    ["/admin/reports", "without changing the selected lodge"],
  ])("documents dataset Reset behavior for %s", (pathname, expected) => {
    const help = getContextualHelp(pathname, "admin");

    expect(
      help.actions.find((action) => action.startsWith("Use Reset")),
    ).toContain(expected);
  });

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

  it("explains the club time zone, and that it is not the server's", () => {
    // CT-1 (#2989). The three things an operator gets wrong about this setting
    // are all in the help rather than only in the panel: what it is, that it is
    // not the machine's timezone, and that changing it moves nothing already
    // recorded.
    const help = getContextualHelp("/admin/club-time", "admin");

    expect(help.title).toBe("Club Time Zone");
    expect(help.fields?.map((field) => field.name)).toEqual(
      expect.arrayContaining(["Club time zone", "Not the server's time zone"]),
    );
    const notes = help.notes?.join(" ") ?? "";
    expect(notes).toContain("does not move anything already recorded");
    expect(notes).toContain("keep the calendar dates they already have");
    expect(notes).toContain("Abbreviations such as NZT");
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
      "/admin/setup/foundations",
      "/admin/setup/finance",
      "/admin/setup/booking-rules",
      "/admin/setup/integrations",
      "/admin/setup/cancellation",
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
    expect(help.actions).toContainEqual(
      expect.stringContaining("without changing the current view or lodge scope"),
    );
  });

  it("documents the Reports Next Month quick range and retained filters", () => {
    const help = getContextualHelp("/admin/reports", "admin");

    expect(help.actions.join(" ")).toContain("Next Month");
    expect(
      help.fields?.find((field) => field.name === "Quick Range")?.description,
    ).toContain("without changing the Lodge or Deleted filters");

    const metricContract = help.sections?.find(
      (section) => section.title === "How report metrics are counted",
    );
    const details = metricContract?.details.join(" ") ?? "";
    expect(details).toContain(
      "across every lodge night in its complete stay, with any remainder assigned deterministically, before the selected date range is sliced",
    );
    expect(details).toContain("allocated booking value, not collected cash");
    expect(details).toContain("displayed to exact cents in the page and exports");
    expect(details).toContain("captured payment amount less refunds");
    expect(details).toContain("Outstanding Additions is shown separately");
    expect(details).toContain("how much Net Collected Cash may understate");
    expect(details).toContain("included in CSV and PDF exports");
    expect(details).toContain(
      "Pending, Payment Pending, Confirmed, Paid, Awaiting Review, and Completed",
    );
    expect(details).toContain("only Paid and Completed bookings occupy beds");
    expect(details).toContain("custodian bed holds remain excluded");
  });

  it("covers the primary admin and finance menu surfaces", () => {
    expect(getContextualHelpPaths("admin")).toEqual(
      expect.arrayContaining([
        "/admin/dashboard",
        "/admin/bookings",
        "/admin/members",
        "/admin/membership-setup",
        "/admin/setup/finance",
        "/admin/setup/booking-rules",
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

  /**
   * #2689 review: `/admin/notifications` carried TWO entries with different
   * copy. Resolution sorts by path length and takes the first, so the second
   * was dead text that read as live — an earlier draft describing a page shape
   * that no longer exists. It was deleted and its one accurate field (the
   * delivery tri-state) folded into the surviving entry.
   *
   * The guard is the general one, not the instance: no admin path may be
   * registered twice, because a second entry is unreachable by construction.
   */
  it("registers each admin help path exactly once", () => {
    const paths = getContextualHelpPaths("admin");
    const seen = new Set<string>();
    const duplicated = paths.filter((path) => {
      if (seen.has(path)) return true;
      seen.add(path);
      return false;
    });
    expect(
      duplicated,
      "These paths have more than one entry. Longest-prefix resolution takes " +
        "the first, so every later entry is dead text that reads as live:\n" +
        duplicated.join("\n"),
    ).toEqual([]);
  });

  it("resolves /admin/notifications to the entry that matches the page", () => {
    const help = getContextualHelp("/admin/notifications", "admin");

    expect(help.title).toBe("Notifications & Email");
    // The five cards the page actually renders.
    const actions = help.actions.join(" ");
    for (const card of [
      "Delivery Rules",
      "Recipients",
      "Email Messages",
      "Booking Messages",
      "Membership Cancellation",
    ]) {
      expect(actions).toContain(card);
    }
    // The deleted draft's vocabulary, kept because the tri-state is real.
    expect(help.fields?.map((field) => field.name)).toContain("Delivery mode");
    // And the draft's own summary must not be what resolves.
    expect(help.summary).not.toContain("delivery policies");
  });

  /**
   * #2689 split the corpus into one module per admin sidebar section. The
   * failure that split makes possible is a silent one: add a section module,
   * forget the line in `contextual-help/index.ts`, and every page in it drops
   * to the generic fallback with nothing red. So read the directory rather than
   * trusting a list, and require every module's entries to be registered.
   */
  it("compares discovered and registered admin entries as an exact qualified multiset", async () => {
    const sectionDir = join(process.cwd(), "src/lib/contextual-help/admin");
    const modules = readdirSync(sectionDir)
      .filter((f) => f.endsWith(".ts"))
      .sort();
    expect(modules.length).toBeGreaterThan(0);

    const discovered: string[] = [];
    for (const file of modules) {
      // The `.ts` stays in the static part of the specifier: Vite's
      // dynamic-import-vars plugin needs an extension there to build the glob.
      const loaded: Record<string, unknown> = await import(
        `@/lib/contextual-help/admin/${file.replace(/\.ts$/, "")}.ts`
      );
      const entries = Object.values(loaded).find(Array.isArray) as
        | HelpEntry[]
        | undefined;
      expect(entries, `${file} exports no help-entry array`).toBeDefined();
      for (const helpEntry of entries ?? []) {
        discovered.push(`${file}: ${helpEntry.path}`);
      }
    }
    const drift = findQualifiedRegistrationDrift(
      discovered,
      getContextualHelpPaths("admin", { qualifyAdminModule: true }),
    );
    expect(
      drift,
      "The discovered admin-section entries and module-qualified registry differ. " +
        "An unregistered module silently falls back to generic help, while an " +
        "unexpected registration makes the census stale:\n" + drift.join("\n"),
    ).toEqual([]);
  });

  it("detects an orphan module that reuses an existing registered path", () => {
    const existing = "dashboard.ts: /admin/dashboard";
    const orphan = "orphan.ts: /admin/dashboard";

    expect(
      findQualifiedRegistrationDrift([existing, orphan], [existing]),
    ).toEqual([`discovered but not registered: ${orphan}`]);
  });
});
