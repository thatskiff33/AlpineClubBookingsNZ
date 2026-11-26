/**
 * The GST-override pause (#5208), behind the "GST overrides" card on the Xero
 * page. `GET` lists the invoices whose returned GST differs from the journal's
 * GST the app sent, each line's sent and Xero cents, at `finance:view`. Clearing
 * them is `POST ./clear`, at `finance:edit`. Local state only: no Xero call.
 */
import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/session-guards";
import { listOpenXeroTaxOverrideMismatches, xeroTaxOverridePauseProblem } from "@/lib/xero-tax-override-safeguard";

export async function GET() {
  const guard = await requireAdmin({ permission: { area: "finance", level: "view" } });
  if (!guard.ok) return guard.response;

  const invoices = await listOpenXeroTaxOverrideMismatches();
  return NextResponse.json({ invoices, problem: xeroTaxOverridePauseProblem(invoices.length) });
}
