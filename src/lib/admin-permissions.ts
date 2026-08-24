import type { FinanceAccessLevel, Role } from "@prisma/client";
import {
  authorizationRoleFromAccessRoles,
  isAccessRole,
  type AccessRoleDefinitionLevelFields,
  type AccessRoleInput,
  type AppAccessRole,
} from "@/lib/access-roles";

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

const ROUTE_AREA_PREFIXES: Array<{
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
      // Google sign-in setup lives on the Integrations hub (finance), like Xero
      // and Stripe (#2087). NOT feature-gated by googleLogin — setup + verify
      // must be reachable while the module is still off.
      "/admin/google",
      // Alpine Central Server (ServerNZ) integration lives on the Integrations
      // hub (finance), like Xero/Stripe/Google. NOT feature-gated so setup +
      // API-key entry stay reachable while the module is still off.
      "/admin/alpine-server",
      "/api/admin/alpine-server",
      "/admin/payments",
      "/admin/internet-banking",
      "/admin/refund-requests",
      "/admin/reports",
      "/admin/subscriptions",
      "/admin/fee-configuration",
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
      "/admin/bookings-setup",
      "/admin/bookings",
      "/admin/booking-requests",
      "/admin/book",
      "/admin/bed-allocation",
      "/admin/waitlist",
      "/admin/booking-approvals",
      "/admin/booking-change-requests",
      "/admin/booking-policies",
      "/admin/seasons",
      // Consolidated fee console (#1933, E7). Registered under bookings so the
      // route map resolves to a concrete area (drift guard) and bookings editors
      // reach it; admission is actually OR (bookings OR finance) — see
      // isConsolidatedFeesPath / canAccessConsolidatedFeesPage, honoured by the
      // admin layout and sidebar. Each section still gates its own edits by its
      // historical area (hut fees → bookings, joining/annual → finance).
      "/admin/fees",
      "/admin/age-tier-settings",
      "/admin/promo-codes",
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
      "/admin/family-groups",
      "/admin/family-suggestions",
      "/admin/deletion-requests",
      "/admin/committee",
      "/api/admin/members",
      "/api/admin/member-applications",
      "/api/admin/induction-templates",
      "/api/admin/membership-cancellation",
      "/api/admin/membership-cancellations",
      "/api/admin/membership-cancellation-requests",
      "/api/admin/membership-cancellation-settings",
      "/api/admin/membership-lockout-settings",
      "/api/admin/membership-types",
      "/api/admin/member-fields",
      "/api/admin/induction",
      "/api/admin/inductions",
      "/api/admin/communications",
      "/api/admin/notices",
      "/api/admin/lockers",
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
      "/admin/hut-leaders",
      "/admin/roster",
      "/admin/chores",
      "/admin/lodge",
      "/admin/lodges",
      "/admin/work-parties",
      "/admin/lodge-instructions",
      "/admin/rooms-beds",
      // Club events calendar (Lodge Operations). The page is lodge-area gated
      // for admin visibility; write access is broadened to committee members in
      // the calendar routes themselves (src/lib/calendar-access.ts), which do
      // not run through this admin matrix.
      "/admin/calendar",
      "/api/admin/hut-leaders",
      "/api/admin/roster",
      "/api/admin/chores",
      "/api/admin/lodge",
      "/api/admin/lodges",
      // Registry of other clubs' lodges (#2749): admin-curated on the Lodges
      // page, gated by the same lodge area. Distinct prefix from
      // "/api/admin/lodges" so it does not fall through to the overview catch-all.
      "/api/admin/other-lodges",
      "/api/admin/work-parties",
      "/api/admin/lodge-instructions",
      "/api/admin/lodge-settings",
      // Lobby display management (#27/#33, epic #25): lodge operations.
      "/admin/display",
      "/api/admin/display",
      // Maintenance reports (#2780). "The maintenance officer" is not a role in
      // this product and must not become one: it is whoever the club has given
      // Lodge Operations to. So the queue, the question set, the settings and
      // the per-lodge QR tokens all sit in the `lodge` area, and the alert
      // audience is `{ area: "lodge", level: "edit" }` — see
      // ADMIN_NOTIFICATION_PREFERENCE_REQUIREMENT.
      "/admin/maintenance-reports",
      "/api/admin/maintenance-reports",
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
      "/admin/access-roles",
      "/admin/config-transfer",
      "/admin/setup",
      "/admin/modules",
      // Club Time — the one persisted IANA club timezone (CT-1 #2989, epic
      // #2988). Registered under support alongside /admin/modules and
      // /admin/config-transfer so an unregistered path never falls back to the
      // overview catch-all and the sidebar's matrix check resolves. The AREA
      // only decides who can reach the surface: reading AND changing the club
      // timezone remain Full Admin regardless of area level (enforced in the
      // routes), exactly like the backups credential + destination writes below.
      "/admin/club-time",
      "/api/admin/club-time-zone",
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
      "/admin/environment",
      "/api/admin/environment-safety",
      // Login & Security page (epic #2030, child #2033): password policy today;
      // magic-link / Google sign-in cards land here in #2034/#2035. Pinned to
      // `support` alongside /admin/modules and the other system-config surfaces.
      "/admin/security",
      "/admin/subscription-lockout",
      "/admin/notifications",
      "/admin/notification-rules",
      "/admin/notification-recipients",
      "/admin/booking-messages",
      "/admin/email-messages",
      "/admin/email-deliverability",
      "/admin/health",
      "/admin/background-jobs",
      // Managed database backup: status, config, and run-now (#2095, C6).
      // Registered under support so an unregistered path never falls back to
      // the overview catch-all (layout.tsx). Support view = status; support
      // edit = config/run-now; credential + destination WRITES remain Full
      // Admin regardless of area level (enforced in the routes).
      "/admin/backups",
      "/admin/stuck-states",
      "/admin/issue-reports",
      "/admin/audit-log",
      "/api/admin/access-roles",
      "/api/admin/config-transfer",
      "/api/admin/setup",
      "/api/admin/modules",
      // Login & Security config API (epic #2030, child #2033): support-area
      // system configuration, same as /api/admin/modules.
      "/api/admin/security",
      "/api/admin/notifications",
      "/api/admin/notification-delivery-policies",
      "/api/admin/booking-messages",
      "/api/admin/email",
      "/api/admin/email-failures",
      "/api/admin/email-templates",
      "/api/admin/email-settings",
      "/api/admin/email-suppressions",
      "/api/admin/health",
      "/api/admin/backups",
      "/api/admin/runtime-status",
      "/api/admin/stuck-states",
      "/api/admin/issue-reports",
      "/api/admin/audit-log",
      // AI help assistant usage + spend-cap settings (#2211, C3). Registered
      // under support alongside /api/admin/modules — support view = usage panel,
      // support edit = budget-cap change. The Anthropic key WRITE stays Full
      // Admin on the credentials route regardless of area level. (The admin UI
      // page /admin/ai-assistant, if added by C4, resolves here too.)
      "/admin/ai-assistant",
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
      // stays here. The page falls to the overview catch-all and is recorded in
      // OVERVIEW_ALLOWLIST with that reasoning.
      "/api/admin/ai-diagnostics",
    ],
  },
  {
    area: "overview",
    prefixes: ["/admin", "/api/admin"],
  },
];

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
 * AccessRoleInput extended with the matrix a JWT session carries (#1367).
 * `session.user.accessRoles` is enum-only (definition-backed custom roles
 * have `role: null` and vanish from it), so the auth `jwt` callback embeds
 * the merged matrix computed from the DB-joined member instead, and every
 * session.user-based check reads it here.
 */
export type AdminPermissionInput = AccessRoleInput & {
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

export function hasAdminPortalAccess(input: AdminPermissionInput) {
  const matrix = getAdminPermissionMatrix(input);
  return ADMIN_PERMISSION_AREAS.some(
    (area) => matrix[area.key] !== "none" && area.key !== "finance",
  );
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

export function getFirstAccessibleAdminHref(input: AdminPermissionInput) {
  const matrix = getAdminPermissionMatrix(input);
  if (matrix.overview !== "none") return "/admin/dashboard";
  if (matrix.bookings !== "none") return "/admin/bookings";
  if (matrix.membership !== "none") return "/admin/members";
  if (matrix.finance !== "none") return "/admin/payments";
  if (matrix.lodge !== "none") return "/admin/hut-leaders";
  if (matrix.content !== "none") return "/admin/page-content";
  if (matrix.support !== "none") return "/admin/health";
  return null;
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

export function canViewAdminHref(input: AdminPermissionInput, href: string) {
  const requirement = getAdminRouteRequirement(href, "GET");
  return requirement ? hasAdminAreaAccess(input, requirement) : false;
}

/**
 * Matrix-based variant for client components (e.g. the admin sidebar), which
 * receive the precomputed matrix from a server layout instead of raw roles —
 * definitions live in the database and cannot be resolved client-side.
 */
export function canViewAdminHrefWithMatrix(
  matrix: AdminPermissionMatrix,
  href: string,
) {
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
 */
export const CONSOLIDATED_FEES_PATH = "/admin/fees";

export function isConsolidatedFeesPath(pathname: string): boolean {
  const normalized = normalizePathname(pathname);
  return (
    normalized === CONSOLIDATED_FEES_PATH ||
    normalized.startsWith(`${CONSOLIDATED_FEES_PATH}/`)
  );
}

export function canAccessConsolidatedFeesPage(
  matrix: AdminPermissionMatrix,
): boolean {
  return matrix.bookings !== "none" || matrix.finance !== "none";
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
