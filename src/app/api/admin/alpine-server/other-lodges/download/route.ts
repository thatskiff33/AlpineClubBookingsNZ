import "server-only";

import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/session-guards";
import { createAuditLog } from "@/lib/audit";
import { loadServerNzSettings } from "@/lib/servernz-settings";
import { downloadOtherClubsFromServer } from "@/lib/servernz-other-lodges-sync";
import { respondSyncRunning, respondToSyncError } from "@/lib/servernz-sync-response";
import { withOtherLodgesSyncClaim } from "@/lib/servernz-sync-claim";

// POST /api/admin/alpine-server/other-lodges/download — pull the distributed
// Other Clubs set from the central server and merge it into the local registry.
export async function POST() {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const settings = await loadServerNzSettings();
  if (!settings.otherLodgesEnabled) {
    return NextResponse.json(
      { error: "Other Clubs sync is disabled. Enable it first." },
      { status: 409 },
    );
  }

  try {
    // Single-flight with the nightly pass and any other press (#66): a held
    // claim is refused with nothing sent, rather than run alongside it.
    const result = await withOtherLodgesSyncClaim(() => downloadOtherClubsFromServer());
    if (result === null) return respondSyncRunning();
    await createAuditLog({
      action: "alpine_server.other_lodges.download",
      category: "lodge",
      severity: "info",
      outcome: "success",
      memberId: guard.session.user.id,
      summary: "Downloaded Other Clubs from Alpine Central Server",
      details: `fetched ${result.fetched}, added ${result.created}, updated ${result.updated}`,
    });
    return NextResponse.json(result);
  } catch (error) {
    return respondToSyncError(error, guard.session.user.id, "download");
  }
}
