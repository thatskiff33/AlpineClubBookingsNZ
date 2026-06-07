import type { FeatureFlags } from "./schema";
import type { FeatureFlagKey } from "./features";

interface FeatureRouteRule {
  flag: FeatureFlagKey;
  prefixes?: string[];
  patterns?: RegExp[];
}

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
    prefixes: ["/finance", "/api/finance"],
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
    flag: "xeroIntegration",
    prefixes: [
      "/admin/xero",
      "/api/admin/xero",
      "/api/cron/xero",
      "/api/finance/xero",
      "/api/webhooks/xero",
    ],
    patterns: [
      /^\/api\/admin\/members\/[^/]+\/xero-(link|push|unlink)$/,
    ],
  },
  {
    flag: "bedAllocation",
    prefixes: ["/admin/bed-allocation", "/api/admin/bed-allocation"],
  },
];

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function getRequiredFeaturesForPath(pathname: string): FeatureFlagKey[] {
  const required = new Set<FeatureFlagKey>();

  for (const rule of FEATURE_ROUTE_RULES) {
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
    : href.split("?")[0] || "/";

  return getDisabledFeatureForPath(pathname, flags) === null;
}
