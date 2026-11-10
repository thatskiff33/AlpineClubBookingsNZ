import type { FinanceAccessLevel, Role } from "@prisma/client";
import {
  authorizationRoleFromAccessRoles,
  hasAdminAccess,
  isAccessRole,
  type AccessRoleDefinitionLevelFields,
  type PrivilegeCheckInput,
  type AppAccessRole,
} from "@/lib/access-roles";
import { adminHref, isInexactAdminPagePath } from "@/lib/admin-hubs";
import {
  ADMIN_PAGE_ADMISSION_PATHS,
  ADMIN_PAGE_ROUTE_AREAS,
} from "@/lib/admin-hubs/security-map";

export const ADMIN_PERMISSION_LEVELS = ["none", "view", "edit"] as const;
export type AdminPermissionLevel = (typeof ADMIN_PERMISSION_LEVELS)[number];

export const ADMIN_PERMISSION_AREAS = [
  {
    key: "overview",
    label: "Admin Overview",
    description: "Dashboard and cross-area entry points.",
  },
  {
    key: "bookings",
    label: "Bookings & Beds",
    description: "Bookings, public booking requests, booking policy, waitlist, and bed allocation.",
  },
  {
    key: "membership",
    label: "Membership",
    description: "Members, applications, family links, memberships, inductions, and communications.",
  },
  {
    key: "finance",
    label: "Finance",
    description: "Payments, subscriptions, refunds, reports, Xero sync, and accounting setup.",
  },
  {
    key: "lodge",
    label: "Lodge Operations",
    description: "Hut leaders, rosters, chores, work parties, lodge settings, rooms, and beds.",
  },
  {
    key: "content",
    label: "Content",
    description: "Page content, site chrome, banners, public images, and site style.",
  },
  {
    key: "support",
    label: "Support & System",
    description: "Setup, modules, health, deliverability, audit, issue reports, and operational diagnostics.",
  },
] as const;

export type AdminPermissionArea = (typeof ADMIN_PERMISSION_AREAS)[number]["key"];
export type AdminPermissionMatrix = Record<
  AdminPermissionArea,
  AdminPermissionLevel
>;

export type AdminAccessRequirement = {
  area: AdminPermissionArea;
  level: Exclude<AdminPermissionLevel, "none">;
};

const LEVEL_RANK: Record<AdminPermissionLevel, number> = {
  none: 0,
  view: 1,
  edit: 2,
};

const EMPTY_MATRIX = Object.fromEntries(
  ADMIN_PERMISSION_AREAS.map((area) => [area.key, "none"]),
) as AdminPermissionMatrix;

/**
 * Legacy hardcoded bundles. `ADMIN` is the protected Full Admin matrix and is
 * always resolved from here, never from the database. Every other entry is
 * only a mid-deploy/pre-seed fallback for assignment rows whose
 * AccessRoleDefinition was not joined or has not been linked yet — the
 * database definitions (seeded identical to these, then club editable) are
 * authoritative. The fallback's failure mode is "yesterday's behavior",
 * never wider access.
 */
const ADMIN_ROLE_BUNDLES: Partial<
  Record<AppAccessRole, Partial<AdminPermissionMatrix>>
> = {
  ADMIN: {
    overview: "edit",
    bookings: "edit",
    membership: "edit",
    finance: "edit",
    lodge: "edit",
    content: "edit",
    support: "edit",
  },
  ADMIN_READONLY: {
    overview: "view",
    bookings: "view",
    membership: "view",
    finance: "view",
    lodge: "view",
    content: "view",
    support: "view",
  },
  ADMIN_BOOKINGS: {
    overview: "view",
    bookings: "edit",
    membership: "view",
    finance: "view",
    lodge: "edit",
    support: "view",
  },
  ADMIN_MEMBERSHIP: {
    overview: "view",
    bookings: "view",
    membership: "edit",
    finance: "view",
    support: "view",
  },
  ADMIN_CONTENT: {
    overview: "view",
    content: "edit",
  },
  FINANCE_ADMIN: {
    overview: "view",
    bookings: "view",
    membership: "view",
    finance: "edit",
    support: "view",
  },
  FINANCE_USER: {
    finance: "view",
  },
};

/**
 * Rooms & Beds — the room/bed inventory page, and since #2937 the home of each
 * lodge's allocation preferences — as the Bed Allocation board's signpost links
 * it. Its area, its OR admission and its module gate are all generated from the
 * same registry entry (#4799), so the link cannot drift from the rules.
 */
export const ROOMS_BEDS_PATH = adminHref("rooms-beds");

/**
 * THE ROUTE MAP. The resolver takes the FIRST entry with a matching prefix, not
 * the longest.
 *
 * The PAGE half is generated from the hub registry (`src/lib/admin-hubs/`,
 * #4799), for every page's old path and its hub path, deepest prefix first: a
 * new admin page gets its area from its registry entry, and the reasoning for an
 * area sits on that entry. The `/api/admin` half below is hand-written and stays
 * in its reviewed order; no API path can match a page prefix, or the reverse.
 * `/admin` and `/api/admin` are the catch-all, last.
 */
const ROUTE_AREA_PREFIXES: Array<{
  area: AdminPermissionArea;
  prefixes: readonly string[];
}> = [
  ...ADMIN_PAGE_ROUTE_AREAS.map(({ area, prefix }) => ({ area, prefixes: [prefix] })),
  {
    area: "finance",
    prefixes: [
      // Alpine Central Server (ServerNZ) integration lives on the Integrations
      // hub (finance), like Xero/Stripe/Google. Off with the alpineCentralServer
      // module (`FEATURE_ROUTE_RULES`), page and API alike.
      "/api/admin/alpine-server",
      "/api/admin/integrations",
      "/api/admin/xero",
      "/api/admin/payments",
      "/api/admin/internet-banking-settings",
      "/api/admin/refund-requests",
      "/api/admin/reports",
      "/api/admin/subscriptions",
      "/api/admin/subscription-billing",
      "/api/admin/fee-configuration",
      "/api/admin/credit-approvals",
      "/api/admin/setup/finance-report-mappings",
      "/api/finance",
    ],
  },
  {
    area: "bookings",
    prefixes: [
      "/api/admin/bookings",
      "/api/admin/booking-requests",
      "/api/admin/booking-reviews",
      "/api/admin/booking-change-requests",
      // Unified officer exception-request queue (#2524): same class of
      // officer surface as booking-change-requests above, so it shares the
      // bookings area rather than falling through to the overview catch-all.
      "/api/admin/booking-exception-requests",
      "/api/admin/bed-allocation",
      "/api/admin/occupancy",
      "/api/admin/waitlist",
      "/api/admin/booking-policies",
      // Member-guest policy settings (epic #2305, MG2 #2307, owner decision
      // D-17). Booking policy, not membership admin: it configures how a guest
      // is added to a BOOKING (ask-first vs notify-only, how long a pending
      // guest holds the bed), so it sits with booking-requests/settings and
      // booking-policies rather than under /api/admin/member*. bookings:view
      // reads the card, bookings:edit saves it.
      "/api/admin/member-guest-settings",
      "/api/admin/seasons",
      "/api/admin/age-tier-settings",
      "/api/admin/promo-codes",
    ],
  },
  {
    area: "membership",
    prefixes: [
      "/api/admin/members",
      "/api/admin/member-applications",
      "/api/admin/induction-templates",
      "/api/admin/membership-cancellation",
      "/api/admin/membership-cancellations",
      "/api/admin/membership-cancellation-requests",
      "/api/admin/membership-cancellation-settings",
      "/api/admin/membership-lockout-settings",
      "/api/admin/membership-types",
      "/api/admin/subscription-categories",
      "/api/admin/member-fields",
      "/api/admin/induction",
      "/api/admin/inductions",
      "/api/admin/communications",
      "/api/admin/notices",
      "/api/admin/lockers",
      "/api/admin/club-posts",
      "/api/admin/family-groups",
      "/api/admin/family-suggestions",
      "/api/admin/deletion-requests",
      "/api/admin/committee",
      "/api/admin/membership-nomination-settings",
      "/api/admin/member-lifecycle-action-requests",
    ],
  },
  {
    area: "lodge",
    prefixes: [
      "/api/admin/hut-leaders",
      "/api/admin/roster",
      "/api/admin/chores",
      "/api/admin/lodge",
      "/api/admin/lodges",
      // Registry of other clubs' lodges (#2749), downloaded from the central
      // server; only the club's own entry is editable (#52). Distinct prefix from
      // "/api/admin/lodges" so it does not fall through to the overview catch-all.
      "/api/admin/other-lodges",
      "/api/admin/work-parties",
      "/api/admin/lodge-instructions",
      "/api/admin/lodge-settings",
      // Lobby display management (#27/#33, epic #25): lodge operations.
      "/api/admin/display",
      // Maintenance reports (#2780). "The maintenance officer" is not a role in
      // this product and must not become one: it is whoever the club has given
      // Lodge Operations to. So the queue, the question set, the settings and
      // the per-lodge QR tokens all sit in the `lodge` area, and the alert
      // audience is `{ area: "lodge", level: "edit" }` — see
      // ADMIN_NOTIFICATION_PREFERENCE_REQUIREMENT.
      "/api/admin/maintenance-reports",
    ],
  },
  {
    area: "content",
    prefixes: [
      "/api/admin/page-content",
      "/api/admin/public-content-settings",
      // Public Contact page committee-role selector (Club Contact panel).
      "/api/admin/club-contact",
      // DB-first club identity + lodge-details editing (E3 #1929): site chrome.
      "/api/admin/club-identity",
      "/api/admin/site-banners",
      "/api/admin/site-content",
      "/api/admin/image-manager",
      "/api/admin/image-library",
      "/api/admin/site-images",
      "/api/admin/site-style",
      "/api/admin/mountain-conditions",
    ],
  },
  {
    area: "support",
    prefixes: [
      // Club Time — the one persisted IANA club timezone (CT-1 #2989, epic
      // #2988). Registered under support alongside /admin/modules and
      // /admin/config-transfer so an unregistered path never falls back to the
      // overview catch-all and the sidebar's matrix check resolves. The AREA
      // only decides who can reach the surface: reading AND changing the club
      // timezone remain Full Admin regardless of area level (enforced in the
      // routes), exactly like the backups credential + destination writes below.
      "/api/admin/club-time-zone",
      // Club Format — the one persisted currency and locale (#3563, programme
      // #3205). Registered under support for the same reason as
      // /admin/club-time above: so an unregistered path never falls back to
      // the overview catch-all. The AREA decides nothing else (#3596): the
      // page is opened on ADMISSION (`ANY_ADMIN_ADMISSION_PATHS`), and each
      // API verb carries its own explicit gate — any admin reads, Full Admin writes.
      "/api/admin/club-format",
      // Environment safety — whether this installation is the club's live site
      // or a copy (ENV-SAFETY 1 #3034, epic #2986). Registered under support for
      // the same reason as /admin/club-time and /admin/backups: so an
      // unregistered path never falls back to the overview catch-all and the
      // sidebar's matrix check resolves. The AREA only decides who can reach the
      // surface; CHANGING the safer override is Full Admin regardless of area
      // level, enforced in the route itself.
      //
      // Reading the role is NOT Full-Admin-only, and this comment used to say it
      // was (#3034 review). The effective role, the declaration state and the
      // sanitized refused value all reach `support:view` through
      // `GET /api/admin/setup` -> `buildEnvironmentRoleCheck`, which is
      // deliberate: the issue asks that authorized setup/admin UI show whether
      // the role is production, non-production or unknown and why. What is
      // Full-Admin-only is this page and this API, and the write.
      "/api/admin/environment-safety",
      "/api/admin/access-roles",
      "/api/admin/config-transfer",
      "/api/admin/setup",
      "/api/admin/modules",
      // Login & Security config API (epic #2030, child #2033): support-area
      // system configuration, same as /api/admin/modules.
      "/api/admin/security",
      "/api/admin/privacy-retention",
      "/api/admin/notifications",
      "/api/admin/notification-delivery-policies",
      "/api/admin/booking-messages",
      "/api/admin/email",
      "/api/admin/email-failures",
      "/api/admin/email-templates",
      "/api/admin/email-settings",
      "/api/admin/email-suppressions",
      "/api/admin/health",
      // Managed database backup: status, config, and run-now (#2095, C6).
      // Support view = status; support edit = config/run-now; credential +
      // destination WRITES remain Full Admin regardless of area level
      // (enforced in the routes).
      "/api/admin/backups",
      "/api/admin/runtime-status",
      "/api/admin/stuck-states",
      "/api/admin/issue-reports",
      "/api/admin/audit-log",
      // AI help assistant usage + spend-cap settings (#2211, C3). Registered
      // under support alongside /api/admin/modules — support view = usage panel,
      // support edit = budget-cap change. The Anthropic key WRITE stays Full
      // Admin on the credentials route regardless of area level. (The admin page
      // /admin/ai-assistant takes the same area from its registry entry.)
      "/api/admin/ai-assistant",
      // AI Diagnostics (AID-2, #2371) — a SEPARATE admin-only paid product.
      // Registered under support so its budget + readiness API never falls back
      // to the overview catch-all: support view = readiness/status, support edit
      // = budget change. The DEDICATED Anthropic key WRITE stays Full Admin on the
      // shared credentials route regardless of area level.
      //
      // THE API IS HERE; THE PAGE DELIBERATELY IS NOT (AID-7, #2378). This list
      // used to carry "/admin/ai-diagnostics" too, added in anticipation of a UI
      // that did not exist yet, with a comment saying the page would "resolve here
      // too". The owner's later Q6 decision on #2378 went the other way and is
      // authoritative: ANY admitted administrator may OPEN the Diagnostics
      // workspace, and the shell must not itself become a support permission —
      // otherwise the "here is who can fix this" message is hidden from precisely
      // the admins who need to read it.
      //
      // Nothing is loosened by that. Opening the shell grants no evidence: every
      // tool invocation re-derives the acting admin's areas server-side and refuses
      // what they may not read, the DETAILED readiness panel on the page is gated on
      // support:view in its own right, and every /api/admin/ai-diagnostics route
      // stays here. The page's registry entry says `overview`, admitted on
      // `any-admin` (#4799 generates an explicit `overview` entry for it rather
      // than leaving it to the catch-all), and OVERVIEW_ALLOWLIST records why.
      "/api/admin/ai-diagnostics",
      // The NZD -> club-currency rate for AI spend (#3354): ONE setting shared by
      // both AI modules, so its own prefix; same levels as the two budget routes.
      "/api/admin/ai-spend-currency",
    ],
  },
  {
    area: "overview",
    prefixes: ["/admin", "/api/admin"],
  },
];

/**
 * The whole route map, flattened in resolution order and frozen: for the hub
 * registry's prefix census (#4798), which must see rules BELOW a hub root, and
 * for the ordering census (#4799). Resolution never reads it.
 */
export const ADMIN_ROUTE_MAP: ReadonlyArray<
  Readonly<{ area: AdminPermissionArea; prefix: string }>
> = Object.freeze(
  ROUTE_AREA_PREFIXES.flatMap(({ area, prefixes }) =>
    prefixes.map((prefix) => Object.freeze({ area, prefix })),
  ),
);

const EDIT_ON_GET_PREFIXES = [
  "/api/admin/xero/callback",
  "/api/admin/xero/connect",
] as const;

const SPECIAL_ROUTE_AREA_PATTERNS: Array<{
  area: AdminPermissionArea;
  pattern: RegExp;
}> = [
  {
    area: "finance",
    pattern: /^\/api\/admin\/members\/[^/]+\/credits(?:\/[^/]+)?$/,
  },
  {
    area: "finance",
    pattern: /^\/api\/admin\/members\/[^/]+\/xero-(?:link|push|unlink)$/,
  },
  // B5 (#2262): the path prefix says "bookings", but recording a booking's
  // payment as cash / an off-Xero bank transfer (and reversing it) is a MONEY
  // action, so it is gated finance:edit like its subscription sibling.
  {
    area: "finance",
    pattern: /^\/api\/admin\/bookings\/[^/]+\/mark-paid$/,
  },
  // #3214 (epic #2797): the same shape as the row above. Recording what a
  // booking guest's nights sold for writes money evidence - it is fenced so it
  // cannot change what anybody owes, but what it records is what a refund will
  // one day be computed from - so it is gated finance:edit despite the
  // bookings-shaped path, and the handler declares the same requirement.
  {
    area: "finance",
    pattern: /^\/api\/admin\/bookings\/[^/]+\/stored-night-prices$/,
  },
];

function cloneEmptyMatrix(): AdminPermissionMatrix {
  return { ...EMPTY_MATRIX };
}

/** All-none matrix; the fail-closed default for session projection (#1367). */
export function emptyAdminPermissionMatrix(): AdminPermissionMatrix {
  return cloneEmptyMatrix();
}

function isAdminPermissionLevel(value: unknown): value is AdminPermissionLevel {
  return ADMIN_PERMISSION_LEVELS.includes(value as AdminPermissionLevel);
}

/**
 * Validate a matrix that travelled through an untyped channel (the JWT /
 * session, #1367). Returns null when the value is not an object at all;
 * otherwise every known area is kept only when it carries a valid level and
 * falls to "none" when missing or malformed — fail closed per area, so a
 * matrix minted before a new area existed denies that area instead of being
 * discarded (which would fall back to the wider enum-bundle derivation).
 */
export function sanitizeAdminPermissionMatrix(
  value: unknown,
): AdminPermissionMatrix | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const matrix = cloneEmptyMatrix();
  for (const area of ADMIN_PERMISSION_AREAS) {
    const level = (value as Record<string, unknown>)[area.key];
    if (isAdminPermissionLevel(level)) {
      matrix[area.key] = level;
    }
  }
  return matrix;
}

function maxLevel(
  current: AdminPermissionLevel,
  candidate: AdminPermissionLevel,
) {
  return LEVEL_RANK[candidate] > LEVEL_RANK[current] ? candidate : current;
}

function definitionLevelToAppLevel(
  level: AccessRoleDefinitionLevelFields[keyof AccessRoleDefinitionLevelFields] | undefined,
): AdminPermissionLevel | null {
  switch (level) {
    case "NONE":
      return "none";
    case "VIEW":
      return "view";
    case "EDIT":
      return "edit";
    default:
      return null;
  }
}

/** Permission matrix stored on an AccessRoleDefinition row. */
export function matrixFromAccessRoleDefinition(
  definition: Partial<AccessRoleDefinitionLevelFields>,
): AdminPermissionMatrix {
  const matrix = cloneEmptyMatrix();
  for (const area of ADMIN_PERMISSION_AREAS) {
    const level = definitionLevelToAppLevel(definition[`${area.key}Level`]);
    if (level) matrix[area.key] = level;
  }
  return matrix;
}

/** Merge = max level per area; used for both members and picker previews. */
export function mergeAdminPermissionMatrices(
  matrices: ReadonlyArray<Partial<AdminPermissionMatrix>>,
): AdminPermissionMatrix {
  const matrix = cloneEmptyMatrix();
  for (const candidate of matrices) {
    for (const area of ADMIN_PERMISSION_AREAS) {
      const level = candidate[area.key];
      if (!level) continue;
      matrix[area.key] = maxLevel(matrix[area.key], level);
    }
  }
  return matrix;
}

/**
 * PrivilegeCheckInput extended with the matrix a JWT session carries (#1367).
 * `session.user.accessRoles` is enum-only (definition-backed custom roles
 * have `role: null` and vanish from it), so the auth `jwt` callback embeds
 * the merged matrix computed from the DB-joined member instead, and every
 * session.user-based check reads it here. `canLogin` is required (#3603).
 */
export type AdminPermissionInput = PrivilegeCheckInput & {
  adminPermissionMatrix?: unknown;
};

/**
 * Merged permission matrix for a member's access-role assignments.
 *
 * An embedded `adminPermissionMatrix` (a session.user, #1367) is
 * AUTHORITATIVE and short-circuits role derivation: it was computed from the
 * DB-joined member — custom and club-edited definitions included — at the
 * per-request token refresh, so re-deriving from the enum-only role list
 * here could only be wrong in both directions (dropping custom roles,
 * or widening a seeded role whose definition the club narrowed below the
 * legacy bundle).
 *
 * Otherwise, per-row resolution, strictly in this order:
 * 1. `ADMIN` → the hardcoded Full Admin bundle, never the database.
 * 2. A joined `roleDefinition` (definition-backed or seeded-default row
 *    selected with the definition include) → that definition's matrix.
 * 3. A bare enum value → the legacy hardcoded bundle (mid-deploy/pre-seed
 *    fallback; identical to the seeded definitions until the club edits
 *    them).
 * 4. Anything unresolved (e.g. a custom-role row selected without its
 *    definition) contributes nothing — fail closed, never wider.
 */
export function getAdminPermissionMatrix(
  input: AdminPermissionInput,
): AdminPermissionMatrix {
  if (input.canLogin === false) return cloneEmptyMatrix();

  if ("adminPermissionMatrix" in input) {
    const embedded = sanitizeAdminPermissionMatrix(input.adminPermissionMatrix);
    if (embedded) return embedded;
  }

  const matrices: Array<Partial<AdminPermissionMatrix>> = [];
  for (const item of input.accessRoles ?? []) {
    const role = typeof item === "string" ? item : item.role;
    if (role === "ADMIN") {
      matrices.push(ADMIN_ROLE_BUNDLES.ADMIN ?? {});
      continue;
    }

    const definition = typeof item === "string" ? null : item.roleDefinition;
    if (definition) {
      matrices.push(matrixFromAccessRoleDefinition(definition));
      continue;
    }

    if (isAccessRole(role)) {
      const bundle = ADMIN_ROLE_BUNDLES[role];
      if (bundle) matrices.push(bundle);
    }
  }

  return mergeAdminPermissionMatrices(matrices);
}

// test seam
export function getAdminPermissionLevel(
  input: AdminPermissionInput,
  area: AdminPermissionArea,
): AdminPermissionLevel {
  return getAdminPermissionMatrix(input)[area];
}

/**
 * STANDING TO ENTER THE ADMIN PORTAL SHELL: any ONE of the seven admin-area
 * permissions (#2984, owner-gated privilege-model correction).
 *
 * This used to read `&& area.key !== "finance"`, so a finance-only grid had no
 * standing at all — while `getFirstAccessibleAdminHref` below happily sent the
 * same grid to `/admin/payments`. The module disagreed with itself, and #2925
 * hit the disagreement from the other side: `GET /api/admin/lodges` admits "any
 * admitted admin" and therefore refused "Finance Viewer" the lodge NAMES it
 * needs to label a payment, with the refusal recorded as a decision about this
 * function rather than about that endpoint. This is that decision.
 *
 * STANDING IS NOT AUTHORISATION, and the distinction is the whole of the
 * correction. Entering the shell grants nothing: every admin page still clears
 * `guardAdminLayout` step 6 (area permission for the REQUESTED path), every
 * `/api/admin` route still clears `requireAdmin` against its own area/level,
 * and the sidebar and command palette still filter item by item through
 * `canViewAdminHrefWithMatrix`. A finance-only user reaches the shell and the
 * Finance area and nothing else, which
 * `admin-route-authorization-proof.test.ts` proves by attempting every
 * discovered admin page and `/api/admin` route as that user (#2975).
 *
 * So the ONLY callers this function is correct for are the ones asking "is this
 * person an administrator at all" — the nav bar's Admin link, the
 * admin-notification recipient roster, and `requireAdmin`'s explicit
 * `permission: "any-admin"`. It is never a substitute for an area check, and a
 * caller that reasons "they cleared the shell, therefore they may see X" is a
 * privilege escalation as written.
 */
export function hasAdminPortalAccess(input: AdminPermissionInput) {
  return hasAnyAdminAreaFromMatrix(getAdminPermissionMatrix(input));
}

/**
 * The same question against an already-resolved matrix, for the callers that
 * hold one: the layout guard, and the ADR-002 admission rule below. One
 * definition, so "any one area" cannot come to mean two different things.
 */
export function hasAnyAdminAreaFromMatrix(matrix: AdminPermissionMatrix) {
  return ADMIN_PERMISSION_AREAS.some((area) => matrix[area.key] !== "none");
}

export function hasAdminAreaAccess(
  input: AdminPermissionInput,
  requirement: AdminAccessRequirement,
) {
  return (
    LEVEL_RANK[getAdminPermissionLevel(input, requirement.area)] >=
    LEVEL_RANK[requirement.level]
  );
}

/**
 * Where a refused or freshly signed-in administrator lands: the first area in
 * this order they hold at all, at that area's landing page. The pages are named
 * by registry id (#4799), so each lands at its old URL while the hubs are off
 * and at its hub URL once its hub has moved.
 */
const FIRST_ACCESSIBLE_ADMIN_HREFS: ReadonlyArray<
  readonly [AdminPermissionArea, string]
> = [
  ["overview", adminHref("dashboard")],
  ["bookings", adminHref("bookings")],
  ["membership", adminHref("members")],
  ["finance", adminHref("payments")],
  ["lodge", adminHref("hut-leaders")],
  ["content", adminHref("page-content")],
  ["support", adminHref("health")],
];

export function getFirstAccessibleAdminHref(input: AdminPermissionInput) {
  const matrix = getAdminPermissionMatrix(input);
  return FIRST_ACCESSIBLE_ADMIN_HREFS.find(([area]) => matrix[area] !== "none")?.[1] ?? null;
}

/** `pathname` is one of `paths` or sits beneath one, after normalising. */
function isUnderAnyPath(pathname: string, paths: readonly string[]): boolean {
  const normalized = normalizePathname(pathname);
  return paths.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  );
}

function normalizePathname(pathname: string) {
  const candidate = pathname.split(/[?#]/)[0] || "/";
  return candidate.endsWith("/") && candidate !== "/"
    ? candidate.replace(/\/+$/, "")
    : candidate;
}

function methodRequiresEdit(method?: string | null) {
  if (!method) return false;
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

export function getAdminRouteRequirement(
  pathname: string,
  method?: string | null,
): AdminAccessRequirement | null {
  const normalized = normalizePathname(pathname);
  const specialRoute = SPECIAL_ROUTE_AREA_PATTERNS.find(({ pattern }) =>
    pattern.test(normalized),
  );
  const route =
    specialRoute ??
    ROUTE_AREA_PREFIXES.find(({ prefixes }) =>
      prefixes.some(
        (prefix) =>
          normalized === prefix || normalized.startsWith(`${prefix}/`),
      ),
    );

  if (!route) return null;

  const forcedEdit = EDIT_ON_GET_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  );

  return {
    area: route.area,
    level: forcedEdit || methodRequiresEdit(method) ? "edit" : "view",
  };
}

/**
 * Admin paths admitted on ADMISSION rather than on an area: any account with
 * `view` or better on one admin area may open them. Each is its own owner
 * decision, never a precedent. `/admin/ai-diagnostics` (ADR-002 §1, ratified
 * #2370): the shell exposes no evidence — its readiness panel is tiered on
 * `support:view`, its budget card refuses without it, and every tool re-checks
 * its own area at invocation. `/admin/club-format` (#3596): any admin may VIEW
 * the currency and locale, read-only; `PUT /api/admin/club-format` is Full Admin.
 *
 * The Diagnostics map area stays `overview` (the LINK's area). Since #2984 "any
 * admitted admin" and `overview:view` are different sets — a finance-only grid
 * has standing without `overview` — so an `overview:view` rule would be a
 * carve-out, not the admission rule. Narrowing needs a fresh owner decision.
 *
 * Generated (#4799): each page's registry entry says `admission: "any-admin"`,
 * and the list holds its old path and its hub path.
 */
export const ANY_ADMIN_ADMISSION_PATHS: readonly string[] =
  ADMIN_PAGE_ADMISSION_PATHS["any-admin"];

export function isAnyAdminAdmissionPath(pathname: string): boolean {
  return isUnderAnyPath(pathname, ANY_ADMIN_ADMISSION_PATHS);
}

/**
 * MAY THIS PERSON OPEN THIS ADMIN PATH — the one implementation (#2975).
 *
 * The whole admission rule for a requested admin path, composed once: the two
 * adjudicated special cases first, then the route map's own area requirement.
 * `guardAdminLayout` step 6 and `/api/help/chat`'s surface downgrade both call
 * this, so the question "could they open this screen" has one answer wherever it
 * is asked. It was written out by hand in four places before this, and the fee
 * console's OR rule had two different spellings between them.
 *
 * A path the map cannot resolve is REFUSED rather than defaulted. Every admin
 * path resolves today — `/admin` and `/api/admin` are the map's catch-all, which
 * `admin-route-map-drift.test.ts` fails if that stops being true — so this is the
 * behaviour of an unreachable branch, and fail-closed is the right way for an
 * unreachable branch in an authorization decision to behave.
 *
 * It is the ADMISSION decision only. It says nothing about the level a WRITE
 * needs: `requireAdmin` resolves that per request method, and this always asks
 * the `GET` question because opening a screen is a read.
 */
export function canOpenAdminPath(
  input: AdminPermissionInput,
  pathname: string,
) {
  return canOpenAdminPathWithMatrix(getAdminPermissionMatrix(input), pathname);
}

/**
 * `canOpenAdminPath` for a matrix already in hand: the same rule, in one body,
 * for a hub card or link that must be offered exactly when its screen would
 * open (S1 #4796). It differs from `canViewAdminHrefWithMatrix`, the sidebar's
 * per-href filter, only on the two OR admissions (the fee console and Rooms &
 * Beds), which that filter does not apply.
 */
export function canOpenAdminPathWithMatrix(
  matrix: AdminPermissionMatrix,
  pathname: string,
) {
  // Fail closed on a page reached only through another spelling of its path.
  if (isInexactAdminPagePath(pathname)) return false;
  if (isAnyAdminAdmissionPath(pathname)) {
    return hasAnyAdminAreaFromMatrix(matrix);
  }
  if (isConsolidatedFeesPath(pathname)) {
    return canAccessConsolidatedFeesPage(matrix);
  }
  if (isRoomsBedsPath(pathname)) {
    return canAccessRoomsBedsPage(matrix);
  }
  const requirement = getAdminRouteRequirement(pathname, "GET");
  if (!requirement) return false;
  return LEVEL_RANK[matrix[requirement.area]] >= LEVEL_RANK[requirement.level];
}

/**
 * Matrix-based variant for client components (e.g. the admin sidebar), which
 * receive the precomputed matrix from a server layout instead of raw roles —
 * definitions live in the database and cannot be resolved client-side. An
 * admission path answers as `canOpenAdminPath` does, so a link to it can never
 * disagree with the page it opens (#3596).
 */
export function canViewAdminHrefWithMatrix(
  matrix: AdminPermissionMatrix,
  href: string,
) {
  if (isAnyAdminAdmissionPath(href)) return hasAnyAdminAreaFromMatrix(matrix);
  const requirement = getAdminRouteRequirement(href, "GET");
  if (!requirement) return false;
  return LEVEL_RANK[matrix[requirement.area]] >= LEVEL_RANK[requirement.level];
}

/**
 * The consolidated fee console (#1933, E7). It surfaces Hut Fees (historically
 * bookings), Joining Fees and Annual Fees (historically finance) on one page,
 * so admission is granted on view of EITHER area — a bookings-only editor and a
 * finance-only editor both reach it, and each section independently gates its
 * own edit controls by its historical area. The `getAdminRouteRequirement`
 * prefix keeps /admin/fees under bookings for the single-area drift guard; the
 * admin layout and sidebar consult these two helpers for the real OR rule.
 *
 * The paths are generated (#4799) from the registry entry that says
 * `admission: "fees-or"`: the console's old path and its hub path.
 */
export function isConsolidatedFeesPath(pathname: string): boolean {
  return isUnderAnyPath(pathname, ADMIN_PAGE_ADMISSION_PATHS["fees-or"]);
}

export function canAccessConsolidatedFeesPage(
  matrix: AdminPermissionMatrix,
): boolean {
  return matrix.bookings !== "none" || matrix.finance !== "none";
}

/**
 * Rooms & Beds (#2937), the second page whose admission is an OR — and for the
 * same reason as the fee console: it serves two areas at once.
 *
 * The route is registered under `lodge` because the inventory is lodge-scoped
 * (ADR-005). But EVERYTHING the page renders is bookings-gated:
 * `RoomsBedsManager` shows nothing at all below `bookings: view`, and its data
 * comes entirely from `/api/admin/bed-allocation/*`, which enforce the bookings
 * area. The page's own header comment has flagged that mismatch since #1548.
 *
 * #2937 made it load-bearing by moving the allocation preferences editor here
 * from the Bed Allocation board, where it needed `bookings: view` alone.
 * Without this rule it would need `bookings: view` AND `lodge: view`, and two
 * SEEDED roles — `FINANCE_ADMIN` and `ADMIN_MEMBERSHIP`, both `bookings: view`
 * with `lodge: none` — would follow the board's new signpost into a silent
 * redirect, the setting unreachable for them at any level.
 *
 * It only ever WIDENS. A bookings-area admin gets exactly what
 * `/api/admin/bed-allocation` already grants them; a lodge-only admin keeps the
 * (blank) page the manager has always rendered for them.
 *
 * The paths are generated (#4799) from the registry entry that says
 * `admission: "rooms-beds-or"`: the page's old path and its hub path.
 */
export function isRoomsBedsPath(pathname: string): boolean {
  return isUnderAnyPath(pathname, ADMIN_PAGE_ADMISSION_PATHS["rooms-beds-or"]);
}

export function canAccessRoomsBedsPage(
  matrix: AdminPermissionMatrix,
): boolean {
  return matrix.lodge !== "none" || matrix.bookings !== "none";
}

/**
 * Finance portal access derives from the merged finance area level of the
 * admin permission matrix: view ⇒ finance viewer, edit ⇒ finance manager.
 * Seeded "Treasurer" is finance edit and "Finance Viewer" is finance view,
 * both club-editable like any other definition-backed role.
 */
export function hasFinanceViewerAccess(input: AdminPermissionInput) {
  return LEVEL_RANK[getAdminPermissionMatrix(input).finance] >= LEVEL_RANK.view;
}

/**
 * Who may read the connected Xero organisation's summary — its name, short
 * code and base currency (#2314, owner decision 2 Aug 2026): an admin holding
 * the finance area at view or above. `GET /api/admin/xero/organisation` gates
 * on it (as the same literal, which the #2975 authorisation census reads off the
 * handler's source; a test pins that the two agree), and so does every server
 * surface that shows a value from that summary to an admin outside that route
 * (#3633, the base-currency warning on the Club Currency & Locale page and the
 * setup-readiness list), so the summary reaches exactly the same people
 * whichever screen shows it.
 */
export const XERO_ORGANISATION_READ_PERMISSION: AdminAccessRequirement = {
  area: "finance",
  level: "view",
};

export function hasFinanceManagerAccess(input: AdminPermissionInput) {
  return getAdminPermissionMatrix(input).finance === "edit";
}

/**
 * Legacy `Member.financeAccessLevel` compatibility value derived from the
 * merged matrix; synchronized on role writes for display/back-compat only —
 * runtime guards never read it.
 */
export function financeAccessLevelFromMatrix(
  matrix: AdminPermissionMatrix,
): FinanceAccessLevel {
  if (matrix.finance === "edit") return "MANAGER";
  if (matrix.finance === "view") return "VIEWER";
  return "NONE";
}

/**
 * Legacy authorization `Role` to use for member-facing booking-management
 * actions (modify / modify-quote / change-requests), where a Booking Officer
 * (the `bookings:edit` permission) acts with the SAME authority as a Full Admin
 * operating on-behalf-of the member — issue #1313, owner-approved option A2.
 *
 * This is intentionally a strict superset of `authorizationRoleFromAccessRoles`:
 * a Full Admin already resolves to `"ADMIN"` there (the `ADMIN` bundle carries
 * `bookings:edit`), so this returns `"ADMIN"` for them unchanged; a Booking
 * Officer (and any custom role granting `bookings:edit`) is mapped onto the
 * existing admin-on-behalf `"ADMIN"` path; every other actor keeps their legacy
 * authorization role verbatim (a plain member and a read-only admin both stay
 * `"USER"`). It does NOT invent a new privilege level — it maps a `bookings:edit`
 * holder onto the one admin-on-behalf code path the booking-modify engine
 * already keys off (`role === "ADMIN"`), so an officer and a Full Admin drive
 * byte-identical modify/quote/change-request behaviour.
 */
export function bookingManagementAuthorizationRole(input: AdminPermissionInput): Role {
  if (hasAdminAreaAccess(input, { area: "bookings", level: "edit" })) {
    return "ADMIN";
  }
  return authorizationRoleFromAccessRoles(input);
}

/**
 * MAY THIS VIEWER SEE A BOOKING'S ADMIN-OPERATIONAL LAYER — the officer
 * predicate the booking pages gate their private evidence on: a Full Admin or
 * a `bookings:edit` holder. The `hasAdminAccess` arm is belt-and-braces (the
 * `ADMIN` bundle already carries `bookings:edit`) and keeps the answer right
 * if a club edits that bundle. Read-only admin (`bookings:view`) is the
 * admission to the admin bookings AREA, not standing to read one booking's
 * private integrity evidence, so it is deliberately excluded.
 *
 * A function rather than a line inside the booking-detail viewer because a
 * SECOND page now needs the same answer (#3278, `INV-SSOT`): the member
 * bookings list gates its money verdicts on it, and "who counts as a booking
 * officer" must not get two spellings that can drift.
 */
export function canSeeBookingAdminTools(input: AdminPermissionInput) {
  return (
    hasAdminAccess(input) ||
    hasAdminAreaAccess(input, { area: "bookings", level: "edit" })
  );
}
