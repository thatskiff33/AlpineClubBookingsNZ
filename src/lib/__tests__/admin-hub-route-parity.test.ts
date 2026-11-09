import { AccessRole } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { DEFAULT_ACCESS_ROLE_DEFINITIONS } from "@/lib/access-role-definitions";
import {
  ADMIN_PERMISSION_AREAS,
  ADMIN_ROUTE_MAP,
  ANY_ADMIN_ADMISSION_PATHS,
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
import {
  FEATURE_ROUTE_RULES,
  getRequiredFeaturesForPath,
} from "@/config/feature-routes";
import type { FeatureFlagKey } from "@/config/schema";
import { ADMIN_HUBS, ADMIN_PAGES } from "@/lib/admin-hubs";
import { hubRoot, type AdminHubPage } from "@/lib/admin-hubs/define";
import {
  ADMIN_PAGE_ADMISSION_PATHS,
  ADMIN_PAGE_MODULE_GATES,
  ADMIN_PAGE_ROUTE_AREAS,
} from "@/lib/admin-hubs/security-map";
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
// A page added after C2 in a NEW directory has no row in the frozen tables, so
// the oracle sends it to its catch-all and this census fails: give the oracle
// its reviewed answer, the same review a hand-written route-map entry always
// had. A page added beneath an existing directory is held to that directory's.
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

/**
 * Each old-path probe of a page beside its twin in the page's hub. Relocation
 * keeps the part of the path below each directory, so a directory's twin is the
 * hub path with that same tail removed.
 */
function twinProbes(page: AdminHubPage): Array<[old: string, hub: string]> {
  const oldPath = concrete(page.oldPath);
  const hubPath = concrete(page.hubPath);
  const twin = (probe: string) => {
    if (!probe.startsWith(oldPath)) {
      const tail = oldPath.slice(probe.length);
      if (!hubPath.endsWith(tail)) throw new Error(`${page.id}: no twin for ${probe}`);
      return hubPath.slice(0, hubPath.length - tail.length);
    }
    return `${hubPath}${probe.slice(oldPath.length)}`;
  };
  return [oldPath, ...probesFor(oldPath)].map((probe) => [probe, twin(probe)]);
}

/** `candidate` is `root` or sits beneath it, `/`-anchored as every resolver matches. */
function nestsUnder(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

const HUB_ROOTS = ADMIN_HUBS.map((hub) => hubRoot(hub.prefix));

/** A generated path that sits beneath a hub's root rather than at an old path. */
function isHubHalf(path: string): boolean {
  return HUB_ROOTS.some((root) => path !== root && nestsUnder(path, root));
}

/** The route-map entry the resolver takes for a path: the FIRST that matches. */
function firstMatch(pathname: string) {
  return ADMIN_ROUTE_MAP.find(({ prefix }) => nestsUnder(oracleNormalize(pathname), prefix));
}

describe("the census covers what it says", () => {
  it("sweeps the sixteen grids and every seeded role", () => {
    expect(SWEEP_GRIDS).toHaveLength(16);
    expect(SUBJECTS.length).toBe(16 + Object.values(AccessRole).length + DEFAULT_ACCESS_ROLE_DEFINITIONS.length);
    expect(DEFAULT_ACCESS_ROLE_DEFINITIONS.length).toBeGreaterThanOrEqual(6);
  });

  it("probes every registry page, and nearly every one has a hub path of its own", () => {
    expect(ADMIN_PAGES.length).toBeGreaterThan(100);
    // Only Home's dashboard is its hub's root, so its hub path is its old path.
    expect(ADMIN_PAGES.filter((page) => page.hubPath === page.oldPath).map((page) => page.id)).toEqual([
      "dashboard",
    ]);
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

describe("every page's HUB path answers exactly as its old path did on main", () => {
  it("for the page, a child, its trailing slash and every directory above it", () => {
    const drift = ADMIN_PAGES.flatMap((page) =>
      twinProbes(page).flatMap(([oldProbe, hubProbe]) =>
        differences(
          `${pageLabel(page, hubProbe)} (twin of ${oldProbe})`,
          actualAnswer(hubProbe),
          oracleAnswer(oldProbe),
        ),
      ),
    );
    expect(drift).toEqual([]);
  });
});

describe("no registered page falls through to the overview catch-all", () => {
  it("resolves every page's old and hub path through an entry generated for it", () => {
    const fallsThrough = ADMIN_PAGES.flatMap((page) =>
      [page.oldPath, page.hubPath].map(concrete).flatMap((pathname) => {
        const entry = firstMatch(pathname);
        if (!entry || entry.prefix === "/admin") return [`${page.id}: ${pathname} reaches the catch-all`];
        // The first-match read here must be the real resolver's.
        const actual = getAdminRouteRequirement(pathname, "GET")?.area;
        return actual === entry.area ? [] : [`${page.id}: ${pathname} resolves ${actual}, first entry ${entry.prefix} says ${entry.area}`];
      }),
    );
    expect(fallsThrough).toEqual([]);
  });

  it("keeps the catch-all itself, last", () => {
    expect(ADMIN_ROUTE_MAP.at(-1)?.area).toBe("overview");
    expect(ADMIN_ROUTE_MAP.filter(({ area }) => area === "overview").slice(-2).map(({ prefix }) => prefix)).toEqual([
      "/admin",
      "/api/admin",
    ]);
  });
});

/**
 * THE ORDERING CENSUS. The resolver takes the FIRST matching prefix, not the
 * longest, so an entry that precedes a LONGER entry nested beneath it, with a
 * different area, would capture that entry's paths. Nothing else guards this:
 * the generator sorts deepest first, and the hand-written `/api/admin` half is
 * kept in its reviewed order.
 */
describe("the route map's order", () => {
  function shadowed(map: ReadonlyArray<{ area: string; prefix: string }>): string[] {
    return map.flatMap((earlier, i) =>
      map
        .slice(i + 1)
        .filter(
          (later) =>
            later.prefix !== earlier.prefix &&
            nestsUnder(later.prefix, earlier.prefix) &&
            later.area !== earlier.area,
        )
        .map((later) => `${earlier.prefix} (${earlier.area}) precedes ${later.prefix} (${later.area})`),
    );
  }

  it("never puts a shorter prefix of another area ahead of a longer one beneath it", () => {
    expect(shadowed(ADMIN_ROUTE_MAP)).toEqual([]);
  });

  it("has nested prefixes of different areas to order, old and hub alike", () => {
    // Non-vacuous: the census really is deciding something.
    const nested = ADMIN_ROUTE_MAP.flatMap((outer) =>
      ADMIN_ROUTE_MAP.filter(
        (inner) =>
          inner.prefix !== outer.prefix &&
          outer.prefix !== "/admin" &&
          outer.prefix !== "/api/admin" &&
          nestsUnder(inner.prefix, outer.prefix) &&
          inner.area !== outer.area,
      ).map((inner) => inner.prefix),
    );
    expect(nested).toEqual(
      expect.arrayContaining([
        "/admin/setup/finance",
        "/admin/setup/booking-rules",
        "/admin/settings/setup/finance",
        "/admin/rules/setup/booking-rules",
      ]),
    );
  });

  it("catches a shorter prefix moved ahead", () => {
    const setup = ADMIN_ROUTE_MAP.find(({ prefix }) => prefix === "/admin/setup")!;
    const reordered = [setup, ...ADMIN_ROUTE_MAP.filter((entry) => entry !== setup)];
    expect(shadowed(reordered)).toEqual(
      expect.arrayContaining(["/admin/setup (support) precedes /admin/setup/finance (finance)"]),
    );
  });
});

/**
 * The C2 transition, stated structurally as well as behaviourally: the OLD half
 * the generator emits IS main's hand-written page half, entry for entry, plus an
 * explicit `overview` entry for each of the three directories that used to rely
 * on the catch-all (which answers `overview` too). Set equality plus the
 * ordering census means every old path resolves as it did, not just the probes.
 */
describe("the generated old half is main's hand-written page half", () => {
  const EXPLICIT_OVERVIEW = ["/admin/ai-diagnostics", "/admin/dashboard", "/admin/testing"];

  it("has the same route-map entries", () => {
    const generated = ADMIN_PAGE_ROUTE_AREAS.filter(({ prefix }) => !isHubHalf(prefix))
      .map(({ prefix, area }) => `${prefix} ${area}`)
      .sort();
    const oracle = [
      ...ORACLE_ROUTE_AREAS.flatMap(({ area, prefixes }) =>
        prefixes.filter((prefix) => prefix !== "/admin").map((prefix) => `${prefix} ${area}`),
      ),
      ...EXPLICIT_OVERVIEW.map((prefix) => `${prefix} overview`),
    ].sort();
    expect(generated).toEqual(oracle);
    // The page half precedes the hand-written half and is all of `/admin/*`.
    const pageHalf = ADMIN_ROUTE_MAP.slice(0, ADMIN_PAGE_ROUTE_AREAS.length);
    expect(pageHalf).toEqual(ADMIN_PAGE_ROUTE_AREAS);
    expect(
      ADMIN_ROUTE_MAP.slice(ADMIN_PAGE_ROUTE_AREAS.length).filter(
        ({ prefix }) => prefix.startsWith("/admin/"),
      ),
    ).toEqual([]);
  });

  it("has the same module gates, and the one exemption at both paths", () => {
    const generated = [...ADMIN_PAGE_MODULE_GATES].flatMap(([flag, prefixes]) =>
      prefixes.filter((prefix) => !isHubHalf(prefix)).map((prefix) => `${flag} ${prefix}`),
    );
    const oracle = ORACLE_MODULE_GATES.flatMap(({ flag, prefixes }) =>
      prefixes.map((prefix) => `${flag} ${prefix}`),
    );
    expect(generated.sort()).toEqual(oracle.sort());
    const exempt = FEATURE_ROUTE_RULES.flatMap((rule) =>
      (rule.exemptPaths ?? [])
        .filter((path) => path.startsWith("/admin/"))
        .map((path) => `${rule.flag} ${path}`),
    );
    expect(exempt).toEqual([
      "lobbyDisplay /admin/display/setup",
      "lobbyDisplay /admin/lodge-ops/display/setup",
    ]);
  });

  it("has the same admission paths, each with its hub twin", () => {
    expect(ADMIN_PAGE_ADMISSION_PATHS["any-admin"].filter((path) => !isHubHalf(path))).toEqual(
      ORACLE_ANY_ADMIN_PATHS,
    );
    expect(ADMIN_PAGE_ADMISSION_PATHS["fees-or"].filter((path) => !isHubHalf(path))).toEqual([
      ORACLE_FEES_PATH,
    ]);
    expect(ADMIN_PAGE_ADMISSION_PATHS["rooms-beds-or"].filter((path) => !isHubHalf(path))).toEqual([
      ORACLE_ROOMS_BEDS_PATH,
    ]);
    expect(ANY_ADMIN_ADMISSION_PATHS).toEqual(ADMIN_PAGE_ADMISSION_PATHS["any-admin"]);
    for (const paths of Object.values(ADMIN_PAGE_ADMISSION_PATHS)) {
      expect(paths.filter(isHubHalf)).toHaveLength(paths.length / 2);
    }
  });
});
