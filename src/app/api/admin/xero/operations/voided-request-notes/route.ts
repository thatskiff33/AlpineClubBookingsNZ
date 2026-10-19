import { NextResponse } from "next/server";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";
import { buildLocalAdminUrl } from "@/lib/xero-record-links";
import { listVoidedRefundRequestNotes } from "@/lib/xero-refund-request-note-reraise";

/**
 * #4214: the refund requests whose own Xero credit note Xero voided, with no
 * live note replacing it - the list Xero Operations offers "Raise a fresh
 * credit note" on. Read-only, so a view-only finance admin sees it too.
 */
export async function GET() {
  const guard = await requireAdmin({ permission: { area: "finance", level: "view" } });
  if (!guard.ok) return guard.response;
  try {
    const requests = await listVoidedRefundRequestNotes();
    return NextResponse.json({
      data: requests.map((request) => ({ ...request, paymentUrl: buildLocalAdminUrl("Payment", request.paymentId) })),
    });
  } catch (err) {
    logger.error({ err }, "Failed to load voided refund request notes");
    return NextResponse.json({ error: "Failed to load voided refund request notes" }, { status: 500 });
  }
}
