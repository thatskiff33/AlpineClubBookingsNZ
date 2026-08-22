import type { FeatureFlags, FeatureFlagKey } from "./schema";

interface FeatureRouteRule {
  flag: FeatureFlagKey;
  prefixes?: string[];
  patterns?: RegExp[];
  /**
   * Paths that sit UNDER one of this rule's prefixes but must stay reachable
   * while the module is off (#2249).
   *
   * There is exactly one legitimate shape for this: a guided setup surface whose
   * whole job is to TURN THE MODULE ON. Gating it behind its own flag makes it
   * unreachable in the only state it exists to fix, so the operator is sent back
   * to Feature modules — the detour the wizard exists to remove.
   *
   * Deliberately EXACT-MATCH (against `normaliseForRules()`), never a
   * prefix: an exemption that matched by prefix would silently un-gate every
   * future page below it. The exempted page must therefore be safe with the
   * module off, which means it may render only guidance and controls whose own
   * routes stay gated — every `/api/admin/display/*` call still 404s, and the
   * page's admin permission area still applies through the admin layout.
   */
  exemptPaths?: string[];
}

// test seam
export const FEATURE_ROUTE_RULES: FeatureRouteRule[] = [
  {
    flag: "kiosk",
    prefixes: ["/admin/lodge", "/api/admin/lodge", "/lodge", "/api/lodge"],
  },
  {
    flag: "chores",
    prefixes: [
      "/admin/chores",
      "/admin/roster",
      "/api/admin/chores",
      "/api/admin/roster",
      "/api/chores",
      "/lodge/roster",
      "/api/lodge/roster",
    ],
  },
  {
    flag: "financeDashboard",
    prefixes: [
      "/finance",
      "/api/finance",
      "/api/admin/setup/finance-report-mappings",
    ],
  },
  {
    flag: "waitlist",
    prefixes: ["/admin/waitlist", "/api/admin/waitlist"],
    patterns: [
      /^\/api\/bookings\/[^/]+\/waitlist-confirm$/,
      /^\/api\/admin\/bookings\/[^/]+\/force-confirm$/,
      // #2649: the stranded-confirm repair puts a booking back ON the waitlist,
      // so it is as waitlist-gated as force-confirm is.
      /^\/api\/admin\/bookings\/[^/]+\/return-to-waitlist$/,
    ],
  },
  {
    // NB: /admin/integrations (the Integrations hub) is deliberately NOT gated
    // here. The hub aggregates cards for Xero, Stripe, Google sign-in and
    // Backups; AdminHubPage feature- and permission-filters each card
    // individually, and every destination keeps its own gate. Gating the hub on
    // xeroIntegration used to 404 the whole hub — and any page that back-links
    // to it — whenever Xero was off, hiding every other integration (#2216).
    flag: "xeroIntegration",
    prefixes: [
      "/admin/xero",
      "/admin/internet-banking",
      "/api/admin/xero",
      "/api/admin/internet-banking-settings",
      "/api/cron/xero",
      "/api/webhooks/xero",
    ],
    patterns: [
      /^\/api\/admin\/members\/[^/]+\/xero-(link|push|unlink)$/,
    ],
  },
  {
    flag: "bedAllocation",
    prefixes: [
      "/admin/bed-allocation",
      "/admin/rooms-beds",
      "/api/admin/bed-allocation",
    ],
  },
  {
    flag: "internetBankingPayments",
    prefixes: [
      "/admin/internet-banking",
      "/api/admin/internet-banking-settings",
    ],
  },
  {
    flag: "addressAutocomplete",
    prefixes: ["/api/address-autocomplete"],
  },
  {
    flag: "groupBookings",
    prefixes: ["/api/group-bookings"],
  },
  {
    flag: "lockers",
    prefixes: ["/admin/lockers", "/api/admin/lockers"],
  },
  {
    flag: "induction",
    prefixes: [
      "/admin/induction",
      "/induction",
      "/api/admin/inductions",
      "/api/admin/induction-templates",
      "/api/inductions",
    ],
  },
  {
    flag: "workParties",
    prefixes: [
      "/admin/work-parties",
      "/api/admin/work-parties",
      "/api/work-parties",
    ],
  },
  {
    flag: "promoCodes",
    prefixes: [
      "/admin/promo-codes",
      "/api/admin/promo-codes",
      "/api/promo-codes",
    ],
  },
  {
    flag: "hutLeaders",
    prefixes: ["/admin/hut-leaders", "/api/admin/hut-leaders"],
  },
  {
    flag: "communications",
    prefixes: ["/admin/communications", "/api/admin/communications"],
  },
  {
    flag: "memberNotices",
    prefixes: [
      "/notices",
      "/api/notices",
      "/admin/notices",
      "/api/admin/notices",
    ],
  },
  {
    // Events calendar (#2241). The whole surface goes when the module is off:
    // the member page, the admin page, and the shared API all 404.
    //
    // There is deliberately NO "/api/admin/calendar" prefix — the admin page
    // reads and writes through the same /api/calendar/events routes as the
    // member page, so no admin-only calendar API exists, and
    // admin-route-map-drift.test.ts fails a prefix that matches no real file.
    //
    // "/api/calendar" only gates once the proxy actually RUNS on those paths:
    // the matcher's first entry excludes every "/api/..." request, so
    // src/proxy.ts carries an explicit "/api/calendar/:path*" matcher entry
    // alongside this rule. Without it the rule would be dead for the API.
    flag: "eventsCalendar",
    prefixes: ["/calendar", "/api/calendar", "/admin/calendar"],
  },
  {
    flag: "skifieldConditions",
    prefixes: [
      "/admin/mountain-conditions",
      "/api/admin/mountain-conditions",
      "/api/skifield-whakapapa",
      "/api/skifield-conditions",
    ],
  },
  {
    // Deliberately OUTSIDE /lodge and /api/lodge: those prefixes are gated by
    // the kiosk flag, and the display module must work without the kiosk
    // (ADR-001 §1, docs/lobby-display/decisions/).
    flag: "lobbyDisplay",
    prefixes: ["/display", "/api/display", "/admin/display", "/api/admin/display"],
    // The guided setup wizard (#2249) opens with "turn the Lobby TV display
    // module on", so it has to be reachable while the module is OFF — otherwise
    // its first step is the one state it can never be seen in. It renders only
    // guidance plus controls that call routes which remain gated (the display
    // API still 404s until the module is on), and the admin layout still applies
    // its `lodge` area gate.
    exemptPaths: ["/admin/display/setup"],
  },
  {
    // AI assistant admin surfaces (usage panel + spend-cap settings) hard-gate
    // on the module flag. Deliberately NOT /api/help/chat: that route degrades
    // to a structured { status: "fallback", reason: "module_off" } response when
    // the module is off (so a curated help panel still renders), rather than the
    // 404 this feature-route gate produces.
    flag: "aiAssistant",
    prefixes: ["/admin/ai-assistant", "/api/admin/ai-assistant"],
  },
  {
    // AI Diagnostics (AID-2, #2371) — a SEPARATE admin-only paid product from the
    // page-help aiAssistant above. Its budget + readiness admin API hard-gates on
    // the module flag, exactly like /api/admin/ai-assistant/*: a module-off
    // deployment 404s them rather than exposing a spend surface for a product it
    // has not opted into.
    //
    // The whole "module-off configuration reachability" decision (AID-2) is
    // DELIBERATE and has three parts:
    //  * the DEDICATED Anthropic credential is written/read on the shared
    //    /api/admin/integrations/credentials route (provider
    //    "anthropic-diagnostics"), which is ungated — so the highest-privilege
    //    secret can be entered before the module is turned on;
    //  * the READINESS endpoint is EXEMPT (exact-match, same mechanism as the
    //    lobbyDisplay setup wizard), so an admin can see what is missing —
    //    "module off", "no dedicated key", "no budget" — and set it up before
    //    enabling the paid product. It renders only status; it spends nothing;
    //  * the operational SETTINGS route (the monthly budget) stays GATED, exactly
    //    like /api/admin/ai-assistant/settings: a spend budget is meaningful only
    //    once the club has opted into the product by enabling the module, and
    //    enabling it alone authorises no spend (fail-closed readiness gates every
    //    paid call).
    // The PAGE prefix is listed as of AID-7 (#2378), which added
    // /admin/ai-diagnostics. It was deliberately absent until then, because a
    // prefix matching no file fails admin-route-map-drift.test.ts. (The comment
    // here previously said "AID-8"; the UI is AID-7 / #2378.)
    //
    // The page is gated by the module like the settings route, and unlike the
    // readiness endpoint: with diagnostics switched off there is no workspace to
    // open, while readiness must stay reachable so an admin can see WHY and set it
    // up. Turning the module off therefore 404s the page rather than rendering a
    // shell that can do nothing.
    flag: "aiDiagnostics",
    prefixes: ["/admin/ai-diagnostics", "/api/admin/ai-diagnostics"],
    exemptPaths: ["/api/admin/ai-diagnostics/readiness"],
  },
  {
    // Maintenance reports (#2780). Switching the module off removes ALL FOUR
    // surfaces together — the admin queue and its APIs, the member form, and the
    // unauthenticated QR page and its submit route — which is what a module
    // toggle is supposed to mean. The QR half additionally needs
    // MaintenanceReportSettings.anonymousReportsEnabled, so the module being on
    // is necessary and not sufficient for the public door.
    //
    // "/maintenance-report" (singular) is the member page and also prefixes
    // nothing else; "/lodge-maintenance" is the tokenised public page and
    // "/api/lodge-maintenance" its only API. The public halves are named
    // separately from the member ones on purpose — a reader auditing the
    // unauthenticated surface should be able to find every path that serves it by
    // its own prefix rather than by inspecting a shared one.
    flag: "maintenanceReports",
    prefixes: [
      "/admin/maintenance-reports",
      "/api/admin/maintenance-reports",
      "/maintenance-report",
      "/api/maintenance-reports",
      "/lodge-maintenance",
      "/api/lodge-maintenance",
    ],
  },
  {
    // Club message board (#2994, epic #2992). The module is the only switch:
    // with it off the member board, its API and the dashboard card all go, and
    // the API re-checks the flag itself as well so the gate does not live only
    // in middleware.
    //
    // Only the member surfaces are listed here. The admin moderation screens
    // arrive in a later child and add their own prefixes to this same rule.
    flag: "commsPortal",
    prefixes: ["/message-board", "/api/club-posts"],
  },
  {
    // Alpine Central Server (ServerNZ). Admin -> Modules is the master switch,
    // and for THIS module that is load-bearing rather than tidy: the feature
    // uploads club and booking-officer contact details to a third party which
    // redistributes them to every connected club. An off switch that leaves the
    // nightly sync running is not an off switch (INV-CONFIG-001).
    //
    // The whole subtree is gated with no exemption. There is no setup surface to
    // keep reachable here: the module is turned on from Admin -> Modules, and
    // with it off there is nothing on the setup page an operator could usefully
    // do — unlike AI Diagnostics, whose readiness endpoint must stay reachable to
    // explain WHY it is not ready.
    //
    // Deliberately NOT "/admin/integrations": that is the shared hub Xero,
    // Stripe, Google and Backups also live on, and gating it would 404 the whole
    // hub for a club that simply has this off — the mistake #2216 made. The hub's
    // CARD is hidden behind the same flag instead.
    //
    // The cron endpoint is NOT under these prefixes and cannot be — it is called
    // with a secret, not a session — so `syncOtherClubsWithServer` re-checks the
    // flag itself and reports SKIPPED.
    flag: "alpineCentralServer",
    prefixes: ["/admin/alpine-server", "/api/admin/alpine-server"],
  },
  {
    // Google Analytics integration configuration (#2573). Admin -> Modules is the
    // master switch (owner decision section 1), so with the module off this whole
    // subtree 404s: the club cannot read or write the configuration, and the
    // Integrations page hides its card behind the same flag.
    //
    // Deliberately NOT "/admin/integrations": that prefix is the shared hub which
    // Xero, Stripe, Google sign-in and Backups also live on, and gating it would
    // 404 the entire hub for a club that simply has analytics off — the mistake
    // #2216 made. There is no /admin/analytics PAGE prefix either, because the
    // owner's decision replaced the proposed /admin/analytics/setup route with an
    // inline panel on the Integrations page; a prefix matching no file fails
    // admin-route-map-drift.test.ts.
    //
    // Unlike the Google sign-in credentials route, there is no
    // module-off-reachability exemption to make: nothing here has to be entered
    // before the module can be enabled (the analytics module has no enable-gate),
    // and the guided order is exactly the owner's — turn the module on, then
    // complete the setup under Admin -> Integrations.
    flag: "analytics",
    prefixes: ["/api/admin/integrations/analytics"],
  },
  {
    // "+ Add Member Guest" (epic #2305). The two member-facing surfaces stop
    // existing when a club has the module off: the delegate's answer page, and
    // the consent endpoint both the target and the delegate answer through.
    // Neither has anything to do on a club that does not run member guests.
    //
    // The consent endpoint also refuses on its own — every failure there is the
    // same 403, module-off included, so no id can be used as an existence
    // oracle — and this gate sits in front of that rather than replacing it. A
    // 404 here reveals only that the club does not run the module, which is
    // club-wide configuration, not anything about a particular booking.
    //
    // DELIBERATELY NOT LISTED: /api/admin/member-guest-settings, the admin
    // route behind the Member guests card on Admin › Bookings setup. Owner
    // decision MG2-M-4 is that an admin sets the policy up FIRST and turns the
    // module on afterwards, so gating that route would 404 the card in exactly
    // the state it exists for — the same mistake #2216 made with the
    // Integrations hub. It stays reachable behind its `bookings` admin
    // permission area, and nothing it saves does anything while the module is
    // off: every surface that acts on those values is gated here or refuses in
    // the route itself.
    flag: "memberGuests",
    prefixes: ["/bookings/consent"],
    patterns: [/^\/api\/bookings\/[^/]+\/guests\/[^/]+\/consent$/],
  },
];

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function stripOneTrailingSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
}

/**
 * Spellings Next's own matcher admits for every `config.matcher` entry (it
 * appends the data-request alternatives itself), so a request can reach the
 * proxy wearing one of them. The `$`-anchored patterns above would miss them.
 */
const NEXT_DATA_SUFFIXES = [".rsc", ".json"];

/**
 * Canonicalises a pathname before it is compared against the rules above:
 * strips ONE trailing slash from a path longer than "/", then ONE Next data
 * suffix.
 *
 * Why both: this gate runs BEFORE Next's canonicalising 308, so
 * `/api/bookings/x/guests/y/consent/` would otherwise reach the route with its
 * `$`-anchored rule inert (same reasoning as `normalisePathname` in
 * `src/lib/csp.ts`), and the matcher admits the `.rsc`/`.json` spellings of
 * every entry, which those patterns would likewise miss (#2435 review).
 *
 * This normalises the INPUT only; every comparison below stays exact equality
 * or a `/`-anchored prefix, so nothing new is admitted. A near-miss such as
 * `/admin/display/setup/extra`, `/admin/display/setupfoo` or a doubled trailing
 * slash still keeps the module flag and fails closed. No route in the app ends
 * in `.rsc`/`.json` either, so stripping the suffix cannot un-gate a real
 * address; it can only bring a data request back under the rule its page is
 * already under.
 *
 * Exemptions are compared against the SAME canonical form on purpose: the
 * wizard that exists to turn a module on must stay reachable with the module
 * off in every spelling that reaches it, not just the bare one.
 *
 * A doubled leading slash (`//admin/display/setup`) is a different case, and
 * NOT a fail-closed one: it does not start with `/admin/display`, so it matches
 * no rule here at all and this map requires nothing of it. That is harmless
 * because it also routes to nothing — Next normalises the duplicate slash
 * before a page is resolved — but it is worth stating truthfully rather than
 * claiming a gate that is not being applied.
 */
function normaliseForRules(pathname: string): string {
  const trimmed = stripOneTrailingSlash(pathname);
  const suffix = NEXT_DATA_SUFFIXES.find(
    (candidate) =>
      trimmed.length > candidate.length && trimmed.endsWith(candidate)
  );

  return suffix
    ? stripOneTrailingSlash(trimmed.slice(0, -suffix.length))
    : trimmed;
}

/** `pathname` must already be `normaliseForRules()`d. */
function isExemptFromRule(rule: FeatureRouteRule, pathname: string): boolean {
  if (!rule.exemptPaths) return false;
  return rule.exemptPaths.includes(pathname);
}

export function getRequiredFeaturesForPath(pathname: string): FeatureFlagKey[] {
  const required = new Set<FeatureFlagKey>();
  const path = normaliseForRules(pathname);

  for (const rule of FEATURE_ROUTE_RULES) {
    // An exemption only ever REMOVES this rule's own flag from the requirement
    // set; a path exempted here still picks up any other rule it matches.
    if (isExemptFromRule(rule, path)) continue;

    const prefixMatch = rule.prefixes?.some((prefix) =>
      matchesPrefix(path, prefix)
    );
    const patternMatch = rule.patterns?.some((pattern) => pattern.test(path));

    if (prefixMatch || patternMatch) {
      required.add(rule.flag);
    }
  }

  return [...required];
}

export function getDisabledFeatureForPath(
  pathname: string,
  flags: FeatureFlags
): FeatureFlagKey | null {
  return getRequiredFeaturesForPath(pathname).find((flag) => !flags[flag]) ?? null;
}

export function isFeatureHrefVisible(
  href: string,
  flags: FeatureFlags
): boolean {
  const pathname = href.startsWith("http")
    ? new URL(href).pathname
    : href.split(/[?#]/)[0] || "/";

  return getDisabledFeatureForPath(pathname, flags) === null;
}
