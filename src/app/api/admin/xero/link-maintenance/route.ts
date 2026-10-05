import { NextResponse } from "next/server";
import { logAudit } from "@/lib/audit";
import { requireAdmin } from "@/lib/session-guards";
import {
  backfillHistoricalXeroObjectLinks,
  cleanupStaleCanonicalXeroObjectLinks,
} from "@/lib/xero-hardening";
import logger from "@/lib/logger";

export async function POST() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  try {
    const backfill = await backfillHistoricalXeroObjectLinks();
    const cleanup = await cleanupStaleCanonicalXeroObjectLinks();

    await logAudit({
      action: "XERO_LINK_LEDGER_MAINTENANCE",
      category: "xero",
      memberId: session.user.id,
      details: `Backfilled ${backfill.totals.createdLinks} canonical Xero links and deactivated ${cleanup.deactivatedLinks} stale canonical links`,
    });

    return NextResponse.json({
      ok: true,
      backfill,
      cleanup,
      message: `Backfilled ${backfill.totals.createdLinks} missing canonical Xero link${backfill.totals.createdLinks === 1 ? "" : "s"}, deactivated ${cleanup.deactivatedLinks} stale canonical link${cleanup.deactivatedLinks === 1 ? "" : "s"}, and preserved ${cleanup.preservedStripeRefundCreditNoteLinks} live per-refund note link${cleanup.preservedStripeRefundCreditNoteLinks === 1 ? "" : "s"} (#2901, #3880).`,
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to run Xero link ledger maintenance");
    return NextResponse.json(
      { error: "Failed to run Xero link ledger maintenance" },
      { status: 500 }
    );
  }
}
