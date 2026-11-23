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
 *
 * A member route that is never an action is listed by its exact method and
 * path (`PERMANENT_ROUTES`), so the reason cannot spread to a neighbour.
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
  // Declared here, first applied by ALP-794 to the booking edits that change
  // what a booking costs.
  "moves-money":
    "Takes, moves or refunds money, or changes what a booking costs, which the member confirms on the website.",
  declaration:
    "Records the member's own declaration, consent or acknowledgement, which they make themselves on the website.",
  "public-visitor": "A form for visitors who are not signed in; a member's AI app has no use for it.",
  "website-flow": "Serves the website's own screens and steps, not something a member asks for.",
  "access-secrets": "Shows lodge door codes or other access details, which stay on the website.",
  "site-helper": "The website's own help assistant; the member's AI app answers them itself.",
  // Officer reasons (ALP-721 onwards).
  "club-setup":
    "Sets up how the club runs: fees, tax, bank details, accounting mappings, membership types and rules, member fields, or connections to outside services, which an officer configures and checks on the website.",
  "changes-charges":
    "Changes what a member owes or is invoiced, or previews such a change for an officer to confirm, which an officer reviews and confirms on the website.",
  "ends-membership":
    "Decides a request to archive, delete or cancel someone's membership, which cannot be undone from an app and is decided on the website.",
  "sign-in-access":
    "Sends someone a sign-in link or changes who signs in with an email address, which stays on the website.",
  "mass-message": "Emails many members at once, which an officer composes, checks and sends on the website.",
  "privacy-request":
    "Part of answering a person's request for their own data, which a Full Admin does on the website after proving who they are again.",
  "switched-off": "Does nothing but answer that it is switched off.",
} as const;

export type McpPermanentExclusionReason = keyof typeof MCP_PERMANENT_EXCLUSION_REASONS;

/**
 * The task that will bring each remaining group of routes into the catalogue.
 * The member keys are the follow-ons ALP-718 split its member routes into,
 * less those that have shipped (ALP-795, family and membership); the rest are
 * the officer areas. An area whose task has finished has no key: each of its
 * routes is an action or has a permanent reason, and a new one fails the
 * census until someone decides about it.
 */
export const MCP_NOT_YET_TASKS = {
  memberBookings: "ALP-794",
  memberLodgeLife: "ALP-796",
  memberGroupsAndWholeLodge: "ALP-797",
  bookings: "ALP-719",
  finance: "ALP-721",
  lodge: "ALP-722",
  content: "ALP-723",
  support: "ALP-724",
  overview: "ALP-724",
} as const satisfies Partial<Record<AdminPermissionArea | MemberNotYetGroup, string>>;

const NOT_YET_TASK_BY_GROUP: Partial<Record<AdminPermissionArea | MemberNotYetGroup, string>> =
  MCP_NOT_YET_TASKS;

type MemberNotYetGroup =
  | "memberBookings"
  | "memberLodgeLife"
  | "memberGroupsAndWholeLodge";

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
 * Single route methods that are never actions, by method and App Router path.
 * Exact, not prefixes: a new method or route beside one of these is not
 * covered by its neighbour's reason and fails the census until decided.
 */
const PERMANENT_ROUTES: ReadonlyArray<{
  readonly reason: McpPermanentExclusionReason;
  readonly routes: readonly string[];
}> = [
  {
    reason: "declaration",
    routes: [
      "POST /api/notices/[id]/acknowledge",
      "POST /api/member/onboarding/confirm",
      "POST /api/member/request-deletion",
      // ALP-795: joining a family group, confirming a partnership and asking
      // for memberships to be cancelled are the member's own decisions.
      "PUT /api/members/family/invitations",
      "PUT /api/members/partner-link",
      "POST /api/member/membership-cancellation-requests",
    ],
  },
  {
    reason: "website-flow",
    routes: [
      "GET /api/profile/post-login-landing",
      "PUT /api/profile/post-login-landing",
      "GET /api/member/onboarding",
      "GET /api/skifield-conditions",
      "GET /api/privacy/replay",
    ],
  },
  // Door codes and emergency access: never sent to an AI provider.
  { reason: "access-secrets", routes: ["GET /api/lodge-instructions"] },
  { reason: "site-helper", routes: ["POST /api/help/chat"] },
  { reason: "public-visitor", routes: ["POST /api/contact", "POST /api/applications"] },
  // The nominee confirms through a link emailed to them, as does each member
  // named in a membership cancellation request.
  {
    reason: "needs-browser",
    routes: [
      "POST /api/applications/nominate",
      "POST /api/member/membership-cancellation-requests/confirm",
    ],
  },

  // --- Membership (ALP-720) ------------------------------------------------
  // Settings screens and the club's membership structure: types, their
  // subscription categories, member fields and induction checklists.
  {
    reason: "club-setup",
    routes: [
      "GET /api/admin/club-posts/settings",
      "PUT /api/admin/club-posts/settings",
      "GET /api/admin/member-fields",
      "PUT /api/admin/member-fields",
      "GET /api/admin/membership-cancellation-settings",
      "PUT /api/admin/membership-cancellation-settings",
      "GET /api/admin/membership-lockout-settings",
      "PUT /api/admin/membership-lockout-settings",
      "GET /api/admin/membership-nomination-settings",
      "PUT /api/admin/membership-nomination-settings",
      "POST /api/admin/membership-types",
      "PATCH /api/admin/membership-types/[id]",
      "DELETE /api/admin/membership-types/[id]",
      "POST /api/admin/membership-types/[id]/merge",
      "POST /api/admin/membership-types/reorder",
      "GET /api/admin/subscription-categories",
      "POST /api/admin/subscription-categories",
      "PATCH /api/admin/subscription-categories/[id]",
      "DELETE /api/admin/subscription-categories/[id]",
      "POST /api/admin/induction-templates",
      "PUT /api/admin/induction-templates/[id]",
      "PATCH /api/admin/induction-templates/[id]",
      "DELETE /api/admin/induction-templates/[id]",
    ],
  },
  // A member's seasonal membership type sets their subscription and age tier,
  // and so what they owe; approving an application can raise an entrance-fee
  // invoice. Each preview mints the token its save needs, so both stay together.
  {
    reason: "changes-charges",
    routes: [
      "POST /api/admin/members/[id]/seasonal-membership/preview",
      "PATCH /api/admin/members/[id]/seasonal-membership",
      "POST /api/admin/members/bulk-membership-type/preview",
      "POST /api/admin/members/bulk-membership-type",
      "POST /api/admin/membership-types/roll-forward",
      "POST /api/admin/members/[id]/joining-fee/preview",
      "POST /api/admin/member-applications/[id]/approval-preview",
      "PUT /api/admin/member-applications/[id]",
    ],
  },
  // Approving archives or deletes the member, or ends their membership and
  // its future bookings. Raising the request is an action: a second officer
  // decides it here, on the website.
  {
    reason: "ends-membership",
    routes: [
      "PATCH /api/admin/member-lifecycle-action-requests/[requestId]",
      "POST /api/admin/membership-cancellation-requests/[requestId]/participants/[participantId]",
    ],
  },
  {
    reason: "sign-in-access",
    routes: [
      "POST /api/admin/members/send-password-reset",
      "POST /api/admin/members/send-setup-invite",
      "POST /api/admin/family-groups/[id]/login-holder",
    ],
  },
  // The recipient count is the compose screen's own preview of the send.
  {
    reason: "mass-message",
    routes: ["GET /api/admin/communications/send", "POST /api/admin/communications/send"],
  },
  // Finds a guest's id for the subject access report, which is fresh-proof.
  { reason: "privacy-request", routes: ["GET /api/admin/members/subject-access/guests"] },
  // The merge's preview, whose merge is fresh-proof; the link dialogs'
  // "whose mailbox would this reach" helper; and the member page's drawn
  // family tree, whose links `get_member` already answers.
  {
    reason: "website-flow",
    routes: [
      "POST /api/admin/members/[id]/merge/preview",
      "GET /api/admin/members/[id]/dependent-email-source",
      "GET /api/admin/members/[id]/family-tree",
    ],
  },
  // Direct deletion answers 405: deletion is a lifecycle request.
  { reason: "switched-off", routes: ["DELETE /api/admin/members/[id]"] },
];

/**
 * Member and public areas not yet in the catalogue, by the follow-on task
 * that decides them. A route in an area listed nowhere fails the census until
 * someone decides about it.
 */
const MEMBER_NOT_YET_PREFIXES: Readonly<Record<MemberNotYetGroup, readonly string[]>> = {
  memberBookings: [
    "/api/availability/check",
    "/api/booking-calendar",
    "/api/booking-policies",
    "/api/bookings",
    "/api/promo-codes",
  ],
  memberLodgeLife: [
    "/api/calendar",
    "/api/chores",
    "/api/club-posts",
    "/api/food-orders",
    "/api/inductions",
    "/api/issue-reports",
    "/api/lodge-maintenance",
    "/api/maintenance-reports",
    "/api/work-parties",
  ],
  memberGroupsAndWholeLodge: [
    "/api/booking-requests",
    "/api/group-bookings",
    "/api/school-bookings",
  ],
};

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
  const route = `${method} ${path}`;
  for (const rule of PERMANENT_ROUTES) {
    if (rule.routes.includes(route)) return rule.reason;
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

/** A finished area has no task left, so its undecided route is unclassified. */
function notYet(task: string | undefined): McpRouteClassification {
  return task ? { kind: "excluded", reason: `not-yet:${task}` } : { kind: "unclassified" };
}

/** Where one route method stands. `unclassified` fails the census. */
export function classifyMcpRoute(file: string, method: string): McpRouteClassification {
  const permanent = mcpPermanentExclusion(file, method);
  if (permanent) return { kind: "excluded", reason: permanent };

  const action = ACTIONS_BY_ROUTE.get(stepUpRouteKey(file, method));
  if (action) return { kind: "action", action };

  const path = adminRouteApiPath(file);
  const adminArea = getAdminRouteRequirement(path, method)?.area;
  if (adminArea) return notYet(NOT_YET_TASK_BY_GROUP[adminArea]);
  if (FINANCE_NOT_YET_PREFIXES.some((prefix) => underPrefix(path, prefix))) {
    return { kind: "excluded", reason: `not-yet:${MCP_NOT_YET_TASKS.finance}` };
  }
  for (const [group, prefixes] of Object.entries(MEMBER_NOT_YET_PREFIXES) as Array<
    [MemberNotYetGroup, readonly string[]]
  >) {
    if (prefixes.some((prefix) => underPrefix(path, prefix))) {
      return notYet(NOT_YET_TASK_BY_GROUP[group]);
    }
  }
  return { kind: "unclassified" };
}
