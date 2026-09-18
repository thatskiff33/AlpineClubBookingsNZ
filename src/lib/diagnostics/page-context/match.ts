/**
 * AI Diagnostics — MATCH A LIVE ADMIN PATHNAME TO A REGISTERED PAGE-CONTEXT ROUTE
 * (AID-7, #2378).
 *
 * The registry holds CANONICAL pathnames with `[id]`-style segments
 * (`/admin/bookings/[id]`); a browser is on a REAL one (`/admin/bookings/clx…`).
 * Something has to join the two, and #2378 is the first issue with a browser in it.
 *
 * WHY THE SERVER DOES THIS AND NOT THE CLIENT. `registry.ts` states the property this
 * module has to preserve: "The client picks the ID; the SERVER picks the KIND — which
 * is why a member id sent on a booking route can only ever fail to find a booking,
 * never read a member." If the browser chose the `routeKey`, it would be choosing the
 * record KIND, and a member id sent with `routeKey: "member-detail"` from a page the
 * operator never opened would resolve as a member read. So the browser sends the one
 * thing it cannot lie about usefully — the address it is on — and the server derives
 * the rest.
 *
 * IT IS AN EXACT MATCH, DELIBERATELY. `getDiagnosticsPageContextRoute` refuses prefix
 * matching and fallbacks because "every one of those is a way for an unlisted page to
 * acquire a context it was never reviewed for". This module keeps that rule: same
 * non-empty segment count, literals equal byte for byte, at most one dynamic segment
 * filled, or no match at all. The ONE normalisation it performs is collapsing empty
 * segments — `/admin/bookings/` and `/admin//bookings` are the bookings list, which
 * selects the same route and the same (absent) record as the canonical spelling, so
 * no access differs; anything beyond that (case folding, percent-decoding, prefix
 * fallback) stays refused. An unmatched pathname is not an error — it is a page with
 * no registered context, which the resolver reports honestly.
 *
 * NOTHING HERE READS A DATABASE OR CHECKS A PERMISSION. It turns an address into a
 * selector; `resolveDiagnosticsPageContext` then re-validates that selector, re-reads
 * the caller's authority and re-fetches the record. This module cannot widen anyone's
 * access because nothing downstream trusts its output.
 */

import "server-only";

import {
  DIAGNOSTICS_PAGE_CONTEXT_ROUTES,
  type DiagnosticsPageContextRoute,
} from "./registry";
import { must } from "@/lib/indexed-access";

/** A dynamic segment in a canonical pathname: `[id]`, `[bookingId]`, `[...slug]`. */
const DYNAMIC_SEGMENT = /^\[.+\]$/;

export interface MatchedDiagnosticsRoute {
  route: DiagnosticsPageContextRoute;
  /**
   * The value that filled the route's dynamic segment, when it has one.
   *
   * A LIST page has none, even though it declares a record kind — the ADDRESS names
   * no record there. Owner decision D11 later added the other channel: the operator
   * chooses a row, and the route passes that id as a selector where the matched
   * route declares a kind for it. This module stays URL-only on purpose — it answers
   * "what does the address say", and the address's own id always wins over a
   * registered one precisely because this function reported it.
   */
  recordId?: string;
}

function segments(pathname: string): string[] {
  return pathname.split("/").filter((segment) => segment.length > 0);
}

/**
 * Match one live pathname against the registry.
 *
 * A pathname carrying a query string or a fragment is REFUSED rather than trimmed.
 * Trimming would be friendlier and wrong: `?tab=payments` is view state that belongs
 * in the selector's own allowlisted `tab` field, where the registry checks it against
 * that route's declared tabs. Silently discarding it here would let a client believe it
 * had sent view state that never arrived, and would put this module in the business of
 * parsing addresses — which is where an unlisted page starts acquiring a context.
 */
export function matchDiagnosticsPageRoute(
  pathname: string,
): MatchedDiagnosticsRoute | null {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) return null;
  if (pathname.includes("?") || pathname.includes("#")) return null;

  const live = segments(pathname);

  for (const route of DIAGNOSTICS_PAGE_CONTEXT_ROUTES) {
    const canonical = segments(route.pathname);
    if (canonical.length !== live.length) continue;

    let recordId: string | undefined;
    let matched = true;
    for (let index = 0; index < canonical.length; index += 1) {
      // `canonical.length === live.length` was checked above, so `index` is
      // within both arrays.
      const expected = must(canonical[index], `matchDiagnosticsPageContext: no canonical segment at index ${index}`);
      const actual = must(live[index], `matchDiagnosticsPageContext: no live segment at index ${index}`);
      if (DYNAMIC_SEGMENT.test(expected)) {
        // A dynamic segment is the record id. Only ONE is expected; a route with two
        // would make "which one is the record" a guess, so the second refuses the
        // whole match rather than silently overwriting the first.
        if (recordId !== undefined) {
          matched = false;
          break;
        }
        // No empty-id guard is needed here, and one used to sit here claiming to be:
        // `segments()` filters zero-length segments, so `actual` can never be `""` —
        // a pathname missing its id has FEWER segments and fails the count check
        // above. The "empty dynamic segment never resolves to a record" property is
        // enforced by that count, and pinned by the match test from the other side.
        recordId = actual;
        continue;
      }
      if (expected !== actual) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;

    // A route that takes NO record kind must not report a record id — a static page
    // cannot be about a record, so an id there would seed the consent ledger with
    // something the address never named.
    //
    // THE CONVERSE IS NOT TRUE, and assuming it was is how the first cut of this file
    // failed its own census. A LIST route declares a `recordKind` and has no dynamic
    // segment: `/admin/bookings` is `recordKind: "booking"` because a booking may be
    // SELECTED there, not because the address names one. Requiring an id for every
    // record-kinded route made every list page unmatchable, which would have surfaced
    // to an operator as diagnostics silently knowing nothing about the screen they
    // were on.
    if (route.recordKind === null && recordId !== undefined) continue;

    return recordId === undefined ? { route } : { route, recordId };
  }

  return null;
}
