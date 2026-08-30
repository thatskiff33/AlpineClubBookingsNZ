import { describe, expect, it } from "vitest";
import {
  getAdminRouteRequirement,
  type AdminPermissionArea,
} from "@/lib/admin-permissions";
import { FEATURE_ROUTE_RULES } from "@/config/feature-routes";
import {
  adminApiRouteFiles,
  adminPageFiles,
  toRepoRelative,
  toResolverPathname,
} from "@/lib/__tests__/helpers/admin-route-enumeration";

// ---------------------------------------------------------------------------
// Admin route-map drift guard (issue #1322).
//
// Two central maps decide how an admin page or /api/admin route is protected:
//
//   1. Permission-area map — getAdminRouteRequirement() in admin-permissions.ts
//      (backed by ROUTE_AREA_PREFIXES + SPECIAL_ROUTE_AREA_PATTERNS). It maps a
//      pathname to an admin permission area (bookings, finance, membership, …).
//      Its LAST entry, `overview`, uses the prefixes "/admin" and "/api/admin",
//      so it is a CATCH-ALL: every admin route resolves to *something*, and any
//      route that does not match a more specific area silently lands on
//      `overview`. A finance-sensitive route that forgets its "/api/admin/…"
//      prefix would therefore be readable by anyone with plain overview access
//      instead of finance access.
//
//   2. Feature-route map — FEATURE_ROUTE_RULES in config/feature-routes.ts. It
//      gates optional modules (bedAllocation, waitlist, xeroIntegration, …) so
//      an off module 404s both its pages and its API routes.
//
// These tests fail the build when a NEW admin page/route lands in the overview
// catch-all without being intentionally allowlisted, and when a feature-route
// prefix stops matching any real file (a rename silently dropping a gate).
//
// WHAT THIS GUARD DOES AND DOES NOT CATCH
//   Catches:      an UNMAPPED admin route (falls to the overview catch-all).
//   Does NOT catch: a MIS-mapped route that inherits an existing, wrong prefix.
//     e.g. a new finance-only action added under "/api/admin/members/[id]/…"
//     silently inherits the `membership` area and passes here. That is inherent
//     to a prefix map; when adding a sensitive action under an existing prefix,
//     still add a SPECIAL_ROUTE_AREA_PATTERNS entry by hand. The guarantee here
//     is narrower: "nothing lands in the overview catch-all unnoticed."
// ---------------------------------------------------------------------------

/**
 * The enumeration is SHARED (#2975), not walked again here.
 *
 * Three suites needed "every admin page and every `/api/admin` route" and each
 * had written its own walk. The walks were identical; the pathname builders were
 * not — two substituted `x123` for a dynamic segment and this one substituted
 * `sample`. Nothing was broken by that, but `getAdminRouteRequirement` matches by
 * literal prefix as well as by pattern, so the moment a prefix matched one
 * placeholder and not the other, two suites enumerating "the same" tree would
 * resolve different areas and only one of them would go red.
 *
 * Sharing the enumeration costs no independence: the enumeration is not the
 * assertion here — the `overview` catch-all is — and each suite still states its
 * own expectation about the paths it is handed. `helpers/admin-route-enumeration.ts`
 * carries the walk, the placeholder and the reason pages come from EVERY route
 * group rather than only `(admin)`.
 */

type AdminRoute = { file: string; rel: string; pathname: string };

const adminRoutes: AdminRoute[] = [...adminPageFiles, ...adminApiRouteFiles].map(
  (file) => ({
    file,
    rel: toRepoRelative(file),
    pathname: toResolverPathname(file),
  }),
);

// ---------------------------------------------------------------------------
// EXPLICIT overview allowlist.
//
// Small, named, and justified: each route below intentionally resolves to the
// `overview` catch-all and needs no more specific permission area. Keyed by the
// concrete pathname the resolver sees. Adding an entry here is the deliberate
// "this route belongs to overview" escape hatch — see the failure message on
// the coverage test for the three ways to satisfy it.
// ---------------------------------------------------------------------------
const OVERVIEW_ALLOWLIST: Record<string, string> = {
  // The admin landing dashboard. It is the cross-area entry point and is what
  // getFirstAccessibleAdminHref() sends any admin with overview access to;
  // overview (view) is exactly the right requirement.
  "/admin/dashboard":
    "Admin landing dashboard — cross-area entry point; overview view is correct.",
  // Read-only aggregate counts (pending applications, bookings, refunds, …) that
  // drive the sidebar badges. It spans every area by design, so it is gated at
  // the overview level rather than any single area; each underlying detail route
  // enforces its own area on drill-in.
  "/api/admin/pending-counts":
    "Cross-area read-only badge counts for the sidebar; spans all areas, so overview view is correct.",
  // The AI Diagnostics workspace shell (AID-7, #2378). It resolves to `overview`
  // here, and that is the area the SIDEBAR and command palette use for the link —
  // but since #2975 it is no longer what ADMITS the page. Owner decision Q6 and
  // ADR-002 §1 say any admitted administrator may open the workspace, and #2984
  // ended the coincidence that made `overview:view` a fair spelling of that: portal
  // standing became any one of the seven areas, so the shipped Finance Viewer grid
  // is an admitted admin holding no `overview` at all. `canOpenAdminPath` now
  // admits this path on admission (`ANY_ADMIN_ADMISSION_PATHS`), which is the
  // explicit named predicate ADR-002 §1 asks for.
  //
  // The shell still exposes nothing: every tool invocation re-derives the acting
  // admin's areas server-side, the readiness panel on this page is tiered on
  // `support:view`, and the budget card refuses without it. Gating the shell would
  // hide the "who can fix this" message from exactly the admins who need to read it.
  "/admin/ai-diagnostics":
    "AI Diagnostics workspace shell; admitted on ADMISSION rather than on this area (ADR-002 §1) and per-tool area checks gate every read, so landing on overview here is correct and harmless.",
};

// State-changing GET endpoints (EDIT_ON_GET_PREFIXES in admin-permissions.ts).
// These are OAuth browser-redirect handlers exported as GET but which mutate
// server state (token exchange / connection start), so they must demand `edit`
// even though GET normally maps to `view`. Enumerated here so a new
// side-effecting GET is a conscious, reviewed addition.
const STATE_CHANGING_GET_ROUTES = [
  "/api/admin/xero/callback",
  "/api/admin/xero/connect",
] as const;

describe("admin route-map drift guard (#1322)", () => {
  it("finds admin pages and API routes to enumerate", () => {
    // Sanity floor so a broken walk (wrong dir, zero matches) can never make
    // the coverage assertions vacuously pass.
    expect(adminPageFiles.length).toBeGreaterThan(40);
    expect(adminApiRouteFiles.length).toBeGreaterThan(100);
  });

  it("maps every admin page and /api/admin route to a specific area or an allowlisted overview route", () => {
    const violations = adminRoutes.flatMap(({ rel, pathname }) => {
      const requirement = getAdminRouteRequirement(pathname, "GET");

      // The overview catch-all means this is only null if a future change
      // removes it; treat that as a hard failure too.
      if (!requirement) {
        return [`${rel} (${pathname}): resolves to NO admin requirement`];
      }

      const area: AdminPermissionArea = requirement.area;
      const allowlisted = pathname in OVERVIEW_ALLOWLIST;

      if (area === "overview" && !allowlisted) {
        return [
          `${rel} (${pathname}): lands on the overview catch-all. Fix one of:\n` +
            `    - add its prefix to ROUTE_AREA_PREFIXES for the correct area (admin-permissions.ts), or\n` +
            `    - add a SPECIAL_ROUTE_AREA_PATTERNS entry if it needs a different area than its prefix, or\n` +
            `    - add it to OVERVIEW_ALLOWLIST in this test with a one-line justification.`,
        ];
      }

      return [];
    });

    expect(violations).toEqual([]);
  });

  it("keeps the overview allowlist free of stale or over-scoped entries", () => {
    const onDisk = new Set(adminRoutes.map((r) => r.pathname));

    const violations = Object.keys(OVERVIEW_ALLOWLIST).flatMap((pathname) => {
      if (!onDisk.has(pathname)) {
        return [
          `${pathname}: allowlisted route no longer exists on disk — remove the entry.`,
        ];
      }
      const requirement = getAdminRouteRequirement(pathname, "GET");
      if (requirement && requirement.area !== "overview") {
        return [
          `${pathname}: now resolves to "${requirement.area}", not overview — remove the (redundant) allowlist entry.`,
        ];
      }
      return [];
    });

    expect(violations).toEqual([]);
  });

  it("forces edit access on the enumerated state-changing GET endpoints", () => {
    const violations = STATE_CHANGING_GET_ROUTES.flatMap((pathname) => {
      const requirement = getAdminRouteRequirement(pathname, "GET");
      if (!requirement) {
        return [`${pathname}: expected an admin requirement, got none`];
      }
      return requirement.level === "edit"
        ? []
        : [
            `${pathname}: side-effecting GET must require edit, got "${requirement.level}"`,
          ];
    });

    // Every enumerated route must exist on disk so the list cannot rot.
    const onDisk = new Set(adminRoutes.map((r) => r.pathname));
    for (const pathname of STATE_CHANGING_GET_ROUTES) {
      if (!onDisk.has(pathname)) {
        violations.push(`${pathname}: enumerated route file is missing`);
      }
    }

    expect(violations).toEqual([]);
  });

  it("keeps every admin feature-route prefix pointing at at least one real file", () => {
    // A feature-route prefix that no longer matches any file is a silent gate
    // drop: the module toggle stops covering the renamed/moved route. Only the
    // admin-scoped prefixes are checked here (the non-admin surface is out of
    // this test's enumeration scope and covered by feature-routes.test.ts).
    const adminPathnames = adminRoutes.map((r) => r.pathname);
    const isAdminPrefix = (prefix: string) =>
      prefix.startsWith("/admin/") ||
      prefix === "/admin" ||
      prefix.startsWith("/api/admin/") ||
      prefix === "/api/admin";

    const violations = FEATURE_ROUTE_RULES.flatMap((rule) =>
      (rule.prefixes ?? []).filter(isAdminPrefix).flatMap((prefix) => {
        const matched = adminPathnames.some(
          (pathname) =>
            pathname === prefix || pathname.startsWith(`${prefix}/`),
        );
        return matched
          ? []
          : [
              `feature "${rule.flag}" prefix "${prefix}" matches no admin page/route — a rename likely dropped its gate.`,
            ];
      }),
    );

    expect(violations).toEqual([]);
  });
});
