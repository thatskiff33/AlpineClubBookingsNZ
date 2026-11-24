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
  "moves-money":
    "Takes, moves or refunds money, or changes what a booking costs, which the member confirms on the website.",
  declaration:
    "Records the member's own declaration, consent or acknowledgement, which they make themselves on the website.",
  "public-visitor": "A form for visitors who are not signed in; a member's AI app has no use for it.",
  "website-flow": "Serves the website's own screens and steps, not something a member asks for.",
  "access-secrets":
    "Shows or changes lodge door codes, sign or meeting links that let someone in, or other access details, which stay on the website.",
  "site-helper": "The website's own help assistant; the member's AI app answers them itself.",
  "privacy-posture":
    "Decides who may browse members' names, which an officer chooses on the website, never an AI app.",
  "unread-value":
    "Changes a value an AI app is never shown, such as a guest's allergy needs, so the app would be writing blind.",
} as const;

export type McpPermanentExclusionReason = keyof typeof MCP_PERMANENT_EXCLUSION_REASONS;

/**
 * Officer areas whose every route method has been decided: each is a
 * catalogue action or has a permanent reason. A route added to one of these
 * areas is unclassified until someone decides about it.
 *
 * - `bookings` (Bookings & Beds): ALP-719.
 * - `lodge` (Lodge Operations): ALP-722.
 */
const MCP_DECIDED_ADMIN_AREAS = ["bookings", "lodge"] as const satisfies readonly AdminPermissionArea[];

type McpDecidedAdminArea = (typeof MCP_DECIDED_ADMIN_AREAS)[number];

type McpNotYetAdminArea = Exclude<AdminPermissionArea, McpDecidedAdminArea>;

/**
 * The task that will bring each remaining group of routes into the catalogue.
 * The member keys are the follow-ons ALP-718 split its member routes into,
 * less those that have shipped (ALP-794, bookings; ALP-795, family and
 * membership; ALP-796, lodge life); the rest are the officer areas not yet
 * decided (ALP-719 decided Bookings & Beds, ALP-722 Lodge Operations).
 */
export const MCP_NOT_YET_TASKS = {
  memberGroupsAndWholeLodge: "ALP-797",
  membership: "ALP-720",
  finance: "ALP-721",
  content: "ALP-723",
  support: "ALP-724",
  overview: "ALP-724",
} as const satisfies Record<McpNotYetAdminArea | MemberNotYetGroup, string>;

function isNotYetAdminArea(area: AdminPermissionArea): area is McpNotYetAdminArea {
  return !(MCP_DECIDED_ADMIN_AREAS as readonly AdminPermissionArea[]).includes(area);
}

type MemberNotYetGroup = "memberGroupsAndWholeLodge";

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
  {
    reason: "kiosk",
    // The display screens' officer setup (layouts, templates, devices and
    // their pairing codes, preview links) belongs with the screens (ALP-722).
    prefixes: ["/api/lodge", "/api/display", "/api/admin/display"],
  },
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
  readonly reason: Exclude<McpPermanentExclusionReason, "fresh-proof">;
  readonly routes: readonly string[];
}> = [
  // Booking edits that can take, move or refund money (ALP-794): the AI app
  // quotes them (`quote_booking_change`) and sends the member to the website.
  {
    reason: "moves-money",
    routes: [
      "PUT /api/bookings/[id]/modify",
      "PUT /api/bookings/[id]/modify-dates",
      "POST /api/bookings/[id]/guests",
      "DELETE /api/bookings/[id]/guests/[guestId]",
      "POST /api/bookings/[id]/confirm-draft",
      "POST /api/bookings/[id]/send-guest-payment-link",
    ],
  },
  {
    reason: "declaration",
    routes: [
      "POST /api/notices/[id]/acknowledge",
      "POST /api/member/onboarding/confirm",
      "POST /api/member/request-deletion",
      // A member guest agreeing to be on someone else's booking (INV-GUEST).
      "POST /api/bookings/[id]/guests/[guestId]/consent",
      // Signing off another member's induction is the signer's own declaration.
      "POST /api/inductions/[id]/sign-off",
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
      // The booking wizard's guest promo chips: which of the guests' own codes
      // the booker may use (#3492). An app checks codes with `check_promo_code`.
      "POST /api/promo-codes/guest-codes",
      // The school contact editor (#5245), whose save is fresh-proof: its read
      // loads the version that save checks, and its retry re-sends a failed
      // save to Xero. No action names a school record, and re-running failed
      // Xero work is left to the Finance actions (ALP-721).
      "GET /api/admin/organisations/[id]/contact",
      "POST /api/admin/organisations/[id]/contact/retry",
    ],
  },
  // ALP-722: the kiosk's sign-in account and a hut leader's kiosk PIN.
  { reason: "kiosk", routes: ["PUT /api/admin/lodge", "POST /api/admin/hut-leaders/[id]/pin"] },
  // Door codes and emergency access: never sent to an AI provider, nor
  // written by one. Nor the links that let someone in: a maintenance QR
  // sign's link, answered only when minted, and a meeting's host link.
  {
    reason: "access-secrets",
    routes: [
      "GET /api/lodge-instructions",
      "GET /api/admin/lodge-instructions",
      "PUT /api/admin/lodge-instructions",
      "POST /api/admin/maintenance-reports/tokens",
      "POST /api/calendar/events/[id]/join",
    ],
  },
  { reason: "site-helper", routes: ["POST /api/help/chat"] },
  // Open member search widens the club's privacy (owner decision D-18): text
  // an app read must never be able to talk it into that.
  { reason: "privacy-posture", routes: ["PUT /api/admin/member-guest-settings"] },
  // Dietary and allergy needs are never sent to an app (INV-PRIV-022), so an
  // app could only overwrite or clear what the kitchen relies on unseen.
  // A connection reads only the member's own food orders (ALP-796), so an
  // officer's app could price or tick off another member's order unseen.
  {
    reason: "unread-value",
    routes: [
      "PATCH /api/admin/bookings/[id]/guest-dietary",
      "PATCH /api/food-orders/[id]/price",
      "POST /api/food-orders/[id]/received",
    ],
  },
  { reason: "public-visitor", routes: ["POST /api/contact", "POST /api/applications"] },
  {
    reason: "needs-browser",
    routes: [
      // The nominee confirms through a link emailed to them, as does each member
      // named in a membership cancellation request.
      "POST /api/applications/nominate",
      "POST /api/member/membership-cancellation-requests/confirm",
      // The chore roster is opened from the link in the roster email, and
      // its officer copy is a page made to be printed.
      "GET /api/chores/[token]",
      "PUT /api/chores/[token]",
      "GET /api/chores/roster/[date]/print",
      // Message board pictures are files uploaded and shown in the browser.
      "POST /api/club-posts/images",
      "GET /api/club-posts/images/[publicId]",
      // A problem report carries the page it was sent from and a screenshot.
      "POST /api/issue-reports",
      // The maintenance form opened from the lodge's QR code.
      "GET /api/lodge-maintenance/[token]",
      "POST /api/lodge-maintenance/[token]",
      // Files: the invoice and credit note PDFs, and the booking's calendar entry.
      "GET /api/bookings/[id]/invoice",
      "GET /api/bookings/[id]/invoice/credit-notes/[creditNoteId]",
      "GET /api/booking-calendar/[id]",
    ],
  },
];

/**
 * Member and public areas not yet in the catalogue, by the follow-on task
 * that decides them. A route in an area listed nowhere fails the census until
 * someone decides about it.
 */
const MEMBER_NOT_YET_PREFIXES: Readonly<Record<MemberNotYetGroup, readonly string[]>> = {
  memberGroupsAndWholeLodge: [
    "/api/booking-requests",
    "/api/group-bookings",
    "/api/school-bookings",
  ],
};

/** Finance officer routes that sit outside `/api/admin`. */
const FINANCE_NOT_YET_PREFIXES: readonly string[] = ["/api/finance"];

/**
 * Money routes whose path the `bookings` area guards but which belong to the
 * Finance lane (ALP-721), as `METHOD /path`. Withdrawing an extra payment
 * request cancels a card request and retires its ledger row, and its handler
 * demands finance edit (owner decision, #5305 comment 7093303964, item 3).
 * Checked before the path's area, which is decided and has no `not-yet`.
 */
export const MCP_FINANCE_NOT_YET_ROUTES: readonly string[] = [
  "POST /api/admin/bookings/[id]/additional-payment/withdraw",
];

/**
 * Every exact `METHOD /api/path` an exclusion names, permanent or Finance
 * not-yet. The census checks each against a real route file and method, so an
 * entry left behind by a moved or deleted route fails instead of lingering.
 */
export const MCP_EXACT_EXCLUDED_ROUTES: readonly string[] = [
  ...PERMANENT_ROUTES.flatMap((rule) => rule.routes),
  ...MCP_FINANCE_NOT_YET_ROUTES,
];

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

/** Where one route method stands. `unclassified` fails the census. */
export function classifyMcpRoute(file: string, method: string): McpRouteClassification {
  const permanent = mcpPermanentExclusion(file, method);
  if (permanent) return { kind: "excluded", reason: permanent };

  const action = ACTIONS_BY_ROUTE.get(stepUpRouteKey(file, method));
  if (action) return { kind: "action", action };

  const path = adminRouteApiPath(file);
  if (MCP_FINANCE_NOT_YET_ROUTES.includes(`${method} ${path}`)) {
    return { kind: "excluded", reason: `not-yet:${MCP_NOT_YET_TASKS.finance}` };
  }
  const adminArea = getAdminRouteRequirement(path, method)?.area;
  if (adminArea) {
    // A route in a decided area has no `not-yet` to fall back on.
    return isNotYetAdminArea(adminArea)
      ? { kind: "excluded", reason: `not-yet:${MCP_NOT_YET_TASKS[adminArea]}` }
      : { kind: "unclassified" };
  }
  if (FINANCE_NOT_YET_PREFIXES.some((prefix) => underPrefix(path, prefix))) {
    return { kind: "excluded", reason: `not-yet:${MCP_NOT_YET_TASKS.finance}` };
  }
  for (const [group, prefixes] of Object.entries(MEMBER_NOT_YET_PREFIXES) as Array<
    [MemberNotYetGroup, readonly string[]]
  >) {
    if (prefixes.some((prefix) => underPrefix(path, prefix))) {
      return { kind: "excluded", reason: `not-yet:${MCP_NOT_YET_TASKS[group]}` };
    }
  }
  return { kind: "unclassified" };
}
