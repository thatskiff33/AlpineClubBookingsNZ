import { describe, expect, it } from "vitest";
import { MODULE_KEYS } from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";
import {
  getAdminFeatureSearchIndex,
  getVisibleAdminNavSections,
} from "@/components/admin-sidebar";
import { requireCalendarDate } from "@/lib/club-time";

/**
 * #3123 — the club's day, first and REQUIRED on all three nav exports. One nav
 * href is a dated deep link (the unpaid-finished-stays queue), so the sidebar and
 * the command palette have to be handed the SAME day or their link and its badge
 * describe different queues. Nothing in this file asserts on that href's date, so
 * one fixed day serves every call.
 */
const CLUB_DAY = requireCalendarDate("2026-07-01");


const allOn: FeatureFlags = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, true]),
) as FeatureFlags;

function matrix(
  over: Partial<Record<keyof AdminPermissionMatrix, "none" | "view" | "edit">>,
): AdminPermissionMatrix {
  return {
    overview: "none",
    bookings: "none",
    membership: "none",
    finance: "none",
    lodge: "none",
    content: "none",
    support: "none",
    ...over,
  };
}

const fullMatrix = matrix({
  overview: "edit",
  bookings: "edit",
  membership: "edit",
  finance: "edit",
  lodge: "edit",
  content: "edit",
  support: "edit",
});

/**
 * The invariant, expressed as a test seam: the palette index MUST expose
 * exactly the (de-duplicated) set of hrefs the sidebar's
 * getVisibleAdminNavSections would show the same admin — no more, no less.
 */
function visibleHrefs(
  features: FeatureFlags,
  permissionMatrix?: AdminPermissionMatrix,
  isFullAdmin?: boolean,
  hutLeaderLabel = "Hut Leader",
): Set<string> {
  return new Set(
    getVisibleAdminNavSections(
      CLUB_DAY,
      features,
      permissionMatrix,
      isFullAdmin,
      hutLeaderLabel,
    ).flatMap((section) => section.items.map((item) => item.href)),
  );
}

describe("getAdminFeatureSearchIndex — derivation", () => {
  it("indexes every visible nav page exactly once (no duplicates across sections)", () => {
    const index = getAdminFeatureSearchIndex(CLUB_DAY, allOn, fullMatrix, true);
    const hrefs = index.map((entry) => entry.href);

    // De-duplicated: "Needs Attention" re-lists pages from their home sections,
    // but each page appears exactly once in the index.
    expect(new Set(hrefs).size).toBe(hrefs.length);
    // Covers exactly the set the sidebar would render — the single source of truth.
    expect(new Set(hrefs)).toEqual(visibleHrefs(allOn, fullMatrix, true));
  });

  it("labels a de-duplicated page by its natural section, not Needs Attention", () => {
    const index = getAdminFeatureSearchIndex(CLUB_DAY, allOn, fullMatrix, true);
    const bookingRequests = index.find(
      (entry) => entry.href === "/admin/booking-requests",
    );

    expect(bookingRequests?.section).toBe("Bookings & Beds");
  });

  it("indexes Lobby Display once under Lodge Operations", () => {
    const lobbyDisplayEntries = getAdminFeatureSearchIndex(
      CLUB_DAY,
      allOn,
      fullMatrix,
      true,
    ).filter((entry) => entry.href === "/admin/display");

    expect(lobbyDisplayEntries).toEqual([
      expect.objectContaining({
        label: "Lobby Display",
        section: "Lodge Operations",
      }),
    ]);
  });

  it("carries the hut-leader relabel through from getVisibleAdminNavSections", () => {
    const index = getAdminFeatureSearchIndex(
      CLUB_DAY,
      allOn,
      fullMatrix,
      true,
      "Warden",
    );
    const hutLeaders = index.find(
      (entry) => entry.href === "/admin/hut-leaders",
    );

    expect(hutLeaders?.label).toBe("Wardens");
  });

  it("carries optional keywords through to the index entry", () => {
    const index = getAdminFeatureSearchIndex(CLUB_DAY, allOn, fullMatrix, true);
    const xero = index.find((entry) => entry.href === "/admin/xero");

    expect(xero?.keywords).toContain("accounting");
  });

  /*
    A card that lives INSIDE a hub page has to be findable through that hub's href.

    The index is built from hrefs, so a surface with no href of its own cannot
    appear in it — and #2573 deliberately gave Google Analytics no route, putting
    its configuration in a dialog on the Integrations hub instead (owner
    clarification 4). The hub therefore carries the search terms, which is the house
    convention: Backups carries "s3"/"pg_dump", the AI help assistant carries
    "anthropic"/"spend cap".

    Worth pinning rather than trusting: "analytics" alone is ambiguous in this tree —
    `/admin/reports` already claims it for Financial Reports — so before this the
    palette answered the obvious search with the wrong screen, and answered "google
    analytics" and "ga4" with nothing.
  */
  it("finds Google Analytics through the Integrations hub it lives on", () => {
    const index = getAdminFeatureSearchIndex(CLUB_DAY, allOn, fullMatrix, true);
    const integrations = index.find(
      (entry) => entry.href === "/admin/integrations",
    );

    expect(integrations?.keywords).toEqual(
      expect.arrayContaining(["google analytics", "analytics", "ga4"]),
    );
    // The pre-existing terms stay: this widened the entry, it did not replace it.
    expect(integrations?.keywords).toEqual(
      expect.arrayContaining(["api", "connections", "third-party", "webhooks"]),
    );
  });
});

describe("getAdminFeatureSearchIndex — permission filtering (the invariant)", () => {
  it("matches getVisibleAdminNavSections for a limited (bookings-only) matrix", () => {
    const limited = matrix({ bookings: "view" });
    const index = getAdminFeatureSearchIndex(CLUB_DAY, allOn, limited, false);
    const hrefs = new Set(index.map((entry) => entry.href));

    expect(hrefs).toEqual(visibleHrefs(allOn, limited, false));
    // Bookings pages are in; other areas are out.
    expect(hrefs.has("/admin/bookings")).toBe(true);
    expect(hrefs.has("/admin/members")).toBe(false);
    // fullAdminOnly export/import never leaks to a non-full-admin.
    expect(hrefs.has("/admin/config-transfer")).toBe(false);
  });

  it("hides fullAdminOnly pages from a non-full-admin even with support edit (no matrix leak)", () => {
    const supportEditor = matrix({ support: "edit" });

    const asNonFullAdmin = new Set(
      getAdminFeatureSearchIndex(CLUB_DAY, allOn, supportEditor, false).map(
        (entry) => entry.href,
      ),
    );
    const asFullAdmin = new Set(
      getAdminFeatureSearchIndex(CLUB_DAY, allOn, supportEditor, true).map(
        (entry) => entry.href,
      ),
    );

    // The support matrix alone would satisfy the /admin/config-transfer prefix
    // requirement; fullAdminOnly must still gate it. This is the exact leak the
    // invariant warns about.
    expect(asNonFullAdmin.has("/admin/config-transfer")).toBe(false);
    expect(asNonFullAdmin.has("/admin/access-roles")).toBe(false);
    // A full admin with the same matrix sees them.
    expect(asFullAdmin.has("/admin/config-transfer")).toBe(true);
    expect(asFullAdmin.has("/admin/access-roles")).toBe(true);
  });

  it("honours the orAccess predicate for /admin/fees (finance-only view reaches it)", () => {
    const financeOnly = matrix({ finance: "view" });
    const index = getAdminFeatureSearchIndex(CLUB_DAY, allOn, financeOnly, false);
    const hrefs = new Set(index.map((entry) => entry.href));

    // /admin/fees resolves to the bookings prefix, but its orAccess admits a
    // finance-only viewer — the palette must match that OR rule, not the prefix.
    expect(hrefs.has("/admin/fees")).toBe(true);
    expect(hrefs).toEqual(visibleHrefs(allOn, financeOnly, false));

    // Neither bookings nor finance → no Fees entry.
    const membershipOnly = matrix({ membership: "view" });
    const membershipHrefs = new Set(
      getAdminFeatureSearchIndex(CLUB_DAY, allOn, membershipOnly, false).map(
        (entry) => entry.href,
      ),
    );
    expect(membershipHrefs.has("/admin/fees")).toBe(false);
  });

  it("fails closed: an undefined permission matrix yields an EMPTY index (deny by default)", () => {
    // Defence in depth (#2092): getVisibleAdminNavSections fails OPEN on a
    // missing matrix (its pre-existing, shared contract), but the palette index
    // must NOT — a missing matrix returns nothing rather than every page.
    expect(getAdminFeatureSearchIndex(CLUB_DAY, allOn, undefined, true)).toEqual([]);
    expect(getAdminFeatureSearchIndex(CLUB_DAY, allOn, undefined, false)).toEqual([]);
    // The sidebar seam still fails open, so this is genuinely palette-scoped.
    expect(
      getVisibleAdminNavSections(CLUB_DAY, allOn, undefined, true).length,
    ).toBeGreaterThan(0);
  });

  it("respects module-flag visibility (a disabled module drops its pages)", () => {
    const xeroOff = { ...allOn, xeroIntegration: false } as FeatureFlags;
    const index = getAdminFeatureSearchIndex(CLUB_DAY, xeroOff, fullMatrix, true);
    const hrefs = new Set(index.map((entry) => entry.href));

    expect(hrefs.has("/admin/xero")).toBe(false);
    expect(hrefs).toEqual(visibleHrefs(xeroOff, fullMatrix, true));
  });

  it("indexes AI Diagnostics when its module is on, and drops it when off (#2378)", () => {
    // The nav entry carries no explicit flag of its own — visibility is derived
    // from the href against FEATURE_ROUTE_RULES, where #2378 registered
    // "/admin/ai-diagnostics" under the `aiDiagnostics` rule. This asserts that
    // derivation actually reaches the palette, because the sidebar comment claims
    // it does and a claim about a mechanism two modules away is exactly the kind
    // that quietly stops being true.
    const on = getAdminFeatureSearchIndex(CLUB_DAY, allOn, fullMatrix, true);
    expect(new Set(on.map((entry) => entry.href))).toContain(
      "/admin/ai-diagnostics",
    );

    const diagnosticsOff = { ...allOn, aiDiagnostics: false } as FeatureFlags;
    const off = getAdminFeatureSearchIndex(CLUB_DAY, diagnosticsOff, fullMatrix, true);
    const hrefs = new Set(off.map((entry) => entry.href));

    // Off means GONE from discovery, matching the 404 the route itself returns —
    // a palette entry that navigates to a 404 is worse than no entry.
    expect(hrefs.has("/admin/ai-diagnostics")).toBe(false);
    expect(hrefs).toEqual(visibleHrefs(diagnosticsOff, fullMatrix, true));
    // The help ASSISTANT is a different product on a different flag and must not
    // disappear with it.
    expect(hrefs.has("/admin/ai-assistant")).toBe(true);
  });

  it("drops Lobby Display when its module is disabled", () => {
    const lobbyDisplayOff = {
      ...allOn,
      lobbyDisplay: false,
    } as FeatureFlags;
    const index = getAdminFeatureSearchIndex(
      CLUB_DAY,
      lobbyDisplayOff,
      fullMatrix,
      true,
    );

    expect(index.some((entry) => entry.href === "/admin/display")).toBe(false);
  });
});
