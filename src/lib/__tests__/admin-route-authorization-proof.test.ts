/**
 * THE ADMIN AUTHORIZATION PROOF: real routes, real gates, real guards (#2975,
 * shipping with the #2984 privilege-model correction).
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
 * NONE OF THAT IS THE SAME AS THE GUARD ACTUALLY ENFORCING THE RULE. Every one
 * of the sixty-odd per-route suites mocks `@/lib/session-guards`, so it asserts
 * nothing whatever about `requireAdmin`; the map tests never invoke a guard;
 * and the helper tests never see a route. Between them sat the question nobody
 * was asking: given a real admin path and a real access-role grid, does the
 * software that runs on every request admit or refuse? One endpoint answered it
 * (`admin-lodges-access-gate.test.ts`, #2925, written after a mocked suite
 * passed 17/17 against a route that still returned the 403 it existed to
 * remove). This file answers it for the whole tree.
 *
 * ## WHAT IT MEASURES, precisely — because the first cut measured the wrong thing
 *
 * A route's authorization has TWO definitions, and on most routes it is not the
 * map that wins. `requireAdmin` consults `getAdminRouteRequirement` only when the
 * handler passes no explicit `permission`, and around 170 of the ~300
 * `/api/admin` handlers pass one. The first version of this file called a bare
 * `requireAdmin()` for every route, so every sweep in it measured the map and
 * none of them measured the gate a request actually meets — and it therefore
 * asserted things about this application that were FALSE:
 *
 *   - that a finance-only grid is refused every admin API route outside finance,
 *     while `POST /api/admin/members/[id]/joining-fee/preview` is gated
 *     `finance:view` and answers it 200;
 *   - that a `support:view` grid is admitted to `/api/admin/club-time-zone`,
 *     which passes `permission: false` and admits only a Full Admin.
 *
 * A proof that asserts false things is worse than no proof. Every API sweep below
 * now reads each handler's own `permission` literal out of its source
 * (`helpers/admin-route-explicit-permissions.ts`) and hands it to the real guard,
 * so what is measured is the gate that runs.
 *
 * It measures the ADMISSION gate. A handler that narrows further after it — the
 * config-transfer wrapper's second `isFullAdmin` check, the backup-restore
 * destination gate — is stricter in production than reported here. Narrowing only
 * removes callers, so every refusal below is sound and every admission means
 * "cleared admission and reached the handler".
 *
 * ## How it is arranged, and why each part cannot be satisfied vacuously
 *
 *   1. ENUMERATION. Every admin page and every `/api/admin` route is discovered
 *      from disk (`helpers/admin-route-enumeration.ts`), never listed here, with
 *      a floor assertion so a broken walk cannot make the sweeps pass by
 *      covering nothing.
 *
 *   2. THE GATES. Every handler's explicit `permission` is read from source, and
 *      a shape the reader cannot resolve is a HARD FAILURE rather than a silent
 *      fall back to path inference. Every divergence between an explicit literal
 *      and the map is listed, reviewed and pinned below, so a new one — the
 *      #2949 shape, a route quietly re-gated in its own source — fails here.
 *
 *   3. SWEEPS. Every discovered path is put to the REAL `requireAdmin` (API) and
 *      the REAL `guardAdminLayout` (pages), for sixteen access-role grids,
 *      through the same `x-pathname` / `x-request-method` headers `src/proxy.ts`
 *      stamps on the real request. This is what proves the guard honours the
 *      permission it is given, consults the map when it is given none, that no
 *      route is open to everyone or shut to everyone, and that `view` does not
 *      buy `edit`.
 *
 *      The sweeps compute what they expect FROM the map and FROM those same
 *      literals, so they are honest about their own limit: they cannot catch a
 *      map or a literal that is wrong. That is what (2) and (4) are for, and
 *      separating them is deliberate — a single test that derived its
 *      expectation from the thing under test would look like proof and be a
 *      tautology.
 *
 *   4. ANCHORS. A small, human-reviewed table naming which area a handful of
 *      unmistakable routes belong to (`helpers/admin-route-area-anchors.ts`),
 *      asserted through the real guards: the area's holder is admitted, and every
 *      other single-area holder is refused. It is written down BECAUSE it must
 *      not be derived — it is the independent statement a seeded wrong mapping
 *      contradicts. It is drift-guarded: every path in it must exist in the
 *      enumeration, so it cannot rot into a list of routes that no longer exist.
 *
 *   5. #2984. Finance-only standing, proved the way the issue asks for it — by
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

import { hasAdminAccess } from "@/lib/access-roles";
import {
  ADMIN_PERMISSION_AREAS,
  canAccessConsolidatedFeesPage,
  getAdminPermissionMatrix,
  getAdminRouteRequirement,
  hasAdminAreaAccess,
  hasAdminPortalAccess,
  isAnyAdminAdmissionPath,
  isConsolidatedFeesPath,
  type AdminAccessRequirement,
  type AdminPermissionArea,
} from "@/lib/admin-permissions";
import { guardAdminLayout } from "@/lib/admin-layout-guard";
import { requireAdmin } from "@/lib/session-guards";
import {
  accessRoleDefinitionGrid,
  type AccessRoleDefinitionGrid,
  type AccessRoleGridLevel,
} from "@/lib/__tests__/helpers/access-role-definition-grid";
import { ADMIN_ROUTE_AREA_ANCHOR_ENTRIES } from "@/lib/__tests__/helpers/admin-route-area-anchors";
import {
  adminApiPaths,
  adminPagePaths,
  allAdminPaths,
} from "@/lib/__tests__/helpers/admin-route-enumeration";
import {
  adminApiRouteGates,
  type ExplicitAdminPermission,
  type HttpMethod,
} from "@/lib/__tests__/helpers/admin-route-explicit-permissions";

// ---------------------------------------------------------------------------
// GRIDS. Built from explicit per-area levels rather than from the shipped
// bundles, so an edit to a bundle cannot quietly change what this file proves.
// ---------------------------------------------------------------------------

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
      roleDefinition: AccessRoleDefinitionGrid | null;
    }>;
  };
};

function customGrid(
  label: string,
  levels: Partial<Record<`${AdminPermissionArea}Level`, AccessRoleGridLevel>>,
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
          roleDefinitionId: "ardef_grid",
          roleDefinition: accessRoleDefinitionGrid(levels),
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

/**
 * The sixteen grids every sweep runs: fourteen single-area holders (seven areas
 * at `view`, seven at `edit`), a Full Admin and a plain member. A deactivated
 * Full Admin is built inside the one test that needs it and is a seventeenth.
 */
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
// 2. THE GATE EACH REQUEST ACTUALLY MEETS.
// ---------------------------------------------------------------------------

/**
 * What `requireAdmin` will resolve for this request: the handler's own explicit
 * `permission` where it passes one, otherwise the route map's requirement.
 *
 * A method the route does not export still gets the map's answer. That pairing
 * is hypothetical — Next answers 405 before any guard runs — and it is kept on
 * purpose: it is the gate a handler ADDED for that method would inherit, and
 * proving the inherited gate is right is the cheapest moment to do it.
 */
type EffectiveGate =
  | { kind: "requirement"; requirement: AdminAccessRequirement }
  | { kind: "full-admin" }
  | { kind: "any-admin" };

function mapRequirement(pathname: string, method: string): AdminAccessRequirement {
  return (
    getAdminRouteRequirement(pathname, method) ?? {
      area: "overview",
      level: "view",
    }
  );
}

function explicitPermissionFor(
  pathname: string,
  method: string,
): ExplicitAdminPermission | null {
  const gate = adminApiRouteGates.get(pathname)?.gates[method as HttpMethod];
  if (!gate || gate.kind !== "explicit") return null;
  return gate.permission;
}

function apiGate(pathname: string, method: string): EffectiveGate {
  const explicit = explicitPermissionFor(pathname, method);
  if (explicit) return explicit;
  return { kind: "requirement", requirement: mapRequirement(pathname, method) };
}

/** Whether this grid satisfies a gate, computed independently of the guard. */
function satisfies(grid: Grid, gate: EffectiveGate): boolean {
  if (gate.kind === "full-admin") return hasAdminAccess(grid.member);
  if (gate.kind === "any-admin") return hasAdminPortalAccess(grid.member);
  return hasAdminAreaAccess(grid.member, gate.requirement);
}

/**
 * Whether the layout guard should admit this grid to this page: the map's area,
 * plus the two adjudicated special cases — the fee console's bookings-OR-finance
 * rule (#1933) and ADR-002 §1 admission. Written out here on purpose rather than
 * calling `canOpenAdminPath`: deriving the expectation from the function under
 * test would be a tautology. It calls `canAccessConsolidatedFeesPage` for the fee
 * rule because a SECOND SPELLING of that rule is how the two copies of it drifted
 * apart in the first place.
 */
function pageAdmitsExpected(grid: Grid, pathname: string): boolean {
  if (isAnyAdminAdmissionPath(pathname)) {
    return hasAdminPortalAccess(grid.member);
  }
  if (isConsolidatedFeesPath(pathname)) {
    return canAccessConsolidatedFeesPage(getAdminPermissionMatrix(grid.member));
  }
  return hasAdminAreaAccess(grid.member, mapRequirement(pathname, "GET"));
}

/** A short human label for a gate, for failure messages. */
function describeGate(gate: EffectiveGate): string {
  if (gate.kind === "full-admin") return "Full Admin only";
  if (gate.kind === "any-admin") return "any admitted admin";
  return `${gate.requirement.area}:${gate.requirement.level}`;
}

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

/**
 * Did the REAL `requireAdmin` admit this grid on this request — called exactly
 * as the handler calls it, with the handler's own `permission` where it has one?
 */
async function apiAdmits(
  grid: Grid,
  pathname: string,
  method: string,
): Promise<{ ok: boolean; status: number | null }> {
  signIn(grid);
  setRequest(pathname, method);
  const explicit = explicitPermissionFor(pathname, method);
  const result = await requireAdmin(
    explicit === null
      ? {}
      : {
          permission:
            explicit.kind === "requirement"
              ? explicit.requirement
              : explicit.kind === "full-admin"
                ? false
                : "any-admin",
        },
  );
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

// ---------------------------------------------------------------------------
// 2. THE EXPLICIT PERMISSIONS, REVIEWED.
//
// A route that passes its own `permission` literal has a SECOND definition of
// its authorization, and it is the one that runs. Where that literal disagrees
// with the path map, the disagreement is the whole of the route's real gate —
// so every one of them is listed here with the reason it is intended, and a new
// one fails this file.
//
// THIS IS THE CONTROL THAT CATCHES THE #2949 SHAPE. On that fork pull request
// three routes were moved from `{ area: "finance", level: "edit" }` to
// `{ area: "overview", level: "view" }` in the ROUTE SOURCE — a real privilege
// downgrade on money-moving routes — and 83 tests still passed. A downgrade like
// that either creates a divergence that is not on this list, or changes one that
// is; both are red.
// ---------------------------------------------------------------------------

type Divergence = { pathname: string; method: string; gate: string; why: string };

const REVIEWED_PERMISSION_DIVERGENCES: Divergence[] = [
  {
    pathname: "/api/admin/ai-diagnostics/ask",
    method: "POST",
    gate: "any admitted admin",
    why: "ADR-002 §1 admission, owner-ratified on #2370: any one of the seven areas may ask, and the answer returns no evidence the caller's own areas do not gate at invocation.",
  },
  {
    pathname: "/api/admin/bed-allocation/allocations/move",
    method: "POST",
    gate: "bookings:view",
    why: "a POST that only PREVIEWS a move (#2595) and writes nothing; the apply half is on the plural allocations route at bookings:edit.",
  },
  {
    pathname: "/api/admin/bed-allocation/allocations/removal",
    method: "POST",
    gate: "bookings:view",
    why: "the removal PREVIEW; the PUT beside it does the removal and takes bookings:edit.",
  },
  {
    pathname: "/api/admin/booking-messages/preview",
    method: "POST",
    gate: "support:view",
    why: "renders a message preview and persists nothing; POST only because the draft is too large for a query string.",
  },
  {
    pathname: "/api/admin/bookings/eligible-family",
    method: "GET",
    gate: "bookings:edit",
    why: "STRICTER than the map. The list exists to be picked from while editing a booking's party, so it is gated at the level of the edit it serves.",
  },
  {
    pathname: "/api/admin/bookings/x123/eligible-family",
    method: "GET",
    gate: "bookings:edit",
    why: "STRICTER than the map, same reason as its collection sibling above.",
  },
  {
    pathname: "/api/admin/bookings/non-member-contact",
    method: "GET",
    gate: "bookings:edit",
    why: "STRICTER than the map: it discloses a non-member's contact details, which only an officer editing the booking needs.",
  },
  {
    pathname: "/api/admin/club-time-zone",
    method: "GET",
    gate: "Full Admin only",
    why: "STRICTER than the map. The installation's timezone moves every civil date in the product (INV-CONFIG-002), so both verbs are Full Admin and not a support level.",
  },
  {
    pathname: "/api/admin/club-time-zone",
    method: "PUT",
    gate: "Full Admin only",
    why: "STRICTER than the map, same reason as the GET above.",
  },
  {
    pathname: "/api/admin/email-templates/preview",
    method: "POST",
    gate: "support:view",
    why: "renders a template preview and persists nothing; POST only because the draft is too large for a query string.",
  },
  {
    pathname: "/api/admin/environment-safety",
    method: "GET",
    gate: "Full Admin only",
    why: "STRICTER than the map: the production-safety interlock is a Full Admin control on both verbs.",
  },
  {
    pathname: "/api/admin/environment-safety",
    method: "PATCH",
    gate: "Full Admin only",
    why: "STRICTER than the map, same reason as the GET above.",
  },
  {
    pathname: "/api/admin/lodges",
    method: "GET",
    gate: "any admitted admin",
    why: "WIDER than the map, owner decision 17 Aug 2026 (#2925): the lodge vocabulary every admin screen needs to say WHICH lodge it means. A caller without lodge:view receives id, name, slug and active and nothing else, and the narrowing is what makes the relaxation safe — see docs/multi-lodge/lodge-scoping-contract.md.",
  },
  {
    pathname: "/api/admin/members/x123/joining-fee/preview",
    method: "POST",
    gate: "finance:view",
    why: "WIDER than the map for a finance holder and NARROWER for a membership one. It computes a fee from fee configuration, so it is gated on the area that owns fees rather than on the member record the path runs through; it persists nothing.",
  },
  {
    pathname: "/api/admin/xero/member-grouping",
    method: "POST",
    gate: "finance:view",
    why: "the dry-run needs only finance:view (#1934 review) and the path default would have made every POST under /api/admin/xero finance:edit, leaving that exception unreachable. Every non-dry-run action re-checks finance:edit inside the handler.",
  },
];

function divergencesOnDisk(): Divergence[] {
  const found: Divergence[] = [];
  for (const [pathname, route] of adminApiRouteGates) {
    for (const method of route.methods) {
      const gate = route.gates[method];
      if (!gate || gate.kind !== "explicit") continue;
      const mapped = mapRequirement(pathname, method);
      const permission = gate.permission;
      if (
        permission.kind === "requirement" &&
        permission.requirement.area === mapped.area &&
        permission.requirement.level === mapped.level
      ) {
        continue;
      }
      found.push({
        pathname,
        method,
        gate: describeGate(permission),
        why: "",
      });
    }
  }
  return found;
}

describe("the explicit permission each handler passes is reviewed (#2975)", () => {
  it("reads every /api/admin handler's gate, with nothing left unresolved", () => {
    // A shape the reader cannot resolve must never degrade to path inference:
    // that is the blindness this whole section exists to remove, and it would
    // reappear silently. Teach the reader the shape, or change the route.
    const unparsed: string[] = [];
    let explicit = 0;
    let inferred = 0;
    for (const [pathname, route] of adminApiRouteGates) {
      for (const method of route.methods) {
        const gate = route.gates[method];
        if (!gate) continue;
        if (gate.kind === "unparsed") {
          unparsed.push(`${method} ${pathname}: ${gate.detail}`);
        } else if (gate.kind === "explicit") explicit += 1;
        else inferred += 1;
      }
    }
    expect(unparsed).toEqual([]);
    // Non-vacuous in both directions: the reader really found explicit literals,
    // and really found path-inferred handlers, so neither branch is dead.
    expect(explicit).toBeGreaterThan(250);
    expect(inferred).toBeGreaterThan(50);
  });

  it("pins every divergence between a handler's own gate and the route map", () => {
    const onDisk = divergencesOnDisk();
    const reviewed = REVIEWED_PERMISSION_DIVERGENCES;

    const key = (entry: Divergence) =>
      `${entry.method} ${entry.pathname} -> ${entry.gate}`;
    const reviewedKeys = new Set(reviewed.map(key));
    const onDiskKeys = new Set(onDisk.map(key));

    // A route whose own literal disagrees with the map and is NOT on the list is
    // either a mistake or a decision nobody wrote down. Add it with its reason.
    expect(onDisk.map(key).filter((k) => !reviewedKeys.has(k))).toEqual([]);
    // And a listed divergence that no longer exists is a stale entry: the route
    // was re-gated or removed, and the reason above no longer describes it.
    expect(reviewed.map(key).filter((k) => !onDiskKeys.has(k))).toEqual([]);

    for (const entry of reviewed) {
      expect(entry.why.length, `${key(entry)} has no reason`).toBeGreaterThan(40);
    }
  });
});

// ---------------------------------------------------------------------------
// SIDE-EFFECTING GETs.
//
// `EDIT_ON_GET_PREFIXES` forces `edit` on the two Xero OAuth browser handlers,
// so the "a view grid never gets through a write" sweep below covers them. It is
// not the complete list of `/api/admin` GETs that change server state, and the
// sweep would otherwise imply that it is.
//
// PRE-EXISTING AND DELIBERATELY UNTOUCHED HERE. Raising a GET to `edit` — or
// adding it to `EDIT_ON_GET_PREFIXES` — changes who can load the screen that
// calls it, which is a product decision outside #2975's scope. What this issue
// owes is that the gap is NAMED rather than implied away.
// ---------------------------------------------------------------------------
const SIDE_EFFECTING_GETS: Array<{
  pathname: string;
  gatedAtEdit: boolean;
  what: string;
}> = [
  {
    pathname: "/api/admin/xero/connect",
    gatedAtEdit: true,
    what: "starts the Xero OAuth flow, which mutates connection state; EDIT_ON_GET_PREFIXES forces finance:edit.",
  },
  {
    pathname: "/api/admin/xero/callback",
    gatedAtEdit: true,
    what: "exchanges the OAuth code and stores tokens; EDIT_ON_GET_PREFIXES forces finance:edit.",
  },
  {
    pathname: "/api/admin/lodge",
    gatedAtEdit: false,
    what: "PROVISIONS the lodge kiosk account when none exists: creates a Member row with role LODGE, canLogin and emailVerified set, seeds a subscription row and writes an audit entry — all on a lodge:view GET, triggered by loading the page. Impact is bounded (random password, forcePasswordChange set) and the flow is how a club gets a kiosk at all, so the gate is left alone and the exposure is recorded here instead.",
  },
];

describe("side-effecting GETs are named rather than implied away (#2975)", () => {
  it("lists only routes that exist, and says which are gated at edit", () => {
    for (const entry of SIDE_EFFECTING_GETS) {
      expect(allAdminPaths.has(entry.pathname), `${entry.pathname} is gone`).toBe(
        true,
      );
      expect(entry.what.length).toBeGreaterThan(40);
      expect(
        mapRequirement(entry.pathname, "GET").level === "edit",
        `${entry.pathname}: gatedAtEdit says ${entry.gatedAtEdit}, the map disagrees`,
      ).toBe(entry.gatedAtEdit);
    }
    // The one that is NOT gated at edit is the stated gap. If this becomes zero
    // somebody closed it, and the entry should go rather than quietly stand.
    expect(SIDE_EFFECTING_GETS.filter((entry) => !entry.gatedAtEdit)).toHaveLength(
      1,
    );
  });
});

describe("the real requireAdmin enforces each route's real gate on every /api/admin route", () => {
  it.each(["GET", "POST"])(
    "admits exactly the grids that gate admits (%s)",
    async (method) => {
      const violations: string[] = [];
      for (const pathname of adminApiPaths) {
        const gate = apiGate(pathname, method);
        for (const grid of SWEEP_GRIDS) {
          const expected = satisfies(grid, gate);
          const actual = await apiAdmits(grid, pathname, method);
          if (actual.ok !== expected) {
            violations.push(
              `${method} ${pathname} needs ${describeGate(gate)} — ` +
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
    let writes = 0;
    for (const pathname of adminApiPaths) {
      const gate = apiGate(pathname, "POST");
      if (gate.kind !== "requirement" || gate.requirement.level !== "edit") {
        continue;
      }
      writes += 1;
      const grid = viewGridFor(gate.requirement.area);
      const result = await apiAdmits(grid, pathname, "POST");
      if (result.ok) {
        violations.push(
          `POST ${pathname} needs ${gate.requirement.area}:edit but "${grid.label}" was admitted`,
        );
      }
    }
    expect(violations).toEqual([]);
    // Non-vacuous: writes exist, and they were all checked.
    expect(writes).toBeGreaterThan(200);
  }, 120_000);
});

describe("the real guardAdminLayout enforces the real route map on every admin page", () => {
  it("admits exactly the grids the map admits", async () => {
    const violations: string[] = [];
    for (const pathname of adminPagePaths) {
      for (const grid of SWEEP_GRIDS) {
        const expected = pageAdmitsExpected(grid, pathname);
        const actual = await pageAdmits(grid, pathname);
        if (actual.ok !== expected) {
          violations.push(
            `${pathname} — "${grid.label}" should have been ` +
              `${expected ? "ADMITTED" : "REFUSED"} but the layout guard ` +
              `${actual.ok ? "admitted" : `redirected to ${actual.destination}`}`,
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
// ADR-002 §1 — admission, not an area.
// ---------------------------------------------------------------------------

describe("ADR-002 §1 admission: the Diagnostics surfaces admit any admitted admin", () => {
  it("opens the workspace shell for every single-area grid, and for nobody else", async () => {
    for (const area of AREAS) {
      const grid = viewGridFor(area);
      expect(
        (await pageAdmits(grid, "/admin/ai-diagnostics")).ok,
        `${area}:view only must be able to open the Diagnostics shell`,
      ).toBe(true);
    }
    expect((await pageAdmits(PLAIN_MEMBER, "/admin/ai-diagnostics")).ok).toBe(
      false,
    );
  });

  it("admits every single-area grid to the ask route through the real guard", async () => {
    for (const area of AREAS) {
      const grid = viewGridFor(area);
      expect(
        (await apiAdmits(grid, "/api/admin/ai-diagnostics/ask", "POST")).ok,
        `${area}:view only must be admitted to ask a Diagnostics question`,
      ).toBe(true);
    }
    expect(
      (await apiAdmits(PLAIN_MEMBER, "/api/admin/ai-diagnostics/ask", "POST")).ok,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. ANCHORS — the independent statement a seeded wrong mapping contradicts.
//    The table itself lives in `helpers/admin-route-area-anchors.ts` so the
//    frozen route-to-area snapshot can be asserted against the same reviewed
//    pairs instead of restating them.
// ---------------------------------------------------------------------------

describe("the reviewed route-to-area anchors, enforced through the real guards", () => {
  const anchorEntries = ADMIN_ROUTE_AREA_ANCHOR_ENTRIES;

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
// 5. #2984 — finance-only standing, proved by attempt.
// ---------------------------------------------------------------------------

/**
 * The routes a finance-only grid reaches that are NOT finance routes, each
 * because its own gate says so rather than because a check was missed.
 *
 * This list is what makes "refused everything else" a true statement instead of
 * an approximate one. Both entries are reviewed above in
 * `REVIEWED_PERMISSION_DIVERGENCES`; they are named again here because the
 * assertion below has to allow exactly them and nothing more.
 */
const FINANCE_ONLY_NON_FINANCE_ADMISSIONS = [
  // Owner decision #2925: the lodge vocabulary, narrowed to id/name/slug/active
  // for a caller without `lodge:view` — which is what a finance-only grid is.
  "GET /api/admin/lodges",
  // ADR-002 §1 admission: any one area may ask a Diagnostics question, and the
  // answer returns no evidence the caller's own areas do not gate at invocation.
  "POST /api/admin/ai-diagnostics/ask",
  // Gated `finance:view` in its own source, while its PATH sits under
  // `/api/admin/members` and so counts as `membership` in the partition above.
  // It computes a joining fee from fee configuration and persists nothing, so
  // the area that owns fees is the right gate — but a treasurer really can read
  // a named member's resolved joining fee, and the previous version of this
  // sweep asserted the opposite while the route answered 200.
  "POST /api/admin/members/x123/joining-fee/preview",
];

function financePathsOf(paths: string[]) {
  return paths.filter(
    (pathname) =>
      mapRequirement(pathname, "GET").area === "finance" ||
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
      // The Diagnostics shell is admission rather than an area (ADR-002 §1) and
      // is proved above; everything else must refuse.
      if (result.ok && !isAnyAdminAdmissionPath(pathname)) admitted.push(pathname);
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
    // Exactly the two reviewed admissions, and no others. Asserting equality
    // rather than a subset is the point: a route that starts admitting this grid
    // for a reason nobody wrote down fails here.
    expect(admitted.sort()).toEqual([...FINANCE_ONLY_NON_FINANCE_ADMISSIONS].sort());
  }, 180_000);

  it("reads finance but writes nothing, because the grid is view-only", async () => {
    const financeApis = financePathsOf(adminApiPaths);
    expect(financeApis.length).toBeGreaterThan(15);
    const violations: string[] = [];
    for (const pathname of financeApis) {
      for (const method of ["GET", "POST"]) {
        const gate = apiGate(pathname, method);
        const expected = satisfies(FINANCE_ONLY, gate);
        const result = await apiAdmits(FINANCE_ONLY, pathname, method);
        if (result.ok !== expected) {
          violations.push(
            `${method} ${pathname} needs ${describeGate(gate)}: finance:view only was ` +
              `${result.ok ? "admitted" : "refused"}`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
    // Non-vacuous: the sweep really refused this grid on finance writes, rather
    // than agreeing with an expectation that never said no.
    const refusedWrites = financeApis.filter(
      (pathname) => !satisfies(FINANCE_ONLY, apiGate(pathname, "POST")),
    );
    expect(refusedWrites.length).toBeGreaterThan(10);
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
