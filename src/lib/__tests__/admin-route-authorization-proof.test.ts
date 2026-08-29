/**
 * THE ADMIN AUTHORIZATION PROOF: real routes, real path-to-permission map, real
 * guards (#2975, shipping with the #2984 privilege-model correction).
 *
 * ## What was already proved, and what nothing proved
 *
 * Three guards already stand between an access-role grid and an admin screen,
 * and each of them was already tested — separately:
 *
 *   - `api-route-boundaries.test.ts` proves every `/api/admin` route REACHES an
 *     admission guard (directly or through an allowlisted wrapper).
 *   - `admin-route-map-drift.test.ts` proves no admin route silently lands in
 *     the `overview` catch-all, and `admin-route-area-matrix.test.ts` pins the
 *     complete `/api/admin` route-to-area assignment against a reviewed
 *     snapshot.
 *   - `admin-permissions.test.ts` proves the matrix helpers compute what they
 *     claim to compute.
 *
 * NONE OF THAT IS THE SAME AS THE GUARD ACTUALLY ENFORCING THE MAP. Every one
 * of the sixty-odd per-route suites mocks `@/lib/session-guards`, so it asserts
 * nothing whatever about `requireAdmin`; the map tests never invoke a guard;
 * and the helper tests never see a route. Between them sat the question nobody
 * was asking: given a real admin path and a real access-role grid, does the
 * software that runs on every request admit or refuse? One endpoint answered it
 * (`admin-lodges-access-gate.test.ts`, #2925, written after a mocked suite
 * passed 17/17 against a route that still returned the 403 it existed to
 * remove). This file answers it for the whole tree.
 *
 * ## How it is arranged, and why each part cannot be satisfied vacuously
 *
 *   1. ENUMERATION. Every admin page and every `/api/admin` route is discovered
 *      from disk, never listed here, with a floor assertion so a broken walk
 *      cannot make the sweeps below pass by covering nothing.
 *
 *   2. SWEEPS. Every discovered path is put to the REAL `requireAdmin` (API)
 *      and the REAL `guardAdminLayout` (pages), for sixteen access-role grids,
 *      through the same `x-pathname` / `x-request-method` headers `src/proxy.ts`
 *      stamps on the real request. This is what proves the guard consults the
 *      map at all, that no route is open to everyone or shut to everyone, and
 *      that `view` does not buy `edit`.
 *
 *      The sweeps compute what they expect FROM the map, so they are honest
 *      about their own limit: they cannot catch a map that is wrong. That is
 *      what (3) is for, and separating the two is deliberate — a single test
 *      that derived its expectation from the thing under test would look like
 *      proof and be a tautology.
 *
 *   3. ANCHORS. A small, human-reviewed table naming which area a handful of
 *      unmistakable routes belong to, asserted through the real guards: the
 *      area's holder is admitted, and every other single-area holder is
 *      refused. It is written down BECAUSE it must not be derived — it is the
 *      independent statement a seeded wrong mapping contradicts. It is
 *      drift-guarded: every path in it must exist in the enumeration, so it
 *      cannot rot into a list of routes that no longer exist.
 *
 *   4. #2984. Finance-only standing, proved the way the issue asks for it — by
 *      attempting every other admin page and API route as that user and being
 *      refused, not by reading the matrix back.
 *
 * ## Reading a failure here
 *
 * Every message names the grid, the path, the method and the expectation, so a
 * red test tells you which authorization rule broke rather than that something
 * did. If this file goes red on a change to `ROUTE_AREA_PREFIXES`, the question
 * to ask is whether the ROUTE moved area on purpose — the answer is usually no.
 */
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  memberFindUnique: vi.fn(),
  recordAuthBounce: vi.fn(),
  requestHeaders: new Headers(),
}));

vi.mock("next/headers", () => ({
  headers: async () => mocks.requestHeaders,
}));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/prisma", () => ({
  prisma: { member: { findUnique: mocks.memberFindUnique } },
}));
vi.mock("@/lib/auth-diagnostics", () => ({
  recordAuthBounce: mocks.recordAuthBounce,
}));
vi.mock("server-only", () => ({}));

import {
  ADMIN_PERMISSION_AREAS,
  getAdminRouteRequirement,
  hasAdminAreaAccess,
  hasAdminPortalAccess,
  isConsolidatedFeesPath,
  type AdminPermissionArea,
} from "@/lib/admin-permissions";
import { guardAdminLayout } from "@/lib/admin-layout-guard";
import { requireAdmin } from "@/lib/session-guards";

// ---------------------------------------------------------------------------
// 1. ENUMERATION — discovered, never written down.
// ---------------------------------------------------------------------------

const APP_DIR = path.join(process.cwd(), "src/app");

function walkFiles(dir: string, leaf: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkFiles(entryPath, leaf);
    return entry.name === leaf ? [entryPath] : [];
  });
}

/**
 * App-router file path to the pathname the route map resolves. Route groups are
 * stripped and dynamic segments substituted with a concrete literal, so prefix
 * and `[^/]+` pattern matching behaves as it does for a real request.
 */
function toPathname(absFile: string): string {
  const rel = path.relative(APP_DIR, absFile);
  const parts = rel.split(path.sep);
  parts.pop();
  const segments = parts
    .filter((seg) => !(seg.startsWith("(") && seg.endsWith(")")))
    .map((seg) => (/^\[.*\]$/.test(seg) ? "x123" : seg));
  return `/${segments.join("/")}`;
}

/**
 * Admin pages from EVERY route group, not just `(admin)`. A route group is a
 * rendering concern and this is a permissions concern; tying the second to the
 * first is how `admin-route-map-drift.test.ts` briefly went silent for a page
 * that moved into a group of its own.
 */
const adminPagePaths = Array.from(
  new Set(
    fs
      .readdirSync(APP_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("("))
      .flatMap((group) =>
        walkFiles(path.join(APP_DIR, group.name, "admin"), "page.tsx"),
      )
      .map(toPathname),
  ),
).sort();

const adminApiPaths = Array.from(
  new Set(
    walkFiles(path.join(APP_DIR, "api/admin"), "route.ts").map(toPathname),
  ),
).sort();

const allAdminPaths = new Set([...adminPagePaths, ...adminApiPaths]);

// ---------------------------------------------------------------------------
// GRIDS. Built from explicit per-area levels rather than from the shipped
// bundles, so an edit to a bundle cannot quietly change what this file proves.
// ---------------------------------------------------------------------------

type Level = "NONE" | "VIEW" | "EDIT";

type Definition = Record<string, Level | string>;

function definitionFor(levels: Partial<Record<string, Level>>): Definition {
  return {
    id: "ardef_proof",
    overviewLevel: "NONE",
    bookingsLevel: "NONE",
    membershipLevel: "NONE",
    financeLevel: "NONE",
    lodgeLevel: "NONE",
    contentLevel: "NONE",
    supportLevel: "NONE",
    ...levels,
  };
}

type Grid = {
  label: string;
  /** The shape both guards read off the mocked `member` row. */
  member: {
    id: string;
    role: "ADMIN" | "USER";
    active: boolean;
    canLogin: boolean;
    forcePasswordChange: boolean;
    twoFactorEnabled: boolean;
    accessRoles: Array<{
      role: string | null;
      roleDefinitionId: string | null;
      roleDefinition: Definition | null;
    }>;
  };
};

function customGrid(
  label: string,
  levels: Partial<Record<string, Level>>,
): Grid {
  return {
    label,
    member: {
      id: "member-1",
      role: "USER",
      active: true,
      canLogin: true,
      forcePasswordChange: false,
      twoFactorEnabled: false,
      accessRoles: [
        {
          role: null,
          roleDefinitionId: "ardef_proof",
          roleDefinition: definitionFor(levels),
        },
      ],
    },
  };
}

const FULL_ADMIN: Grid = {
  label: "Full Admin",
  member: {
    id: "member-1",
    role: "ADMIN",
    active: true,
    canLogin: true,
    forcePasswordChange: false,
    twoFactorEnabled: false,
    accessRoles: [
      { role: "ADMIN", roleDefinitionId: null, roleDefinition: null },
    ],
  },
};

const PLAIN_MEMBER: Grid = {
  label: "plain member",
  member: {
    id: "member-1",
    role: "USER",
    active: true,
    canLogin: true,
    forcePasswordChange: false,
    twoFactorEnabled: false,
    accessRoles: [
      { role: "USER", roleDefinitionId: null, roleDefinition: null },
    ],
  },
};

const AREAS: AdminPermissionArea[] = ADMIN_PERMISSION_AREAS.map(
  (area) => area.key,
);

/** One grid per area at `view`, and one per area at `edit`. */
const AREA_GRIDS: Array<{
  area: AdminPermissionArea;
  level: "view" | "edit";
  grid: Grid;
}> = AREAS.flatMap((area) =>
  (["view", "edit"] as const).map((level) => ({
    area,
    level,
    grid: customGrid(`${area}:${level} only`, {
      [`${area}Level`]: level === "view" ? "VIEW" : "EDIT",
    }),
  })),
);

const SWEEP_GRIDS: Grid[] = [
  FULL_ADMIN,
  PLAIN_MEMBER,
  ...AREA_GRIDS.map((entry) => entry.grid),
];

/** The single-area VIEW grid for an area, used by the anchor table. */
function viewGridFor(area: AdminPermissionArea): Grid {
  const found = AREA_GRIDS.find(
    (entry) => entry.area === area && entry.level === "view",
  );
  if (!found) throw new Error(`no view grid for ${area}`);
  return found.grid;
}

const FINANCE_ONLY = viewGridFor("finance");

// ---------------------------------------------------------------------------
// DRIVING THE REAL GUARDS.
// ---------------------------------------------------------------------------

function signIn(grid: Grid) {
  mocks.auth.mockResolvedValue({
    user: {
      id: grid.member.id,
      name: grid.label,
      email: "admin@example.com",
      role: grid.member.role,
      accessRoles: grid.member.accessRoles
        .map((row) => row.role)
        .filter((role): role is string => role !== null),
    },
  });
  mocks.memberFindUnique.mockResolvedValue(grid.member);
}

function setRequest(pathname: string, method: string) {
  mocks.requestHeaders = new Headers({
    "x-pathname": pathname,
    "x-request-method": method,
  });
}

/** Did the REAL `requireAdmin` admit this grid on this request? */
async function apiAdmits(
  grid: Grid,
  pathname: string,
  method: string,
): Promise<{ ok: boolean; status: number | null }> {
  signIn(grid);
  setRequest(pathname, method);
  const result = await requireAdmin();
  return { ok: result.ok, status: result.ok ? null : result.response.status };
}

/** Did the REAL `guardAdminLayout` admit this grid on this page? */
async function pageAdmits(
  grid: Grid,
  pathname: string,
): Promise<{ ok: boolean; destination: string | null }> {
  signIn(grid);
  setRequest(pathname, "GET");
  const result = await guardAdminLayout();
  return {
    ok: result.outcome === "admitted",
    destination: result.outcome === "redirect" ? result.destination : null,
  };
}

/**
 * What the map says this request needs. `guardAdminLayout` treats an unmapped
 * admin path as `overview: view`; the `overview` catch-all means that branch is
 * unreachable today, and `admin-route-map-drift.test.ts` fails if it stops
 * being.
 */
function requirementFor(pathname: string, method: string) {
  return (
    getAdminRouteRequirement(pathname, method) ?? {
      area: "overview" as const,
      level: "view" as const,
    }
  );
}

/** The map's answer, plus the one adjudicated OR rule (#1933, the fee console). */
function mapAdmits(grid: Grid, pathname: string, method: string): boolean {
  if (isConsolidatedFeesPath(pathname)) {
    return (
      hasAdminAreaAccess(grid.member, { area: "bookings", level: "view" }) ||
      hasAdminAreaAccess(grid.member, { area: "finance", level: "view" })
    );
  }
  return hasAdminAreaAccess(grid.member, requirementFor(pathname, method));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.recordAuthBounce.mockResolvedValue(null);
});

// ---------------------------------------------------------------------------

describe("the admin route tree this proof runs over", () => {
  it("discovers enough admin pages and API routes to be worth sweeping", () => {
    // A floor, not a target. Without it a walk pointed at the wrong directory
    // makes every sweep below pass by asserting nothing.
    expect(adminPagePaths.length).toBeGreaterThan(80);
    expect(adminApiPaths.length).toBeGreaterThan(200);
  });

  it("resolves every discovered path through the real route map", () => {
    const unresolved = [...allAdminPaths].filter(
      (pathname) => getAdminRouteRequirement(pathname, "GET") === null,
    );
    expect(unresolved).toEqual([]);
  });
});

describe("the real requireAdmin enforces the real route map on every /api/admin route", () => {
  it.each(["GET", "POST"])(
    "admits exactly the grids the map admits (%s)",
    async (method) => {
      const violations: string[] = [];
      for (const pathname of adminApiPaths) {
        const requirement = requirementFor(pathname, method);
        for (const grid of SWEEP_GRIDS) {
          const expected = mapAdmits(grid, pathname, method);
          const actual = await apiAdmits(grid, pathname, method);
          if (actual.ok !== expected) {
            violations.push(
              `${method} ${pathname} needs ${requirement.area}:${requirement.level} — ` +
                `"${grid.label}" should have been ${expected ? "ADMITTED" : "REFUSED"} ` +
                `but requireAdmin ${actual.ok ? "admitted" : `refused (${actual.status})`}`,
            );
          }
        }
      }
      expect(violations).toEqual([]);
    },
    120_000,
  );

  it("refuses a plain member every single admin API route", async () => {
    const wrong: string[] = [];
    for (const pathname of adminApiPaths) {
      for (const method of ["GET", "POST"]) {
        const result = await apiAdmits(PLAIN_MEMBER, pathname, method);
        if (result.ok) wrong.push(`admitted: ${method} ${pathname}`);
        else if (result.status !== 403) {
          wrong.push(
            `${method} ${pathname} refused with ${result.status}, expected 403`,
          );
        }
      }
    }
    expect(wrong).toEqual([]);
  }, 120_000);

  it("refuses a deactivated Full Admin every single admin API route", async () => {
    // The account check sits ahead of the permission check, so this sweep is
    // also what proves the preamble's ORDER survives on every route.
    const deactivated: Grid = {
      label: "deactivated Full Admin",
      member: { ...FULL_ADMIN.member, active: false },
    };
    const wrong: string[] = [];
    for (const pathname of adminApiPaths) {
      const result = await apiAdmits(deactivated, pathname, "GET");
      if (result.ok) wrong.push(`admitted: GET ${pathname}`);
    }
    expect(wrong).toEqual([]);
  }, 120_000);

  it("never lets a view-level grid through a write on its own area", async () => {
    const violations: string[] = [];
    for (const pathname of adminApiPaths) {
      const requirement = requirementFor(pathname, "POST");
      if (requirement.level !== "edit") continue;
      const grid = viewGridFor(requirement.area);
      const result = await apiAdmits(grid, pathname, "POST");
      if (result.ok) {
        violations.push(
          `POST ${pathname} needs ${requirement.area}:edit but "${grid.label}" was admitted`,
        );
      }
    }
    expect(violations).toEqual([]);
    // Non-vacuous: writes exist, and they were all checked.
    expect(
      adminApiPaths.filter(
        (pathname) => requirementFor(pathname, "POST").level === "edit",
      ).length,
    ).toBeGreaterThan(200);
  }, 120_000);
});

describe("the real guardAdminLayout enforces the real route map on every admin page", () => {
  it("admits exactly the grids the map admits", async () => {
    const violations: string[] = [];
    for (const pathname of adminPagePaths) {
      const requirement = requirementFor(pathname, "GET");
      for (const grid of SWEEP_GRIDS) {
        const expected = mapAdmits(grid, pathname, "GET");
        const actual = await pageAdmits(grid, pathname);
        if (actual.ok !== expected) {
          violations.push(
            `${pathname} needs ${requirement.area}:${requirement.level} — ` +
              `"${grid.label}" should have been ${expected ? "ADMITTED" : "REFUSED"} ` +
              `but the layout guard ${
                actual.ok ? "admitted" : `redirected to ${actual.destination}`
              }`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  }, 120_000);

  it("sends a refused administrator somewhere they may actually go", async () => {
    // A refusal that redirects to a page the same grid is also refused is a
    // redirect loop in a browser, and portal standing without `overview`
    // (#2984) is exactly the shape that produces one.
    const violations: string[] = [];
    for (const pathname of adminPagePaths) {
      for (const { grid } of AREA_GRIDS) {
        const result = await pageAdmits(grid, pathname);
        if (result.ok || result.destination === null) continue;
        if (!result.destination.startsWith("/admin")) continue;
        const onward = await pageAdmits(grid, result.destination);
        if (!onward.ok) {
          violations.push(
            `"${grid.label}" refused ${pathname} and was sent to ` +
              `${result.destination}, which refuses them too`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 3. ANCHORS — the independent statement a seeded wrong mapping contradicts.
//
// WRITTEN DOWN ON PURPOSE. Everything above computes what it expects from
// `getAdminRouteRequirement`, so a change that moved `/admin/members` into the
// finance area would keep all of it green: the guard would faithfully enforce
// the new, wrong answer. This table is the second opinion. Each entry says
// which area a route unmistakably belongs to, in a human's words, and the
// assertions below drive the REAL guards against it.
//
// Keep it small and keep it obvious. It is not a route inventory — the
// enumeration above is — and an entry only earns its place if a reviewer would
// recognise the pairing on sight.
// ---------------------------------------------------------------------------

const AREA_ANCHORS: Record<AdminPermissionArea, string[]> = {
  overview: ["/admin/dashboard", "/api/admin/pending-counts"],
  bookings: [
    "/admin/bookings",
    "/admin/waitlist",
    "/admin/booking-requests",
    "/api/admin/bookings",
    "/api/admin/waitlist",
  ],
  membership: [
    "/admin/members",
    "/admin/member-applications",
    "/admin/family-groups",
    "/api/admin/members",
    "/api/admin/family-groups",
  ],
  finance: [
    "/admin/payments",
    "/admin/reports",
    "/admin/subscriptions",
    "/api/admin/payments",
    "/api/admin/subscriptions",
  ],
  lodge: [
    "/admin/hut-leaders",
    "/admin/roster",
    "/admin/work-parties",
    "/api/admin/hut-leaders",
    "/api/admin/roster/status",
    "/api/admin/work-parties",
  ],
  content: [
    "/admin/page-content",
    "/admin/site-banners",
    "/admin/site-content",
    "/api/admin/page-content",
    "/api/admin/site-banners",
  ],
  support: [
    "/admin/access-roles",
    "/admin/modules",
    "/admin/health",
    "/api/admin/access-roles",
    "/api/admin/modules",
  ],
};

describe("the reviewed route-to-area anchors, enforced through the real guards", () => {
  const anchorEntries = (
    Object.entries(AREA_ANCHORS) as Array<[AdminPermissionArea, string[]]>
  ).flatMap(([area, paths]) => paths.map((pathname) => ({ area, pathname })));

  it("names only routes that exist, so the table cannot rot", () => {
    const missing = anchorEntries
      .filter(({ pathname }) => !allAdminPaths.has(pathname))
      .map(({ pathname }) => pathname);
    expect(missing).toEqual([]);
    expect(anchorEntries.length).toBeGreaterThan(25);
  });

  it("admits the area's own holder and refuses every other area's", async () => {
    const violations: string[] = [];
    for (const { area, pathname } of anchorEntries) {
      const isPage = adminPagePaths.includes(pathname);
      for (const other of AREAS) {
        const grid = viewGridFor(other);
        const result = isPage
          ? await pageAdmits(grid, pathname)
          : await apiAdmits(grid, pathname, "GET");
        const shouldPass = other === area;
        if (result.ok !== shouldPass) {
          violations.push(
            `${pathname} is a ${area} route: "${other}:view only" should have been ` +
              `${shouldPass ? "ADMITTED" : "REFUSED"} and was ` +
              `${result.ok ? "admitted" : "refused"}`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  }, 120_000);

  it("admits a Full Admin to every anchor", async () => {
    const refused: string[] = [];
    for (const { pathname } of anchorEntries) {
      const isPage = adminPagePaths.includes(pathname);
      const result = isPage
        ? await pageAdmits(FULL_ADMIN, pathname)
        : await apiAdmits(FULL_ADMIN, pathname, "GET");
      if (!result.ok) refused.push(pathname);
    }
    expect(refused).toEqual([]);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 4. #2984 — finance-only standing, proved by attempt.
// ---------------------------------------------------------------------------

function financePathsOf(paths: string[]) {
  return paths.filter(
    (pathname) =>
      requirementFor(pathname, "GET").area === "finance" ||
      isConsolidatedFeesPath(pathname),
  );
}

describe("#2984: finance-only standing grants Finance and nothing else", () => {
  it("has portal standing, which no plain member has", () => {
    expect(hasAdminPortalAccess(FINANCE_ONLY.member)).toBe(true);
    expect(hasAdminPortalAccess(PLAIN_MEMBER.member)).toBe(false);
    // Every other single-area grid too — the correction is per area, not a
    // finance carve-out.
    for (const area of AREAS) {
      expect(
        hasAdminPortalAccess(viewGridFor(area).member),
        `${area}:view only must have portal standing`,
      ).toBe(true);
    }
  });

  it("enters every finance admin page", async () => {
    const financePages = financePathsOf(adminPagePaths);
    expect(financePages.length).toBeGreaterThan(8);
    const refused: string[] = [];
    for (const pathname of financePages) {
      const result = await pageAdmits(FINANCE_ONLY, pathname);
      if (!result.ok) refused.push(pathname);
    }
    expect(refused).toEqual([]);
  }, 120_000);

  it("is refused EVERY admin page outside finance, by attempt", async () => {
    const financePages = new Set(financePathsOf(adminPagePaths));
    const others = adminPagePaths.filter(
      (pathname) => !financePages.has(pathname),
    );
    expect(others.length).toBeGreaterThan(70);
    const admitted: string[] = [];
    for (const pathname of others) {
      const result = await pageAdmits(FINANCE_ONLY, pathname);
      if (result.ok) admitted.push(pathname);
    }
    expect(admitted).toEqual([]);
  }, 120_000);

  it("is refused EVERY admin API route outside finance, read and write, by attempt", async () => {
    const financeApis = new Set(financePathsOf(adminApiPaths));
    const others = adminApiPaths.filter(
      (pathname) => !financeApis.has(pathname),
    );
    expect(others.length).toBeGreaterThan(200);
    const admitted: string[] = [];
    for (const pathname of others) {
      for (const method of ["GET", "POST", "PATCH", "PUT", "DELETE"]) {
        const result = await apiAdmits(FINANCE_ONLY, pathname, method);
        if (result.ok) admitted.push(`${method} ${pathname}`);
      }
    }
    expect(admitted).toEqual([]);
  }, 180_000);

  it("reads finance but writes nothing, because the grid is view-only", async () => {
    const financeApis = financePathsOf(adminApiPaths);
    expect(financeApis.length).toBeGreaterThan(15);
    const violations: string[] = [];
    for (const pathname of financeApis) {
      // The Xero OAuth handlers are side-effecting GETs and demand `edit`
      // (EDIT_ON_GET_PREFIXES), so a view-only grid is right to be refused.
      const readNeedsEdit = requirementFor(pathname, "GET").level === "edit";
      const read = await apiAdmits(FINANCE_ONLY, pathname, "GET");
      if (read.ok === readNeedsEdit) {
        violations.push(
          `GET ${pathname}: finance:view only was ${
            read.ok ? "admitted" : "refused"
          }`,
        );
      }
      const write = await apiAdmits(FINANCE_ONLY, pathname, "POST");
      if (write.ok) {
        violations.push(`POST ${pathname}: finance:view only was admitted`);
      }
    }
    expect(violations).toEqual([]);
  }, 120_000);

  it("reaches the consolidated fee console, which admits on bookings OR finance (#1933)", async () => {
    expect(allAdminPaths.has("/admin/fees")).toBe(true);
    expect((await pageAdmits(FINANCE_ONLY, "/admin/fees")).ok).toBe(true);
    expect((await pageAdmits(viewGridFor("bookings"), "/admin/fees")).ok).toBe(
      true,
    );
    expect(
      (await pageAdmits(viewGridFor("membership"), "/admin/fees")).ok,
    ).toBe(false);
  });
});

describe("Full Admin behaviour is unchanged", () => {
  it("is admitted to every admin page and every admin API route, read and write", async () => {
    const refused: string[] = [];
    for (const pathname of adminPagePaths) {
      if (!(await pageAdmits(FULL_ADMIN, pathname)).ok) {
        refused.push(`page ${pathname}`);
      }
    }
    for (const pathname of adminApiPaths) {
      for (const method of ["GET", "POST", "DELETE"]) {
        if (!(await apiAdmits(FULL_ADMIN, pathname, method)).ok) {
          refused.push(`${method} ${pathname}`);
        }
      }
    }
    expect(refused).toEqual([]);
  }, 180_000);
});
