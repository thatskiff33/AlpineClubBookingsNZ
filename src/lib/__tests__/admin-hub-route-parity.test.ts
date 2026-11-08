import { AccessRole } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { DEFAULT_ACCESS_ROLE_DEFINITIONS } from "@/lib/access-role-definitions";
import {
  ADMIN_PERMISSION_AREAS,
  canOpenAdminPath,
  canViewAdminHrefWithMatrix,
  getAdminPermissionMatrix,
  getAdminRouteRequirement,
  getFirstAccessibleAdminHref,
  type AdminAccessRequirement,
  type AdminPermissionArea,
  type AdminPermissionInput,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";
import { getRequiredFeaturesForPath } from "@/config/feature-routes";
import type { FeatureFlagKey } from "@/config/schema";
import { ADMIN_PAGES } from "@/lib/admin-hubs";
import type { AdminHubPage } from "@/lib/admin-hubs/define";
import { SWEEP_GRIDS } from "@/lib/__tests__/helpers/admin-sweep-grids";

// ---------------------------------------------------------------------------
// THE ADMIN HUB ROUTE PARITY CENSUS (epic #4468, C2 #4799).
//
// C2 stopped writing the page half of the security map by hand: the route-map
// prefixes, the fee console, Rooms & Beds and any-admin admission paths, the
// first-accessible landing and the admin page module gates are all generated
// from the hub registry, for each page's old path AND its hub path. This census
// is the proof that doing so changed nothing an officer can observe.
//
// THE ORACLE is the hand-written page half as it stood on `main` at 06cfa84,
// copied below verbatim together with the resolution rules that read it. It is
// deliberately NOT derived from the registry or from the functions under test:
// an oracle computed from the thing it checks would agree with any mistake.
// The old-path half of this census was committed first, against the unchanged
// hand-written code, and passed there — which is what makes the oracle a
// faithful copy of `main` rather than a second guess at it.
//
// For every registry page, for its old path and (once generated) its hub twin,
// each of these must answer exactly as the oracle answers for the OLD path:
//   - `canOpenAdminPath` (the layout guard's admission), for the sixteen sweep
//     grids of `admin-route-authorization-proof.test.ts` and every seeded role;
//   - `getAdminRouteRequirement` for GET and for POST;
//   - sidebar visibility (`canViewAdminHrefWithMatrix`, the per-href half of the
//     sidebar's and command palette's filter), for the same subjects;
//   - the module block: `getRequiredFeaturesForPath`, in order, which is all the
//     proxy's 404 gate and `isFeatureHrefVisible` read.
// The probes are each page's path, a child below it, its trailing-slash
// spelling, and every static directory above it.
//
// A page ADDED after C2 has no row in the frozen tables, so it resolves to the
// oracle's catch-all and fails here: give the oracle its reviewed answer, the
// same review a hand-written route-map entry always had.
// ---------------------------------------------------------------------------

/** `main`'s page half of `ROUTE_AREA_PREFIXES` at 06cfa84, in resolution order. */
const ORACLE_ROUTE_AREAS: ReadonlyArray<{
  area: AdminPermissionArea;
  prefixes: readonly string[];
}> = [
  {
    area: "finance",
    prefixes: [
      "/admin/setup/finance",
      "/admin/integrations",
      "/admin/xero",
      "/admin/stripe",
      "/admin/google",
      "/admin/alpine-server",
      "/admin/video-meetings",
      "/admin/payments",
      "/admin/internet-banking",
      "/admin/refund-requests",
      "/admin/reports",
      "/admin/subscriptions",
      "/admin/fee-configuration",
    ],
  },
  {
    area: "bookings",
    prefixes: [
      "/admin/bookings-setup",
      "/admin/setup/booking-rules",
      "/admin/bookings",
      "/admin/booking-requests",
      "/admin/book",
      "/admin/bed-allocation",
      "/admin/waitlist",
      "/admin/booking-approvals",
      "/admin/booking-change-requests",
      "/admin/booking-policies",
      "/admin/seasons",
      "/admin/fees",
      "/admin/age-tier-settings",
      "/admin/promo-codes",
    ],
  },
  {
    area: "membership",
    prefixes: [
      "/admin/membership-setup",
      "/admin/members",
      "/admin/member-applications",
      "/admin/membership-cancellation",
      "/admin/membership-cancellations",
      "/admin/membership-types",
      "/admin/member-fields",
      "/admin/induction",
      "/admin/communications",
      "/admin/notices",
      "/admin/lockers",
      "/admin/subscription-lockout",
      "/admin/message-board",
      "/admin/family-groups",
      "/admin/family-suggestions",
      "/admin/deletion-requests",
      "/admin/committee",
    ],
  },
  {
    area: "lodge",
    prefixes: [
      "/admin/hut-leaders",
      "/admin/roster",
      "/admin/chores",
      "/admin/lodge",
      "/admin/lodges",
      "/admin/work-parties",
      "/admin/lodge-instructions",
      "/admin/rooms-beds",
      "/admin/calendar",
      "/admin/display",
      "/admin/maintenance-reports",
    ],
  },
  {
    area: "content",
    prefixes: [
      "/admin/appearance",
      "/admin/page-content",
      "/admin/site-banners",
      "/admin/site-content",
      "/admin/image-manager",
      "/admin/site-style",
      "/admin/mountain-conditions",
    ],
  },
  {
    area: "support",
    prefixes: [
      "/admin/access-roles",
      "/admin/config-transfer",
      "/admin/setup",
      "/admin/modules",
      "/admin/club-time",
      "/admin/club-format",
      "/admin/environment",
      "/admin/security",
      "/admin/privacy-retention",
      "/admin/notifications",
      "/admin/notification-rules",
      "/admin/notification-recipients",
      "/admin/booking-messages",
      "/admin/email-messages",
      "/admin/email-deliverability",
      "/admin/health",
      "/admin/background-jobs",
      "/admin/backups",
      "/admin/stuck-states",
      "/admin/issue-reports",
      "/admin/audit-log",
      "/admin/ai-assistant",
    ],
  },
  { area: "overview", prefixes: ["/admin"] },
];

/** `main`'s `ANY_ADMIN_ADMISSION_PATHS`, `CONSOLIDATED_FEES_PATH` and `ROOMS_BEDS_PATH`. */
const ORACLE_ANY_ADMIN_PATHS = ["/admin/ai-diagnostics", "/admin/club-format"];
const ORACLE_FEES_PATH = "/admin/fees";
const ORACLE_ROOMS_BEDS_PATH = "/admin/rooms-beds";

/**
 * `main`'s admin page prefixes in `FEATURE_ROUTE_RULES`, in rule order, with the
 * one admin page exemption. Every other prefix in a rule is an API or member
 * path, which an `/admin/...` path can never match.
 */
const ORACLE_MODULE_GATES: ReadonlyArray<{
  flag: FeatureFlagKey;
  prefixes: readonly string[];
  exemptPaths?: readonly string[];
}> = [
  { flag: "kiosk", prefixes: ["/admin/lodge"] },
  { flag: "chores", prefixes: ["/admin/chores", "/admin/roster"] },
  { flag: "waitlist", prefixes: ["/admin/waitlist"] },
  { flag: "xeroIntegration", prefixes: ["/admin/xero", "/admin/internet-banking"] },
  { flag: "bedAllocation", prefixes: ["/admin/bed-allocation", "/admin/rooms-beds"] },
  { flag: "internetBankingPayments", prefixes: ["/admin/internet-banking"] },
  { flag: "lockers", prefixes: ["/admin/lockers"] },
  { flag: "induction", prefixes: ["/admin/induction"] },
  { flag: "workParties", prefixes: ["/admin/work-parties"] },
  { flag: "promoCodes", prefixes: ["/admin/promo-codes"] },
  { flag: "hutLeaders", prefixes: ["/admin/hut-leaders"] },
  { flag: "communications", prefixes: ["/admin/communications"] },
  { flag: "memberNotices", prefixes: ["/admin/notices"] },
  { flag: "eventsCalendar", prefixes: ["/admin/calendar"] },
  { flag: "skifieldConditions", prefixes: ["/admin/mountain-conditions"] },
  {
    flag: "lobbyDisplay",
    prefixes: ["/admin/display"],
    exemptPaths: ["/admin/display/setup"],
  },
  { flag: "aiAssistant", prefixes: ["/admin/ai-assistant"] },
  { flag: "aiDiagnostics", prefixes: ["/admin/ai-diagnostics"] },
  { flag: "maintenanceReports", prefixes: ["/admin/maintenance-reports"] },
  { flag: "commsPortal", prefixes: ["/admin/message-board"] },
  { flag: "alpineCentralServer", prefixes: ["/admin/alpine-server"] },
];

/** `main`'s `getFirstAccessibleAdminHref`, as its if-chain read. */
const ORACLE_FIRST_ACCESSIBLE: ReadonlyArray<[AdminPermissionArea, string]> = [
  ["overview", "/admin/dashboard"],
  ["bookings", "/admin/bookings"],
  ["membership", "/admin/members"],
  ["finance", "/admin/payments"],
  ["lodge", "/admin/hut-leaders"],
  ["content", "/admin/page-content"],
  ["support", "/admin/health"],
];

// --- the oracle's resolution rules, copied from `main` ---------------------

const RANK = { none: 0, view: 1, edit: 2 } as const;

/** `normalizePathname` in `admin-permissions.ts`. */
function oracleNormalize(pathname: string): string {
  const candidate = pathname.split(/[?#]/)[0] || "/";
  return candidate.endsWith("/") && candidate !== "/"
    ? candidate.replace(/\/+$/, "")
    : candidate;
}

function underPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** `getAdminRouteRequirement` for a page path: the first AREA with a matching prefix. */
function oracleRequirement(pathname: string, method: string): AdminAccessRequirement {
  const normalized = oracleNormalize(pathname);
  const route = ORACLE_ROUTE_AREAS.find(({ prefixes }) =>
    prefixes.some((prefix) => underPrefix(normalized, prefix)),
  );
  if (!route) throw new Error(`oracle: ${pathname} is not an admin page path`);
  const edit = !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
  return { area: route.area, level: edit ? "edit" : "view" };
}

function anyArea(matrix: AdminPermissionMatrix): boolean {
  return ADMIN_PERMISSION_AREAS.some((area) => matrix[area.key] !== "none");
}

function oracleIsAnyAdmin(pathname: string): boolean {
  return ORACLE_ANY_ADMIN_PATHS.some((p) => underPrefix(oracleNormalize(pathname), p));
}

/** `canOpenAdminPath`: the three special rules in their order, then the map at view. */
function oracleCanOpen(matrix: AdminPermissionMatrix, pathname: string): boolean {
  const normalized = oracleNormalize(pathname);
  if (oracleIsAnyAdmin(pathname)) return anyArea(matrix);
  if (underPrefix(normalized, ORACLE_FEES_PATH)) {
    return matrix.bookings !== "none" || matrix.finance !== "none";
  }
  if (underPrefix(normalized, ORACLE_ROOMS_BEDS_PATH)) {
    return matrix.lodge !== "none" || matrix.bookings !== "none";
  }
  const requirement = oracleRequirement(pathname, "GET");
  return RANK[matrix[requirement.area]] >= RANK[requirement.level];
}

/** `canViewAdminHrefWithMatrix`: admission paths, then the map. No OR rules. */
function oracleCanView(matrix: AdminPermissionMatrix, pathname: string): boolean {
  if (oracleIsAnyAdmin(pathname)) return anyArea(matrix);
  const requirement = oracleRequirement(pathname, "GET");
  return RANK[matrix[requirement.area]] >= RANK[requirement.level];
}

/** `normaliseForRules` in `feature-routes.ts`: one trailing slash, one data suffix. */
function oracleNormaliseForRules(pathname: string): string {
  const strip = (p: string) => (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p);
  const trimmed = strip(pathname);
  const suffix = [".rsc", ".json"].find(
    (candidate) => trimmed.length > candidate.length && trimmed.endsWith(candidate),
  );
  return suffix ? strip(trimmed.slice(0, -suffix.length)) : trimmed;
}

/** `getRequiredFeaturesForPath` for an admin page path, in rule order. */
function oracleFlags(pathname: string): FeatureFlagKey[] {
  const path = oracleNormaliseForRules(pathname);
  return ORACLE_MODULE_GATES.filter(
    (rule) =>
      !(rule.exemptPaths ?? []).includes(path) &&
      rule.prefixes.some((prefix) => underPrefix(path, prefix)),
  ).map((rule) => rule.flag);
}

function oracleFirstAccessible(matrix: AdminPermissionMatrix): string | null {
  return ORACLE_FIRST_ACCESSIBLE.find(([area]) => matrix[area] !== "none")?.[1] ?? null;
}

// --- subjects ----------------------------------------------------------------

type Subject = { label: string; input: AdminPermissionInput };

/**
 * The sixteen sweep grids, then every seeded role both ways it can reach the
 * resolver: a bare enum value (the legacy bundle, and the protected roles), and
 * each seeded definition joined as the database row.
 */
const SUBJECTS: Subject[] = [
  ...SWEEP_GRIDS.map((grid) => ({ label: grid.label, input: grid.member })),
  ...Object.values(AccessRole).map((role) => ({
    label: `enum ${role}`,
    input: { canLogin: true, accessRoles: [role] },
  })),
  ...DEFAULT_ACCESS_ROLE_DEFINITIONS.map((definition) => ({
    label: `seeded definition ${definition.key}`,
    input: {
      canLogin: true,
      accessRoles: [
        {
          role: definition.systemRole,
          roleDefinitionId: definition.id,
          roleDefinition: definition,
        },
      ],
    },
  })),
];

// --- probes ------------------------------------------------------------------

/** A concrete URL for a registry path: every `[name]` filled with `x123`. */
function concrete(registryPath: string): string {
  return registryPath.replace(/\[[^\]/]+\]/g, "x123");
}

/**
 * Every path probed for one page: the page itself, a child below it, its
 * trailing-slash spelling, and every static directory above it below `/admin`.
 */
function probesFor(pagePath: string): string[] {
  const segments = pagePath.split("/").slice(2);
  const ancestors = segments.map((_, index) => `/admin/${segments.slice(0, index + 1).join("/")}`);
  return [...ancestors, `${pagePath}/x123`, `${pagePath}/`];
}

/** One path's whole observable answer, as the real functions give it. */
function actualAnswer(pathname: string) {
  return {
    get: getAdminRouteRequirement(pathname, "GET"),
    post: getAdminRouteRequirement(pathname, "POST"),
    flags: getRequiredFeaturesForPath(pathname),
    open: SUBJECTS.map((subject) => canOpenAdminPath(subject.input, pathname)),
    sidebar: SUBJECTS.map((subject) =>
      canViewAdminHrefWithMatrix(getAdminPermissionMatrix(subject.input), pathname),
    ),
  };
}

/** The same answer from the oracle. */
function oracleAnswer(pathname: string) {
  return {
    get: oracleRequirement(pathname, "GET"),
    post: oracleRequirement(pathname, "POST"),
    flags: oracleFlags(pathname),
    open: SUBJECTS.map((subject) =>
      oracleCanOpen(getAdminPermissionMatrix(subject.input), pathname),
    ),
    sidebar: SUBJECTS.map((subject) =>
      oracleCanView(getAdminPermissionMatrix(subject.input), pathname),
    ),
  };
}

/** Each field that differs, with the subjects it differs for. */
function differences(
  label: string,
  actual: ReturnType<typeof actualAnswer>,
  expected: ReturnType<typeof oracleAnswer>,
): string[] {
  const found: string[] = [];
  for (const key of ["get", "post", "flags"] as const) {
    if (JSON.stringify(actual[key]) !== JSON.stringify(expected[key])) {
      found.push(`${label} ${key}: ${JSON.stringify(actual[key])}, oracle ${JSON.stringify(expected[key])}`);
    }
  }
  for (const key of ["open", "sidebar"] as const) {
    const who = SUBJECTS.filter((_, index) => actual[key][index] !== expected[key][index]);
    if (who.length > 0) {
      found.push(`${label} ${key} differs for ${who.map((subject) => subject.label).join(", ")}`);
    }
  }
  return found;
}

function pageLabel(page: AdminHubPage, probe: string): string {
  return `${page.id} (${probe})`;
}

describe("the census covers what it says", () => {
  it("sweeps the sixteen grids and every seeded role", () => {
    expect(SWEEP_GRIDS).toHaveLength(16);
    expect(SUBJECTS.length).toBe(16 + Object.values(AccessRole).length + DEFAULT_ACCESS_ROLE_DEFINITIONS.length);
    expect(DEFAULT_ACCESS_ROLE_DEFINITIONS.length).toBeGreaterThanOrEqual(6);
  });

  it("probes every registry page", () => {
    expect(ADMIN_PAGES.length).toBeGreaterThan(100);
  });

  it("has an oracle that refuses and admits, rather than one answer for everyone", () => {
    // Non-vacuous: across the census some subject is refused a page and some
    // subject is admitted to every page, so `open` cannot pass by being constant.
    const answers = ADMIN_PAGES.map((page) => oracleAnswer(concrete(page.oldPath)).open);
    expect(answers.every((open) => open.some(Boolean))).toBe(true);
    expect(answers.every((open) => open.some((admitted) => !admitted))).toBe(true);
  });
});

describe("every page's OLD path answers exactly as main's hand-written map did", () => {
  it("for the page, a child, its trailing slash and every directory above it", () => {
    const drift = ADMIN_PAGES.flatMap((page) =>
      [concrete(page.oldPath), ...probesFor(concrete(page.oldPath))].flatMap((probe) =>
        differences(pageLabel(page, probe), actualAnswer(probe), oracleAnswer(probe)),
      ),
    );
    expect(drift).toEqual([]);
  });

  it("lands every subject where main's getFirstAccessibleAdminHref did", () => {
    const drift = SUBJECTS.flatMap((subject) => {
      const actual = getFirstAccessibleAdminHref(subject.input);
      const expected = oracleFirstAccessible(getAdminPermissionMatrix(subject.input));
      return actual === expected ? [] : [`${subject.label}: ${actual}, oracle ${expected}`];
    });
    expect(drift).toEqual([]);
  });
});
