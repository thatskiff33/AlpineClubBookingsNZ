import { NextResponse } from "next/server";
import { logAudit } from "@/lib/audit";
import { XERO_LINK_MAINTENANCE_CONNECTION_SHAPE } from "@/lib/connection-shapes/finance-xero-sync";
import { connectionJson } from "@/lib/mcp-connection-request";
import { requireAdmin } from "@/lib/session-guards";
import {
  backfillHistoricalXeroObjectLinks,
  cleanupStaleCanonicalXeroObjectLinks,
} from "@/lib/xero-hardening";
import logger from "@/lib/logger";

export async function POST(request: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  // Audited in every case, once: a completed run (a partial heal failure
  // included, which the cleanup returns rather than throws) and one that
  // stopped on an error, whose earlier steps stay done (#4161).
  let auditDetails = "Xero link ledger maintenance failed before it finished; see the server log";
  try {
    const backfill = await backfillHistoricalXeroObjectLinks();
    const cleanup = await cleanupStaleCanonicalXeroObjectLinks();
    const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
    const failed = cleanup.failedRefundNoteHealLinkIds.length;
    const deferred = cleanup.deferredRefundNoteHealLinkIds.length;
    // `deactivatedLinks` already includes the healed mirrors, so they are named as part of it.
    const cleanupSummary = `deactivated ${plural(cleanup.deactivatedLinks, "stale canonical link")} (including ${plural(cleanup.healedCancelledRefundCreditNoteMirrors, "mirror")} of VOIDED/DELETED Xero refund notes), released ${plural(cleanup.releasedInactiveRefundNotePointers, "refund-note pointer")} left on an inactive voided note${deferred > 0 ? `, deferred ${plural(deferred, "heal")} behind a refund note still being created` : ""}`;
    const warning =
      failed > 0
        ? `${plural(failed, "refund-note heal")} failed (${cleanup.failedRefundNoteHealLinkIds.join(", ")}); the next nightly link cleanup retries ${failed === 1 ? "it" : "them"}.`
        : undefined;
    auditDetails = `Backfilled ${backfill.totals.createdLinks} canonical Xero links, ${cleanupSummary}${warning ? `; ${warning}` : ""}`;

    // A completed run answers 200 so the panel can show what it did; a partial
    // heal failure comes back as `warning`, which the panel styles as one.
    return connectionJson(request, {
      ok: failed === 0,
      backfill,
      cleanup,
      message: `Backfilled ${plural(backfill.totals.createdLinks, "missing canonical Xero link")}, ${cleanupSummary}, and preserved ${plural(cleanup.preservedStripeRefundCreditNoteLinks, "live per-refund note link")} (#2901, #3880, #4161).`,
      ...(warning ? { warning } : {}),
    }, XERO_LINK_MAINTENANCE_CONNECTION_SHAPE);
  } catch (error) {
    logger.error({ err: error, adminMemberId: session.user.id }, "Failed to run Xero link ledger maintenance");
    return NextResponse.json(
      { error: "Failed to run Xero link ledger maintenance" },
      { status: 500 }
    );
  } finally {
    logAudit({
      action: "XERO_LINK_LEDGER_MAINTENANCE",
      category: "xero",
      memberId: session.user.id,
      details: auditDetails,
    });
  }
}
