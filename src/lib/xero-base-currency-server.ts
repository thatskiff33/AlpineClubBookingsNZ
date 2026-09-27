import "server-only";

/**
 * The connected Xero organisation's base currency, for a server surface that
 * shows the base-currency warning (#3633): the Club Currency & Locale page and
 * the setup-readiness list. The Xero setup wizard reads the same value through
 * `GET /api/admin/xero/organisation` instead, because it is a client component.
 *
 * THE VIEWER DECIDES WHETHER XERO IS ASKED AT ALL. The organisation summary is
 * finance-only (`XERO_ORGANISATION_READ_PERMISSION`, #2314), while the currency
 * page is open to every admin and the setup list to `support:view`. Handing the
 * base currency to anyone who can open those pages would widen who can read
 * the summary, which the decision on #3633 rules out. So a viewer outside that
 * audience gets `null`, which the comparison treats as "unknown": no warning,
 * exactly as for an unreadable Xero.
 *
 * NO NEW XERO CALL. The value is a field of the cached summary
 * (`getXeroConnectedOrganisation`: one `getOrganisations` call per process per
 * 12 hours on success, per minute on failure), and this module asks for it
 * only when the Xero module is on and a readable token is stored, so a club
 * without Xero never reaches the summary at all. Never throws: the summary
 * read degrades to nulls on its own, and the two gates here fail closed to
 * `null`.
 */

import {
  hasAdminAreaAccess,
  XERO_ORGANISATION_READ_PERMISSION,
  type AdminPermissionInput,
} from "@/lib/admin-permissions";
import logger from "@/lib/logger";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { getXeroConnectedOrganisation } from "@/lib/xero-organisation";
import { getXeroConnectionStatus } from "@/lib/xero-token-store";

/**
 * The connected organisation's base currency, or `null` when this viewer may
 * not read the organisation summary, when the Xero module is off, when Xero is
 * not connected, or when the base currency cannot be read.
 */
export async function readXeroBaseCurrencyForViewer(
  viewer: AdminPermissionInput | null | undefined,
): Promise<string | null> {
  if (!viewer || !hasAdminAreaAccess(viewer, XERO_ORGANISATION_READ_PERMISSION)) {
    return null;
  }
  try {
    const modules = await loadEffectiveModuleFlags();
    if (!modules.xeroIntegration) return null;
    const status = await getXeroConnectionStatus();
    if (!status.connected) return null;
  } catch (error) {
    // A failed token read is "not known to be connected": say nothing.
    logger.warn(
      { err: error },
      "Could not check the Xero connection for the base-currency warning",
    );
    return null;
  }
  return (await getXeroConnectedOrganisation()).baseCurrency;
}
