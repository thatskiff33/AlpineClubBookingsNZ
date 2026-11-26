/**
 * Why a route is not an AI app action (ALP-653, `INV-MCP-006`).
 *
 * Every method of every route in `src/app/api` is either in the catalogue
 * (`catalogue.ts`) or answered here with a reason. `mcp-route-census.test.ts`
 * walks the route files and fails on one that is neither, so a new route
 * cannot become reachable, or stay unreachable, by accident.
 *
 * Two kinds of reason. A permanent one says the route is never an action. A
 * `not-yet:` one names the officer stage that will decide it; that task
 * removes its rule here in the same change that adds the catalogue entries.
 * Every member route is decided (ALP-797): an action or a permanent reason.
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
  // Officer reasons (ALP-720 onwards).
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
  // Finance (ALP-721). Finance setup is a recorded exception to the rule that
  // an officer area's configuration is an action (owner decision, #5305
  // comment 7131138226, item 4).
  "club-setup":
    "Sets up the club's money and its links to other services: the bank account members pay into, fees, tax settings, finance-report, accounting and item-code mappings, Xero contact grouping, integration credentials, the Xero and Stripe connections, the Xero member import and webhook health check, and the analytics, MiroTalk, Google and Alpine Central Server integration settings, which an officer changes on the website.",
  "service-export": "An export another system collects with its own shared key, not something a person asks for.",
} as const;

export type McpPermanentExclusionReason = keyof typeof MCP_PERMANENT_EXCLUSION_REASONS;

/**
 * Officer areas whose every route method has been decided: each is a
 * catalogue action or has a permanent reason. A route added to one of these
 * areas is unclassified until someone decides about it.
 *
 * - `bookings` (Bookings & Beds): ALP-719.
 * - `membership` (Membership): ALP-720.
 * - `finance` (Finance): ALP-721, including the `/api/finance` workspace.
 * - `lodge` (Lodge Operations): ALP-722.
 * - `content` (Content): ALP-723.
 */
const MCP_DECIDED_ADMIN_AREAS = ["bookings", "membership", "finance", "lodge", "content"] as const satisfies readonly AdminPermissionArea[];

type McpDecidedAdminArea = (typeof MCP_DECIDED_ADMIN_AREAS)[number];

type McpNotYetAdminArea = Exclude<AdminPermissionArea, McpDecidedAdminArea>;

/**
 * The task that will bring each remaining group of officer routes into the
 * catalogue, by admin area not yet decided. Every member route is decided:
 * ALP-718 split them into five follow-ons, the last of which (ALP-797, groups
 * and whole-lodge) removed the member rule, so a new member route fails the
 * census until someone decides about it.
 */
export const MCP_NOT_YET_TASKS = {
  support: "ALP-724",
  overview: "ALP-724",
} as const satisfies Record<McpNotYetAdminArea, string>;

function isNotYetAdminArea(area: AdminPermissionArea): area is McpNotYetAdminArea {
  return !(MCP_DECIDED_ADMIN_AREAS as readonly AdminPermissionArea[]).includes(area);
}

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
      // ALP-797: joining a group creates the joiner's own booking and takes
      // its payment, and settling an organiser-pays group holds its beds and
      // opens one combined bill.
      "POST /api/group-bookings/[code]/join",
      "POST /api/group-bookings/[code]/settle",
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
  // Door codes and emergency access: never sent to an AI provider.
  { reason: "access-secrets", routes: ["GET /api/lodge-instructions"] },
  { reason: "site-helper", routes: ["POST /api/help/chat"] },
  // Open member search widens the club's privacy (owner decision D-18): text
  // an app read must never be able to talk it into that.
  // A lodge roster's name detail decides how much members see of each other's
  // names, which is the same choice (ALP-722).
  {
    reason: "privacy-posture",
    routes: ["PUT /api/admin/member-guest-settings", "PUT /api/admin/lodges/[id]/roster-settings"],
  },
  // Dietary and allergy needs are never sent to an app (INV-PRIV-022), so an
  // app could only overwrite or clear what the kitchen relies on unseen.
  { reason: "unread-value", routes: ["PATCH /api/admin/bookings/[id]/guest-dietary"] },
  {
    reason: "public-visitor",
    routes: [
      "POST /api/contact",
      "POST /api/applications",
      // ALP-797: the non-member and school booking request forms, their price
      // quote and settings, and a non-member's request to join a group. A
      // member asks for the whole lodge with `request_whole_lodge` instead.
      "POST /api/booking-requests",
      "POST /api/booking-requests/quote",
      "GET /api/booking-requests/settings",
      "POST /api/booking-requests/school",
      "POST /api/group-bookings/[code]/join-request",
    ],
  },
  {
    reason: "needs-browser",
    routes: [
      // The nominee confirms through a link emailed to them, as does each member
      // named in a membership cancellation request.
      "POST /api/applications/nominate",
      "POST /api/member/membership-cancellation-requests/confirm",
      // The chore roster is opened from the link in the roster email.
      "GET /api/chores/[token]",
      "PUT /api/chores/[token]",
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
      // A school confirms its attendees through the link emailed to it.
      "POST /api/school-bookings/confirm-attendees",
    ],
  },

  // --- Membership (ALP-720) ------------------------------------------------
  // A member's seasonal membership type sets their subscription and age tier,
  // and their subscription category how they are billed, and so what they
  // owe; approving an application can raise an entrance-fee invoice. Each
  // preview mints the token its save needs, so both stay together.
  {
    reason: "changes-charges",
    routes: [
      // Restores reserved credit after a live Xero check; reviewed on the website.
      "POST /api/admin/members/[id]/credits/corrections/[correctionId]",
      "POST /api/admin/members/[id]/seasonal-membership/preview",
      "PATCH /api/admin/members/[id]/seasonal-membership",
      "POST /api/admin/members/bulk-membership-type/preview",
      "POST /api/admin/members/bulk-membership-type",
      "POST /api/admin/members/bulk-subscription-category/preview",
      "POST /api/admin/members/bulk-subscription-category",
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

  // --- Lodge Operations (ALP-722) ------------------------------------------
  // The kiosk's sign-in account, a hut leader's kiosk PIN, and the display
  // screens' officer setup (layouts, templates, devices and their pairing
  // codes, preview links), which belongs with the screens.
  {
    reason: "kiosk",
    routes: [
      "PUT /api/admin/lodge",
      "POST /api/admin/hut-leaders/[id]/pin",
      "POST /api/admin/display/built-ins/restore",
      "GET /api/admin/display/devices",
      "POST /api/admin/display/devices",
      "PATCH /api/admin/display/devices/[id]",
      "POST /api/admin/display/devices/[id]/pairing",
      "POST /api/admin/display/devices/[id]/revoke",
      "GET /api/admin/display/layouts",
      "POST /api/admin/display/layouts",
      "DELETE /api/admin/display/layouts/[id]",
      "GET /api/admin/display/layouts/[id]",
      "PUT /api/admin/display/layouts/[id]",
      "GET /api/admin/display/lodge-config",
      "PUT /api/admin/display/lodge-config",
      "GET /api/admin/display/preview",
      "POST /api/admin/display/preview-grant",
      "GET /api/admin/display/reference/conditions",
      "GET /api/admin/display/templates",
      "POST /api/admin/display/templates",
      "DELETE /api/admin/display/templates/[id]",
      "GET /api/admin/display/templates/[id]",
      "PUT /api/admin/display/templates/[id]",
    ],
  },
  // Door codes and emergency access, never written by an app either; and the
  // links that let someone in: a maintenance QR sign's link, answered only
  // when minted, and a meeting's host link.
  {
    reason: "access-secrets",
    routes: [
      "GET /api/admin/lodge-instructions",
      "PUT /api/admin/lodge-instructions",
      "POST /api/admin/maintenance-reports/tokens",
      "POST /api/calendar/events/[id]/join",
    ],
  },
  // The officer copy of the chore roster is a page made to be printed.
  { reason: "needs-browser", routes: ["GET /api/chores/roster/[date]/print"] },
  // A connection reads only the member's own food orders (ALP-796), so an
  // officer's app could price or tick off another member's order unseen; and
  // the food officer's address the settings save writes is never sent to one.
  {
    reason: "unread-value",
    routes: [
      "PATCH /api/food-orders/[id]/price",
      "POST /api/food-orders/[id]/received",
      "PUT /api/admin/food-orders/settings",
    ],
  },

  // --- Content (ALP-723) ---------------------------------------------------
  // File uploads from the officer's browser: photos into a gallery folder, an
  // image into the page image library, and the site logo.
  {
    reason: "needs-browser",
    routes: [
      "POST /api/admin/image-manager/upload",
      "POST /api/admin/image-library",
      "POST /api/admin/site-style/logo",
    ],
  },

  // --- Finance (ALP-721) ---------------------------------------------------
  // Money that goes through Stripe (owner decision, #5305 comment
  // 7131138226, item 1): marking a booking paid cancels the member's open card
  // checkouts and posts a receipt, and withdrawing an extra payment request
  // cancels a card request and retires its ledger row. Marking a member's
  // subscription paid by hand, or reversing it, emails a receipt and moves
  // their booking prices, so it stays with booking mark-paid (owner decision,
  // #5305 comment 7200981104).
  {
    reason: "moves-money",
    routes: [
      "POST /api/admin/bookings/[id]/mark-paid",
      "POST /api/admin/bookings/[id]/additional-payment/withdraw",
      "POST /api/admin/subscriptions/[id]/manual-payment",
    ],
  },
  // Handlers that call `requireRecentAuth` without being on `STEP_UP_ROUTES`
  // (which lists the destructive operations, #4619). A connection never holds
  // a fresh proof (`INV-MCP-005`); the census finds every such handler.
  {
    reason: "fresh-proof",
    routes: [
      "POST /api/admin/opening-credits/preview",
      "POST /api/admin/opening-credits/confirm",
      "POST /api/admin/opening-credits/[id]/reverse",
    ],
  },
  // The finance area also holds the club's setup screens: fees, tax, bank
  // details, accounting mappings, and the connections to Xero, Stripe,
  // Google, MiroTalk, analytics and the Alpine Central Server. Credentials,
  // OAuth hand-offs and mappings that every later invoice follows stay where
  // an officer sees the whole screen. `import-members` is the one-off import
  // that seeds the member list from Xero during setup.
  {
    reason: "club-setup",
    routes: [
      "GET /api/admin/alpine-server/version",
      "POST /api/admin/alpine-server/lodge-links",
      "PUT /api/admin/alpine-server/lodge-links",
      "POST /api/admin/alpine-server/other-lodges/download",
      "POST /api/admin/alpine-server/other-lodges/upload",
      "GET /api/admin/club-tax",
      "PUT /api/admin/club-tax",
      "DELETE /api/admin/club-tax",
      "GET /api/admin/fee-configuration",
      "POST /api/admin/fee-configuration",
      "GET /api/admin/integrations/analytics",
      "PUT /api/admin/integrations/analytics",
      "POST /api/admin/integrations/analytics/reconsent",
      "GET /api/admin/integrations/credentials",
      "GET /api/admin/integrations/google/status",
      "POST /api/admin/integrations/google/verify/start",
      "GET /api/admin/integrations/mirotalk",
      "GET /api/admin/integrations/stripe/status",
      "GET /api/admin/integrations/wizard-progress",
      "POST /api/admin/integrations/wizard-progress",
      "GET /api/admin/internet-banking-settings",
      "PUT /api/admin/internet-banking-settings",
      "GET /api/admin/setup/finance-report-mappings",
      "PUT /api/admin/setup/finance-report-mappings",
      "POST /api/admin/setup/finance-report-mappings/backfill",
      "GET /api/admin/xero/account-mappings",
      "PUT /api/admin/xero/account-mappings",
      "GET /api/admin/xero/item-code-mappings",
      "PUT /api/admin/xero/item-code-mappings",
      "GET /api/admin/xero/tax-categories",
      "PUT /api/admin/xero/tax-categories",
      "DELETE /api/admin/xero/tax-categories",
      "GET /api/admin/xero/chart-of-accounts",
      "GET /api/admin/xero/items",
      "GET /api/admin/xero/contact-groups",
      "GET /api/admin/xero/organisation",
      "GET /api/admin/xero/member-grouping",
      "POST /api/admin/xero/member-grouping",
      "GET /api/admin/xero/connect",
      "GET /api/admin/xero/callback",
      "GET /api/admin/xero/webhook-health",
      "PUT /api/admin/xero/webhook-health",
      "GET /api/admin/xero/webhook/verify-status",
      "POST /api/admin/xero/import-members",
    ],
  },
  // Answers with a redirect into the old finance dashboard, not with data.
  { reason: "website-flow", routes: ["GET /api/finance/legacy-dashboard/auth"] },
  // Also needs the dashboard's shared bearer key, which no person holds.
  { reason: "service-export", routes: ["GET /api/finance/legacy-dashboard/bookings"] },
];

/**
 * Every exact `METHOD /api/path` a permanent exclusion names. The census checks each against a real route file and method, so an
 * entry left behind by a moved or deleted route fails instead of lingering.
 */
export const MCP_EXACT_EXCLUDED_ROUTES: readonly string[] = [
  ...PERMANENT_ROUTES.flatMap((rule) => rule.routes),
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
  const adminArea = getAdminRouteRequirement(path, method)?.area;
  if (adminArea) {
    // A route in a decided area has no `not-yet` to fall back on.
    return isNotYetAdminArea(adminArea)
      ? { kind: "excluded", reason: `not-yet:${MCP_NOT_YET_TASKS[adminArea]}` }
      : { kind: "unclassified" };
  }
  return { kind: "unclassified" };
}
