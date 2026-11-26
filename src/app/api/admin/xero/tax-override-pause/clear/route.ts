/**
 * Resume the journal's GST overrides (#5208): a finance officer has checked the
 * flagged invoices in Xero. `finance:edit`, the route map's default for a write
 * under `/api/admin/xero`, stated here so a reader sees it.
 *
 * THE CONFIRMATION AND THE NOTE ARE ENFORCED HERE, not only in the card. Only
 * the ids sent, and only those still open, are cleared (`clearXeroTaxOverridePause`),
 * so an invoice flagged after the officer loaded the card keeps the pause on.
 * Nothing is re-sent; the next outbox run reads the pause afresh.
 */
import { NextResponse } from "next/server";
import { xeroTaxOverridePauseClearBodySchema } from "@/lib/admin-xero-sync-schemas";
import { parseJsonRequestBody } from "@/lib/api-json";
import { XERO_TAX_OVERRIDES_RESUMED_CONNECTION_SHAPE } from "@/lib/connection-shapes/finance-xero-sync";
import logger from "@/lib/logger";
import { connectionJson } from "@/lib/mcp-connection-request";
import { requireAdmin } from "@/lib/session-guards";
import {
  clearXeroTaxOverridePause,
  listOpenXeroTaxOverrideMismatches,
  xeroTaxOverridePauseProblem,
} from "@/lib/xero-tax-override-safeguard";

export async function POST(request: Request) {
  const guard = await requireAdmin({ permission: { area: "finance", level: "edit" } });
  if (!guard.ok) return guard.response;

  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;
  const parsed = xeroTaxOverridePauseClearBodySchema.safeParse(json.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Tick that you have checked these invoices in Xero, and say what you found, before resuming." },
      { status: 400 },
    );
  }

  try {
    const { cleared } = await clearXeroTaxOverridePause(guard.session.user.id, parsed.data.ids, parsed.data.note);
    const invoices = await listOpenXeroTaxOverrideMismatches();
    return connectionJson(
      request,
      { cleared, invoices, problem: xeroTaxOverridePauseProblem(invoices.length) },
      XERO_TAX_OVERRIDES_RESUMED_CONNECTION_SHAPE,
    );
  } catch (error) {
    logger.error({ err: error }, "Could not clear the GST-override pause");
    return NextResponse.json({ error: "Could not resume the GST overrides. Try again." }, { status: 500 });
  }
}
