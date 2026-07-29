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
   * Deliberately EXACT-MATCH (after one trailing slash is stripped), never a
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
];

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Strip ONE trailing slash from a path longer than "/" before an exemption is
 * compared. This gate runs BEFORE Next's canonicalising 308, so `/x/setup/`
 * would otherwise miss its own exemption and 404. The comparison itself stays
 * exact equality, so a near-miss like `/admin/display/setup/extra` or
 * `/admin/display/setupfoo` keeps the module flag and fails closed (same
 * reasoning as `normalisePathname` in `src/lib/csp.ts`).
 *
 * A doubled leading slash (`//admin/display/setup`) is a different case, and
 * NOT a fail-closed one: it does not start with `/admin/display`, so it matches
 * no rule here at all and this map requires nothing of it. That is harmless
 * because it also routes to nothing — Next normalises the duplicate slash
 * before a page is resolved — but it is worth stating truthfully rather than
 * claiming a gate that is not being applied.
 */
function normaliseForExemption(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
}

function isExemptFromRule(rule: FeatureRouteRule, pathname: string): boolean {
  if (!rule.exemptPaths) return false;
  return rule.exemptPaths.includes(normaliseForExemption(pathname));
}

export function getRequiredFeaturesForPath(pathname: string): FeatureFlagKey[] {
  const required = new Set<FeatureFlagKey>();

  for (const rule of FEATURE_ROUTE_RULES) {
    // An exemption only ever REMOVES this rule's own flag from the requirement
    // set; a path exempted here still picks up any other rule it matches.
    if (isExemptFromRule(rule, pathname)) continue;

    const prefixMatch = rule.prefixes?.some((prefix) =>
      matchesPrefix(pathname, prefix)
    );
    const patternMatch = rule.patterns?.some((pattern) =>
      pattern.test(pathname)
    );

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
