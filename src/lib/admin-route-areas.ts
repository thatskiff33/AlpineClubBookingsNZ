import type { AdminPermissionArea } from "./admin-permissions";
import { ADMIN_PAGE_ROUTE_AREAS } from "./admin-hubs/security-map";

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
export const ROUTE_AREA_PREFIXES: Array<{
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
      // The club's GST / tax treatment (#4632): the card on the Xero page.
      // finance:view reads; changing it is Full Admin, enforced in the route.
      "/api/admin/club-tax",
      "/api/admin/payments",
      "/api/admin/internet-banking-settings",
      "/api/admin/refund-requests",
      "/api/admin/reports",
      "/api/admin/subscriptions",
      "/api/admin/subscription-billing",
      "/api/admin/fee-configuration",
      "/api/admin/credit-approvals",
      "/api/admin/opening-credits",
      "/api/admin/setup/finance-report-mappings",
      "/api/finance",
    ],
  },
  {
    area: "bookings",
    prefixes: [
      "/api/admin/bookings",
      "/api/admin/booking-requests",
      // A school's own record (#5245): reached from its booking requests and
      // bookings, and corrected under the same bookings:edit gate as a request.
      "/api/admin/organisations",
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
      // server; only the club's own entry is editable (triyder/AlpineClubBookingsNZ#52). Distinct prefix from
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
      // Food orders settings (fork triyder/AlpineClubBookingsNZ#121), Lodge Operations like maintenance.
      "/api/admin/food-orders",
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
      "/api/admin/privacy-hosting",
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
      // AI app connections (ALP-653): support view = the settings and every
      // connection; support edit = change the settings, disconnect an app.
      "/api/admin/mcp",
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
