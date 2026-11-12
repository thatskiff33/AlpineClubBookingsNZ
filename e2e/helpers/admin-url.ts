// Where an admin page lives, asked of the hub registry (epic #4468, C17 #4814).
//
// A page has two addresses while the hubs move: its old path and its hub path,
// and `ADMIN_HUBS_LIVE` decides which one the app links and serves. A spec that
// writes `/\/admin\/payments/` by hand is right in only one state. Specs ask
// `adminHref` (the URL the app links, `INV-SSOT-002`) and turn it into an exact
// URL expectation with `adminUrlPattern`, so one assertion holds before and
// after the flip. `admin-url-census.test.ts` refuses a literal admin path in a
// `toHaveURL` or `waitForURL`.
import { escapeRegExp } from "@/lib/escape-regexp";

export { adminHref, adminTabHref } from "@/lib/admin-hubs";

export interface AdminUrlPatternOptions {
  /** One more path segment under `href`: a detail page under its list page. */
  readonly child?: boolean;
  /** A query parameter the URL must carry, with any value. */
  readonly requiredParam?: string;
}

/**
 * An anchored expectation for the URL a page is open at: any origin, exactly
 * `href`'s path (and its query, when it has one), then optionally more query
 * and a fragment. `/admin/payments` matches `/admin/payments?status=failed`
 * but not `/admin/payments-report` or `/admin/finance/payments`.
 */
export function adminUrlPattern(
  href: string,
  { child = false, requiredParam }: AdminUrlPatternOptions = {},
): RegExp {
  const [path = "", query] = href.split("?", 2);
  if (!path.startsWith("/admin")) {
    throw new Error(`adminUrlPattern: ${href} is not an admin href`);
  }
  if (query !== undefined && requiredParam !== undefined) {
    throw new Error("adminUrlPattern: requiredParam needs an href without a query");
  }
  const segment = child ? "/[^/?#]+" : "";
  let rest: string;
  if (query !== undefined) {
    rest = `\\?${escapeRegExp(query)}(?:[&#].*)?`;
  } else if (requiredParam !== undefined) {
    rest = `\\?(?:[^#]*&)?${escapeRegExp(requiredParam)}=.*`;
  } else {
    rest = "(?:[?#].*)?";
  }
  return new RegExp(`^[a-z][a-z0-9+.-]*://[^/?#]+${escapeRegExp(path)}${segment}${rest}$`);
}
