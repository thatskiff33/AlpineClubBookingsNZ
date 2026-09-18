import { buildXeroReportsUrl } from "@/lib/xero-links";
import { getXeroOrgShortCode } from "@/lib/xero-link-short-code";

/**
 * The link half of every "Open Xero reports" source note on the finance
 * dashboard — the P&L views (revenue, costs) and the balance-sheet views
 * (balance sheet, working capital) each spread this into their own note.
 *
 * #2314 review: the report centre is the highest-value Xero link in the
 * product and its audience is exactly the multi-organisation treasurer
 * #2314 exists for, so it resolves the short code like every other
 * server-side producer. The cached read is what made that affordable
 * (see getXeroOrgShortCode); a null one degrades to the generic link.
 *
 * One home (INV-SSOT-001): the two views used to compose this pair
 * independently, and after the #2957 split the second copy's comment pointed
 * "above" into a different file.
 */
export async function xeroReportsSourceLink(): Promise<{
  href: string;
  linkLabel: string;
}> {
  return {
    href: buildXeroReportsUrl({ shortCode: await getXeroOrgShortCode() }),
    linkLabel: "Open Xero reports",
  };
}
