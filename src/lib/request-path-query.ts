/**
 * The pre-#2733 audit-log member-filter query keys, which carried a member's
 * name and email address in the page's own address.
 *
 * The audit-log page rewrites them out of the address bar, but that runs in the
 * BROWSER and therefore only after the server has already been handed the legacy
 * address — so it cannot keep them out of anything the server does with that
 * request. One of those things is durable: `${pathname}${search}` is published to
 * server components as `REQUEST_PATH_HEADER`, and `app/(admin)/layout.tsx` turns
 * it into the 2FA gate's `callbackUrl` (a redirect URL, and so a `Location`
 * header and a further history entry) and into `recordAuthBounce`'s
 * `requestedPath`, which is written to an `AuthBounceRecord` row that outlives
 * the request.
 */
const LEGACY_MEMBER_LABEL_PARAMS = ["memberName", "memberEmail"] as const;

/**
 * Deletes exactly `memberName` and `memberEmail` from a request's query string
 * for the purpose of composing `REQUEST_PATH_HEADER` (#2733).
 *
 * Deliberately narrow, and deliberately not a redirect:
 *  - **Key-exact, not a general sanitizer.** Two known legacy keys, named. It
 *    makes no attempt to guess which other parameter might hold person text, and
 *    it is not a substitute for not putting person text in a URL in the first
 *    place.
 *  - **The request still serves normally.** Bouncing or rewriting the visitor
 *    would change what a bookmark does; the page's own rewrite already handles
 *    the address bar.
 *  - **The search string is returned UNCHANGED, byte for byte, unless one of the
 *    two keys is actually present.** Re-serialising every query string through
 *    `URLSearchParams` would silently re-encode values (`%20` becomes `+`, and
 *    so on) for every request on the site, and this header feeds path matching
 *    and return paths.
 *
 * No routing decision reads either key: every `REQUEST_PATH_HEADER` consumer
 * either splits the pathname off first (`isModuleGatedRequestPath`,
 * `getAdminRouteRequirement`, `isOnboardingGateExemptPath`) or passes the value
 * to `getSafeInternalReturnPath`, which cares only about its shape.
 */
export function stripLegacyMemberLabelParams(search: string): string {
  if (!search) return search;
  if (!LEGACY_MEMBER_LABEL_PARAMS.some((key) => search.includes(key))) {
    return search;
  }

  const params = new URLSearchParams(search);
  let removed = false;
  for (const key of LEGACY_MEMBER_LABEL_PARAMS) {
    if (params.has(key)) {
      params.delete(key);
      removed = true;
    }
  }
  // A bare substring hit that was not a real key (a VALUE spelling
  // "memberName", say) changes nothing.
  if (!removed) return search;

  const remaining = params.toString();
  return remaining ? `?${remaining}` : "";
}
