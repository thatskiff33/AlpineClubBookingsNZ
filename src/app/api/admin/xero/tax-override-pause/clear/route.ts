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
import { z } from "zod";

import { parseJsonRequestBody } from "@/lib/api-json";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";
import {
  clearXeroTaxOverridePause,
  listOpenXeroTaxOverrideMismatches,
  xeroTaxOverridePauseProblem,
} from "@/lib/xero-tax-override-safeguard";

const clearSchema = z
  .object({
    ids: z.array(z.string().min(1).max(64)).min(1).max(500),
    note: z.string().trim().min(1).max(1000),
    confirmed: z.literal(true),
  })
  .strict();

export async function POST(request: Request) {
  const guard = await requireAdmin({ permission: { area: "finance", level: "edit" } });
  if (!guard.ok) return guard.response;

  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;
  const parsed = clearSchema.safeParse(json.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Tick that you have checked these invoices in Xero, and say what you found, before resuming." },
      { status: 400 },
    );
  }

  try {
    const { cleared } = await clearXeroTaxOverridePause(guard.session.user.id, parsed.data.ids, parsed.data.note);
    const invoices = await listOpenXeroTaxOverrideMismatches();
    return NextResponse.json({ cleared, invoices, problem: xeroTaxOverridePauseProblem(invoices.length) });
  } catch (error) {
    logger.error({ err: error }, "Could not clear the GST-override pause");
    return NextResponse.json({ error: "Could not resume the GST overrides. Try again." }, { status: 500 });
  }
}
