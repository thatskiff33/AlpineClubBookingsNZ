/**
 * Why a route is not an AI app action (ALP-653, `INV-MCP-006`).
 *
 * Every method of every route in `src/app/api` is either in the catalogue
 * (`catalogue.ts`) or answered here with a reason. `mcp-route-census.test.ts`
 * walks the route files and fails on one that is neither, so a new route
 * cannot become reachable, or stay unreachable, by accident.
 *
 * Two kinds of reason. A permanent one says the route is never an action. A
 * `not-yet:` one names the task that will add it; that task removes its rule
 * here in the same change that adds the catalogue entries.
 */
import { getAdminRouteRequirement, type AdminPermissionArea } from "@/lib/admin-permissions";
import { adminRouteApiPath, STEP_UP_ROUTES, stepUpRouteKey } from "@/lib/step-up-routes";

import { MCP_ACTIONS, mcpActionRouteFile, type McpAction } from "./catalogue";

export const MCP_PERMANENT_EXCLUSION_REASONS = {
  "fresh-proof":
    "Asks the officer to prove who they are again, which only the website can do.",
  "auth-flow":
    "Signing in, and approving, changing or ending an AI app connection, stay on the website.",
  provider: "Called by a payment or accounting provider, not by a person.",
  cron: "Run by the scheduler, not by a person.",
  kiosk: "Belongs to the lodge kiosk and display screens.",
  "needs-browser":
    "Needs the member's browser: card entry, a file, or a link sent to them by email.",
  infrastructure: "Health checks, deploy hooks and test-only helpers.",
} as const;

export type McpPermanentExclusionReason = keyof typeof MCP_PERMANENT_EXCLUSION_REASONS;

/** The task that will bring each remaining group of routes into the catalogue. */
export const MCP_NOT_YET_TASKS = {
  memberSelfService: "ALP-718",
  bookings: "ALP-719",
  membership: "ALP-720",
  finance: "ALP-721",
  lodge: "ALP-722",
  content: "ALP-723",
  support: "ALP-724",
  overview: "ALP-724",
} as const satisfies Record<AdminPermissionArea | "memberSelfService", string>;

export type McpExclusionReason = McpPermanentExclusionReason | `not-yet:${string}`;

/**
 * Path prefixes that are never actions. A prefix matches itself and anything
 * below it, on the App Router path with its bracketed segments.
 */
const PERMANENT_PREFIXES: ReadonlyArray<{
  readonly reason: Exclude<McpPermanentExclusionReason, "fresh-proof">;
  readonly prefixes: readonly string[];
}> = [
  {
    reason: "auth-flow",
    prefixes: [
      "/api/auth",
      "/api/mcp",
      "/api/member/mcp-grants",
      // An officer's connection must not be able to widen what connections may do.
      "/api/admin/mcp",
      "/api/profile/google",
    ],
  },
  { reason: "provider", prefixes: ["/api/webhooks", "/api/stripe"] },
  { reason: "cron", prefixes: ["/api/cron"] },
  { reason: "kiosk", prefixes: ["/api/lodge", "/api/display"] },
  {
    reason: "needs-browser",
    prefixes: [
      "/api/payments",
      "/api/pay",
      "/api/bookings/[id]/confirm-payment",
      "/api/bookings/[id]/confirm-modification-payment",
      "/api/bookings/[id]/additional-payment-secret",
      "/api/bookings/[id]/additional-payment-observations",
      "/api/images",
      "/api/members/[id]/photo",
      "/api/member/data-export",
      "/api/address-autocomplete",
      "/api/booking-requests/verify",
      "/api/booking-requests/respond",
      "/api/group-bookings/join/verify",
      "/api/members/family/partner-invite",
    ],
  },
  {
    reason: "infrastructure",
    prefixes: [
      "/api/health",
      "/api/deploy",
      "/api/testing",
      "/api/observability",
      "/api/[[...unmatched]]",
    ],
  },
];

/**
 * Member and public areas not yet in the catalogue. Listed by top-level area
 * so a route in a new area fails the census until someone decides about it.
 */
const MEMBER_NOT_YET_PREFIXES: readonly string[] = [
  "/api/age-tier-settings",
  "/api/applications",
  "/api/availability",
  "/api/booking-calendar",
  "/api/booking-messages",
  "/api/booking-policies",
  "/api/booking-requests",
  "/api/bookings",
  "/api/calendar",
  "/api/chores",
  "/api/club-posts",
  "/api/committee",
  "/api/contact",
  "/api/food-orders",
  "/api/group-bookings",
  "/api/help",
  "/api/inductions",
  "/api/issue-reports",
  "/api/lodge-instructions",
  "/api/lodge-maintenance",
  "/api/lodges",
  "/api/maintenance-reports",
  "/api/member",
  "/api/members",
  "/api/notices",
  "/api/notifications",
  "/api/privacy",
  "/api/profile",
  "/api/promo-codes",
  "/api/school-bookings",
  "/api/skifield-conditions",
  "/api/skifield-whakapapa",
  "/api/work-parties",
];

/** Finance officer routes that sit outside `/api/admin`. */
const FINANCE_NOT_YET_PREFIXES: readonly string[] = ["/api/finance"];

function underPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

const STEP_UP_ROUTE_KEYS: ReadonlySet<string> = new Set(
  STEP_UP_ROUTES.map((route) => stepUpRouteKey(route.file, route.method)),
);

/**
 * The reason this route method can never be an action, or null. Fresh-proof
 * routes come from `STEP_UP_ROUTES` itself, whatever the club's officer
 * sign-in setting says: the list is never copied here.
 */
export function mcpPermanentExclusion(
  file: string,
  method: string,
): McpPermanentExclusionReason | null {
  if (STEP_UP_ROUTE_KEYS.has(stepUpRouteKey(file, method))) return "fresh-proof";
  const path = adminRouteApiPath(file);
  for (const rule of PERMANENT_PREFIXES) {
    if (rule.prefixes.some((prefix) => underPrefix(path, prefix))) return rule.reason;
  }
  return null;
}

const ACTIONS_BY_ROUTE: ReadonlyMap<string, McpAction> = new Map(
  MCP_ACTIONS.map((action) => [stepUpRouteKey(mcpActionRouteFile(action), action.method), action]),
);

export type McpRouteClassification =
  | { readonly kind: "action"; readonly action: McpAction }
  | { readonly kind: "excluded"; readonly reason: McpExclusionReason }
  | { readonly kind: "unclassified" };

/** Where one route method stands. `unclassified` fails the census. */
export function classifyMcpRoute(file: string, method: string): McpRouteClassification {
  const permanent = mcpPermanentExclusion(file, method);
  if (permanent) return { kind: "excluded", reason: permanent };

  const action = ACTIONS_BY_ROUTE.get(stepUpRouteKey(file, method));
  if (action) return { kind: "action", action };

  const path = adminRouteApiPath(file);
  const adminArea = getAdminRouteRequirement(path, method)?.area;
  if (adminArea) {
    return { kind: "excluded", reason: `not-yet:${MCP_NOT_YET_TASKS[adminArea]}` };
  }
  if (FINANCE_NOT_YET_PREFIXES.some((prefix) => underPrefix(path, prefix))) {
    return { kind: "excluded", reason: `not-yet:${MCP_NOT_YET_TASKS.finance}` };
  }
  if (MEMBER_NOT_YET_PREFIXES.some((prefix) => underPrefix(path, prefix))) {
    return { kind: "excluded", reason: `not-yet:${MCP_NOT_YET_TASKS.memberSelfService}` };
  }
  return { kind: "unclassified" };
}
