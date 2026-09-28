import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { getXeroConnectedOrganisation } from "@/lib/xero-organisation";

/**
 * GET /api/admin/xero/organisation
 * Returns the connected Xero organisation's NAME (for the setup wizard's
 * right-org confirmation, #2080), its accounting financial year-end month
 * (1-12), its deep-link SHORT CODE (#2261) and its BASE CURRENCY (#3633, for
 * the wizard's base-currency warning), or null for each if Xero is not
 * connected. Cached in-process. Pass ?refresh=1 to bypass the cache.
 *
 * `readFailure` (#2394) says WHY those values are null when the read failed —
 * `disconnected` / `rate_limited` / `unavailable`, plus which Xero limit and any
 * Retry-After. Without it a null name is ambiguous ("Xero has no name for you"
 * vs "we never got to ask"), and the setup wizard hung on
 * "Confirming the organisation name…" indefinitely after one transient failure.
 * Admin-only disclosure, like the lock-date guard's `reason`. Callers that only
 * want the values (the deep-link short code, the lockout panel) ignore the
 * field.
 *
 * **Finance-admin-only** (#2314, owner decision 2 Aug 2026). Only an admin
 * holding the finance area may read this route, matching the audience of the
 * Xero deep links the short code feeds. The alternative considered — widening it
 * to any admin who can view settings — was declined: it grows the surface for no
 * current feature need, and an admin who cannot read this route still sees every
 * deep link, only unqualified (they degrade to the live generic `go.xero.com`
 * form), so nothing is hidden from anyone.
 *
 * The requirement is stated EXPLICITLY rather than left to inference, which is a
 * change of MECHANISM, not of who gets in. `requireAdmin` otherwise derives the
 * area from the served path (`/api/admin/xero` → finance) via a header
 * `src/proxy.ts` stamps, and derives NOTHING when that header is absent —
 * falling back to `hasAdminAccess`, i.e. Full Admin only. So the inferred gate
 * was never wider than this one; it was merely conditional on a header, and it
 * shut a legitimate finance viewer out whenever the header went missing. Naming
 * the requirement here makes the owner's decision independent of request
 * plumbing, stable against a future edit to the route-area map, and directly
 * testable (`xero-organisation-route-authz.test.ts`).
 *
 * The short code lives here rather than on `/api/admin/xero/status` on purpose:
 * status is a pure token-row read that every admin surface gating on Xero hits
 * (`useXeroStatus`), and it must stay free of live Xero calls. This route
 * already makes exactly the `getOrganisations` call the short code rides on,
 * behind the in-process cache (12 hours on success, one minute on failure) that
 * bounds it for every caller of this route — the setup wizard, the Xero Sync
 * page's deep links, and the subscription-lockout settings panel.
 */
export async function GET(request?: NextRequest) {
  // The same audience as `XERO_ORGANISATION_READ_PERMISSION`, written as a
  // literal because the #2975 authorisation census reads every handler's gate
  // from its source; `xero-base-currency-server.test.ts` pins that the two
  // agree (#3633).
  const guard = await requireAdmin({
    permission: { area: "finance", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const forceRefresh = request?.nextUrl.searchParams.get("refresh") === "1";
  const { name, financialYearEndMonth, shortCode, baseCurrency, readFailure } =
    await getXeroConnectedOrganisation(forceRefresh);

  return NextResponse.json({
    name,
    financialYearEndMonth,
    shortCode,
    baseCurrency,
    // Always present (null on success) so the client never has to guess whether
    // an absent key means "succeeded" or "old server".
    readFailure: readFailure ?? null,
  });
}
