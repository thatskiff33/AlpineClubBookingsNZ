/**
 * AID-4 (#2373) — registry CONTRACT tests.
 *
 * These are drift guards, not behaviour tests. Each one pins a property that,
 * if it broke, would silently widen what the Diagnostics page context can read:
 * a row gated below the admin route lattice, a duplicate key, an unbounded
 * allowlist, or a status vocabulary that no longer matches the database.
 */

import fs from "node:fs";
import path from "node:path";

import { BookingStatus, PaymentStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  ADMIN_PERMISSION_AREAS,
  getAdminRouteRequirement,
} from "@/lib/admin-permissions";
import type { StuckStateSeverity } from "@/lib/stuck-state-dashboard";

import { stripComments } from "@/lib/__tests__/support/strip-comments";

import {
  DIAGNOSTICS_PAGE_CONTEXT_ROUTES,
  DIAGNOSTICS_PAGE_ERROR_CODES,
  getDiagnosticsPageContextRoute,
} from "../registry";
import {
  DIAGNOSTICS_PAGE_CONTEXT_BOUNDS,
  DIAGNOSTICS_RECORD_KINDS,
} from "../types";

const AREA_KEYS = ADMIN_PERMISSION_AREAS.map((area) => area.key);

/** `/admin/members/[id]` -> a concrete path the route lattice can resolve. */
function concretePath(pathname: string): string {
  return pathname.replace(/\[[^\]]+\]/g, "sample-id");
}

describe("registry shape", () => {
  it("registers at least one route and no duplicate keys or pathnames", () => {
    expect(DIAGNOSTICS_PAGE_CONTEXT_ROUTES.length).toBeGreaterThan(0);
    const keys = DIAGNOSTICS_PAGE_CONTEXT_ROUTES.map((r) => r.key);
    const paths = DIAGNOSTICS_PAGE_CONTEXT_ROUTES.map((r) => r.pathname);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("looks a route up by exact key only — no prefix or fallback matching", () => {
    const first = DIAGNOSTICS_PAGE_CONTEXT_ROUTES[0];
    expect(getDiagnosticsPageContextRoute(first.key)).toBe(first);
    expect(getDiagnosticsPageContextRoute(`${first.key}x`)).toBeUndefined();
    expect(
      getDiagnosticsPageContextRoute(first.key.slice(0, -1)),
    ).toBeUndefined();
    expect(getDiagnosticsPageContextRoute("")).toBeUndefined();
    expect(getDiagnosticsPageContextRoute("__proto__")).toBeUndefined();
  });

  it("gives every route a non-empty area list drawn from the real lattice", () => {
    for (const entry of DIAGNOSTICS_PAGE_CONTEXT_ROUTES) {
      expect(entry.requiredAreas.length).toBeGreaterThan(0);
      for (const area of entry.requiredAreas) {
        expect(AREA_KEYS).toContain(area);
      }
      expect(new Set(entry.requiredAreas).size).toBe(
        entry.requiredAreas.length,
      );
    }
  });

  it("declares only server-owned record kinds", () => {
    for (const entry of DIAGNOSTICS_PAGE_CONTEXT_ROUTES) {
      if (entry.recordKind !== null) {
        expect(DIAGNOSTICS_RECORD_KINDS).toContain(entry.recordKind);
      }
    }
  });

  it("keeps every route key and token inside the selector's own bounds", () => {
    for (const entry of DIAGNOSTICS_PAGE_CONTEXT_ROUTES) {
      expect(entry.key.length).toBeLessThanOrEqual(
        DIAGNOSTICS_PAGE_CONTEXT_BOUNDS.routeKeyMaxChars,
      );
      expect(entry.key).toMatch(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/);
      for (const token of [
        ...entry.tabs,
        ...entry.steps,
        ...entry.statuses,
        ...entry.errorCodes,
      ]) {
        expect(token.length).toBeLessThanOrEqual(
          DIAGNOSTICS_PAGE_CONTEXT_BOUNDS.tokenMaxChars,
        );
        expect(token).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
      }
      for (const key of entry.filterKeys) {
        expect(key.length).toBeLessThanOrEqual(
          DIAGNOSTICS_PAGE_CONTEXT_BOUNDS.filterKeyMaxChars,
        );
        expect(key).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
      }
      expect(entry.filterKeys.length).toBeLessThanOrEqual(
        DIAGNOSTICS_PAGE_CONTEXT_BOUNDS.maxFilters,
      );
    }
  });
});

describe("no route is gated below the admin route lattice", () => {
  // The property that matters: page context can never be a side channel around
  // the permission the admin UI itself enforces for the same page.
  it.each(DIAGNOSTICS_PAGE_CONTEXT_ROUTES.map((r) => [r.key, r] as const))(
    "%s requires the lattice's own area for its pathname",
    (_key, entry) => {
      const requirement = getAdminRouteRequirement(
        concretePath(entry.pathname),
        "GET",
      );
      expect(requirement).not.toBeNull();
      expect(requirement?.level).toBe("view");
      expect(entry.requiredAreas).toContain(requirement?.area);
    },
  );

  // A `steps` token names a SUB-PAGE of `pathname` here (the guided-setup wizard
  // links out to one route per step), and the guard above only ever resolves the
  // parent path. `/admin/setup/finance` is gated on `finance` while its parent is
  // gated on `support`, so without this a support-only row could allowlist a step
  // naming a page the lattice redirects that admin away from — and the first
  // step-scoped fact anyone adds would leak across the gate.
  it("covers each step's own sub-path requirement too", () => {
    const stepped = DIAGNOSTICS_PAGE_CONTEXT_ROUTES.filter(
      (entry) => entry.steps.length > 0,
    );
    expect(stepped.length).toBeGreaterThan(0);
    for (const entry of stepped) {
      for (const step of entry.steps) {
        const requirement = getAdminRouteRequirement(
          `${concretePath(entry.pathname)}/${step}`,
          "GET",
        );
        // An in-page step resolves to the parent's own requirement via prefix
        // matching, so a null here would mean the path is unregistered entirely.
        expect(requirement).not.toBeNull();
        expect(entry.requiredAreas).toContain(requirement?.area);
      }
    }
  });
});

describe("status vocabularies track the database", () => {
  const tokenize = (value: string) => value.toLowerCase().replace(/_/g, "-");

  it("uses exactly the BookingStatus enum wherever booking statuses appear", () => {
    const expected = Object.values(BookingStatus).map(tokenize).sort();
    const bookingRoutes = DIAGNOSTICS_PAGE_CONTEXT_ROUTES.filter(
      (entry) => entry.recordKind === "booking" && entry.statuses.length > 0,
    );
    expect(bookingRoutes.length).toBeGreaterThan(0);
    for (const entry of bookingRoutes) {
      expect([...entry.statuses].sort()).toEqual(expected);
    }
  });

  it("uses exactly the PaymentStatus enum wherever payment statuses appear", () => {
    const expected = Object.values(PaymentStatus).map(tokenize).sort();
    const paymentRoutes = DIAGNOSTICS_PAGE_CONTEXT_ROUTES.filter(
      (entry) => entry.recordKind === "payment" && entry.statuses.length > 0,
    );
    expect(paymentRoutes.length).toBeGreaterThan(0);
    for (const entry of paymentRoutes) {
      expect([...entry.statuses].sort()).toEqual(expected);
    }
  });
});

describe("the stuck-state severity vocabulary tracks its union", () => {
  // `StuckStateSeverity` is a hand-written TS union, so there is no runtime enum
  // to compare against the way BookingStatus/PaymentStatus are compared above.
  // `satisfies` in the registry pins the forward direction (no token that is not a
  // severity); this pins the reverse (no severity missing from the tokens). The
  // Record literal is what makes it work: adding a fourth severity fails to
  // typecheck here until it is listed, and then fails the assertion until it is
  // added to the registry.
  const EVERY_SEVERITY: Record<StuckStateSeverity, true> = {
    critical: true,
    warning: true,
    info: true,
  };

  it("allowlists exactly the severities the dashboard can produce", () => {
    // Looked up by key rather than filtered by shape: severities belong to this
    // one dashboard, and a shape filter would silently start policing a future
    // route that happens to carry some other status vocabulary.
    const dashboard = getDiagnosticsPageContextRoute("admin.stuck-states");
    expect(dashboard).toBeDefined();
    expect([...(dashboard?.statuses ?? [])].sort()).toEqual(
      Object.keys(EVERY_SEVERITY).sort(),
    );
  });
});

describe("cross-area coverage", () => {
  it("keeps at least one genuinely cross-area (AND) route registered", () => {
    // Bed allocation reads bookings AND the lodge's own bed structure. If this
    // ever drops to zero the AND path stops being exercised by anything real.
    const crossArea = DIAGNOSTICS_PAGE_CONTEXT_ROUTES.filter(
      (entry) => entry.requiredAreas.length > 1,
    );
    expect(crossArea.length).toBeGreaterThan(0);
  });
});

describe("error codes", () => {
  it("shares one closed, transport-level vocabulary", () => {
    expect(new Set(DIAGNOSTICS_PAGE_ERROR_CODES).size).toBe(
      DIAGNOSTICS_PAGE_ERROR_CODES.length,
    );
    for (const entry of DIAGNOSTICS_PAGE_CONTEXT_ROUTES) {
      for (const code of entry.errorCodes) {
        expect(DIAGNOSTICS_PAGE_ERROR_CODES).toContain(code);
      }
    }
  });
});

describe("every registry pathname is a page an operator can stand on (#2812)", () => {
  /**
   * The general form of #2812's bug: `admin.booking-approvals` named a pathname
   * whose page.tsx was a fifteen-line redirect() shim, so the row could never
   * match a live page — Diagnostics silently had no context on the approvals
   * queue, the one place "why will this booking not confirm?" is most asked.
   * The docs said the row was reachable; the coverage matrix said the route was
   * a redirect; both were in-tree at once.
   *
   * So: each row's canonical pathname must map to a real page.tsx under the
   * (admin) group, and that page must RENDER — a page whose source never
   * returns JSX but does call redirect() is a shim, and a registry row naming
   * one is dead on arrival. Pages that redirect CONDITIONALLY (a guard bounce
   * before `return (`) pass, because they render for the admitted case.
   */
  it("maps every row to a rendering page.tsx, never a redirect-only shim", () => {
    const appAdminRoot = path.join(process.cwd(), "src/app/(admin)");
    for (const row of DIAGNOSTICS_PAGE_CONTEXT_ROUTES) {
      const pagePath = path.join(
        appAdminRoot,
        ...row.pathname.split("/").filter(Boolean),
        "page.tsx",
      );
      expect(
        fs.existsSync(pagePath),
        `${row.key} names ${row.pathname}, but ${pagePath} does not exist — the row can never match a live page`,
      ).toBe(true);

      // FAIL-CLOSED: every registered page must visibly render JSX. The first
      // cut keyed on `redirect(` instead — "shim = calls redirect and never
      // returns JSX" — and both review lenses broke it the same way: a shim
      // using `permanentRedirect(` (capital R, never matched), `notFound()`, or
      // a bare `return null` sailed through, and a helper function's `return (`
      // anywhere in the file satisfied the JSX half. Comments are stripped and
      // the requirement is a return whose expression OPENS AS JSX, which every
      // current registry page satisfies; a legitimate page that renders through
      // a helper call would fail here loudly and be adjudicated on purpose,
      // which is the posture every census in this repo takes.
      const source = stripComments(fs.readFileSync(pagePath, "utf8"));
      const rendersJsx = /return\s*\(?\s*</.test(source);
      expect(
        rendersJsx,
        `${row.key} names ${row.pathname}, whose page.tsx never returns JSX — a redirect/notFound shim or null-only page no operator is ever on (#2812's bug, generalised)`,
      ).toBe(true);
    }
  });
});
