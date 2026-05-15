import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { requireActiveSessionUser } from "@/lib/session-guards";
import {
  backfillHistoricalXeroObjectLinks,
  cleanupStaleCanonicalXeroObjectLinks,
} from "@/lib/xero-hardening";
import logger from "@/lib/logger";

export async function POST() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  try {
    const backfill = await backfillHistoricalXeroObjectLinks();
    const cleanup = await cleanupStaleCanonicalXeroObjectLinks();

    await logAudit({
      action: "XERO_LINK_LEDGER_MAINTENANCE",
      memberId: session.user.id,
      details: `Backfilled ${backfill.totals.createdLinks} canonical Xero links and deactivated ${cleanup.deactivatedLinks} stale canonical links`,
    });

    return NextResponse.json({
      ok: true,
      backfill,
      cleanup,
      message: `Backfilled ${backfill.totals.createdLinks} missing canonical Xero link${backfill.totals.createdLinks === 1 ? "" : "s"} and deactivated ${cleanup.deactivatedLinks} stale canonical link${cleanup.deactivatedLinks === 1 ? "" : "s"}.`,
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to run Xero link ledger maintenance");
    return NextResponse.json(
      { error: "Failed to run Xero link ledger maintenance" },
      { status: 500 }
    );
  }
}
